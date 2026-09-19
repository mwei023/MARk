import { ToolDescriptor } from './types';
import { ToolRegistry } from './tool-registry';
import { reliabilityTracker } from './reliability';

export interface CapabilityResolution {
  tool?: ToolDescriptor;
  score: number;
  matchedTerms: string[];
  reason: string;
}

export interface CapabilityResolverDependencies {
  toolRegistry: ToolRegistry;
}

/**
 * Minimum score for a capability to count as resolved. Discovery made the
 * catalog large (100+ desktop apps), so weak hits must not route chat to
 * tools. Roughly: at least half the goal terms must match. Not per-situation —
 * one relevance floor for every tool equally.
 */
export const MIN_RESOLUTION_SCORE = 0.5;

/**
 * Resolves a natural-language goal against currently discovered
 * capabilities.
 *
 * This deliberately knows nothing about individual tools.
 * It operates only on ToolDescriptor metadata.
 */
export interface RankedCapability {
  tool: ToolDescriptor;
  score: number;
  matchedTerms: string[];
  /** A goal term exactly equals an id token (strong addressing signal). */
  idAnchor: boolean;
}

export class CapabilityResolver {
  constructor(
    private readonly dependencies: CapabilityResolverDependencies,
  ) {}

  resolve(goal: string): CapabilityResolution {
    const best = this.resolveAll(goal)[0];

    if (!best) {
      if (!goal.trim()) {
        return {
          score: 0,
          matchedTerms: [],
          reason: 'The requested goal is empty.',
        };
      }
      const tools = this.dependencies.toolRegistry.listAvailable();
      if (tools.length === 0) {
        return {
          score: 0,
          matchedTerms: [],
          reason: 'No available capabilities have been discovered.',
        };
      }
      return {
        score: 0,
        matchedTerms: [],
        reason: 'No discovered capability appears relevant to the goal.',
      };
    }

    return {
      tool: best.tool,
      score: best.score,
      matchedTerms: best.matchedTerms,
      reason: `Selected discovered capability "${best.tool.id}" from its declared metadata.`,
    };
  }

  /** Ranked candidates, best first. Empty for empty goals or no matches. */
  resolveAll(goal: string, opts: { gate?: boolean } = {}): RankedCapability[] {
    const normalizedGoal = this.normalize(goal);

    if (!normalizedGoal) return [];

    const terms = this.extractTerms(normalizedGoal);
    const tools = this.dependencies.toolRegistry.listAvailable();

    if (tools.length === 0) return [];

    // Document frequency over catalog token sets: discriminating terms
    // ("largest", "vlc", "jarvis") outweigh glue words ("list", "files",
    // "open") that every other tool also matches.
    const documentFrequency = new Map<string, number>();
    const tokenSets = new Map<string, Set<string>>();
    for (const tool of tools) {
      const tokens = this.tokenize([
        tool.id,
        tool.name,
        tool.description,
        tool.domain,
        tool.provider,
        ...(tool.capabilities ?? []),
        ...tool.supportedResourceKinds,
      ].join(' '));
      tokenSets.set(tool.id, tokens);
      for (const token of tokens) {
        documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
      }
    }

    return tools
      .map(tool => this.scoreTool(tool, terms, {
        tokens: tokenSets.get(tool.id)!,
        idf: (term: string) => Math.log(tools.length / (1 + (documentFrequency.get(term) ?? 0))),
      }))
      .filter(candidate =>
        candidate.score >= MIN_RESOLUTION_SCORE &&
        // The evidence gate keeps weak single matches from firing tools
        // ("help" must not open Yelp). Callers doing their own arbitration
        // (binding evidence, LLM choice) opt out via { gate: false }.
        (opts.gate === false ||
          terms.length <= 1 || candidate.matchedTerms.length >= 2 ||
          (candidate.idAnchor && candidate.score >= 1.0)),
      )
      .sort((left, right) => right.score - left.score);
  }

  private scoreTool(
    tool: ToolDescriptor,
    terms: string[],
    index: { tokens: Set<string>; idf: (term: string) => number },
  ): {
    tool: ToolDescriptor;
    score: number;
    matchedTerms: string[];
    idAnchor: boolean;
  } {
    const searchable = index.tokens;

    // Whole-word match only: "hi" must not hit "machine", "help" must not
    // hit "yelp". Tool ids carry dots/underscores ("system.machine_info",
    // "container.restart.jarvis-db"), so they are tokenized the same way.
    // Plurals and gerunds still meet ("files"~"file", "list"~"listing") via
    // wordMatch; short stems never do ("hi"~"machine" stays a miss).
    const matchedTerms = terms.filter(term =>
      [...searchable].some(word => wordMatch(term, word)),
    );

    if (matchedTerms.length === 0) {
      return {
        tool,
        score: 0,
        matchedTerms: [],
        idAnchor: false,
      };
    }

    /*
     * Score is intentionally based on discovered metadata.
     *
     * Exact capability vocabulary gets more weight than generic
     * words such as "the", "what", "can", etc.
     *
     * Coverage outranks bonuses: a tool matching every goal term beats
     * one matching half the terms, no matter the bonuses. This keeps
     * specific tools (directory sizes for "eating disk") ahead of
     * general ones (disk usage) without any per-situation tuning.
     */
    const uniqueMatches = [...new Set(matchedTerms)];

    const coverage = uniqueMatches.length / Math.max(terms.length, 1);
    let score = coverage;

    const idTokens = this.tokenize(tool.id);
    // Anchor is stem-aware ("incidents" names incident.list_open) but never
    // substring-based ("help" still does not anchor the Yelp viewer).
    const idAnchor = uniqueMatches.some(term => [...idTokens].some(word => wordMatch(term, word)));
    if (idAnchor) {
      score += 0.35 * coverage;
      // Dilution compensation: in a long goal ("search for TODO in app
      // src") one exact id-token hit is strong evidence even though
      // coverage is thin. Short goals don't need it (their coverage is
      // already decisive), so rankings like directory_sizes > disk_usage
      // for "what is eating my disk" are untouched.
      if (terms.length > 2) score += 0.3;
    }

    const nameTokens = this.tokenize(tool.name);
    if (uniqueMatches.some(term => [...nameTokens].some(word => wordMatch(term, word)))) {
      score += 0.2 * coverage;
    }

    const domainTokens = this.tokenize(tool.domain);
    if (uniqueMatches.some(term => [...domainTokens].some(word => wordMatch(term, word)))) {
      score += 0.1 * coverage;
    }

    // Rarity bonus: a matched term few tools share ("largest", "vlc")
    // outweighs glue every tool matches ("list", "open"). Exact-token
    // document frequency keeps this stable and cheap.
    for (const term of uniqueMatches) {
      score += 0.12 * index.idf(term);
    }

    // Learned tiebreak: tools that delivered before rank slightly above
    // ones that failed. Unknown tools score exactly 0.5 (neutral), so this
    // only ever breaks ties — relevance still decides.
    score += 0.05 * (reliabilityTracker.score(tool.id) - 0.5) * 2;

    return {
      tool,
      score,
      matchedTerms: uniqueMatches,
      idAnchor,
    };
  }

  private extractTerms(input: string): string[] {
    const stopWords = new Set([
      'a',
      'about',
      'am',
      'an',
      'and',
      'are',
      'can',
      'could',
      'do',
      'does',
      'for',
      'from',
      'get',
      'give',
      'how',
      'i',
      'in',
      'is',
      'it',
      'me',
      'my',
      'of',
      'on',
      'please',
      'tell',
      'that',
      'the',
      'this',
      'to',
      'what',
      'whats',
      'with',
      'you',
    ]);

    return [
      ...new Set(
        input
          .toLowerCase()
          // Split dots/dashes/underscores too: "jarvis-db" must meet the
          // "jarvis"+"db" tokens of per-container tools, not miss as one blob.
          .replace(/[^a-z0-9]+/g, ' ')
          .split(/\s+/)
          .map(term => term.trim())
          .filter(term => term.length >= 2)
          .filter(term => !stopWords.has(term)),
      ),
    ];
  }

  private normalize(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Whole-word token set for matching. Splits on anything that is not a
   * letter or digit, so "system.machine_info" and "container-restart"
   * become {system, machine, info} and {container, restart}.
   */
  private tokenize(value: string): Set<string> {
    return new Set(
      value
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .map(token => token.trim())
        .filter(token => token.length >= 2),
    );
  }
}

/**
 * Two tokens meet when they are the same word, a singular/plural pair, or
 * share a stem of at least 4 characters ("list"~"listing"). Short overlaps
 * never meet, so "hi"~"machine" and "help"~"yelp" stay misses.
 */
function wordMatch(term: string, word: string): boolean {
  if (term === word) return true;
  if (singular(term) === singular(word)) return true;
  const shared = term.length <= word.length
    ? (word.startsWith(term) ? term : '')
    : (term.startsWith(word) ? word : '');
  return shared.length >= 4;
}

function singular(value: string): string {
  if (value.endsWith('ies') && value.length > 4) return value.slice(0, -3) + 'y';
  if (value.endsWith('es') && value.length > 4) return value.slice(0, -2);
  if (value.endsWith('s') && value.length > 3) return value.slice(0, -1);
  return value;
}
