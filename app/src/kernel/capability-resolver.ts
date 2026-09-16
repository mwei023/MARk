import { ToolDescriptor } from './types';
import { ToolRegistry } from './tool-registry';

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
 * catalog large (100+ desktop apps), so bare substring hits ("help" inside
 * "yelp", a country inside a profile hash) must not route chat to tools.
 * Roughly: at least half the goal terms must match. Not per-situation —
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
  resolveAll(goal: string): RankedCapability[] {
    const normalizedGoal = this.normalize(goal);

    if (!normalizedGoal) return [];

    const terms = this.extractTerms(normalizedGoal);
    const tools = this.dependencies.toolRegistry.listAvailable();

    if (tools.length === 0) return [];

    return tools
      .map(tool => this.scoreTool(tool, terms))
      .filter(candidate => candidate.score >= MIN_RESOLUTION_SCORE)
      .sort((left, right) => right.score - left.score);
  }

  private scoreTool(
    tool: ToolDescriptor,
    terms: string[],
  ): {
    tool: ToolDescriptor;
    score: number;
    matchedTerms: string[];
  } {
    const searchable = this.normalize([
      tool.id,
      tool.name,
      tool.description,
      tool.domain,
      tool.provider,
      ...(tool.capabilities ?? []),
      ...tool.supportedResourceKinds,
    ].join(' '));

    const matchedTerms = terms.filter(term =>
      searchable.includes(term),
    );

    if (matchedTerms.length === 0) {
      return {
        tool,
        score: 0,
        matchedTerms: [],
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

    if (
      uniqueMatches.some(term =>
        this.normalize(tool.id).includes(term),
      )
    ) {
      score += 0.35 * coverage;
    }

    if (
      uniqueMatches.some(term =>
        this.normalize(tool.name).includes(term),
      )
    ) {
      score += 0.2 * coverage;
    }

    if (
      uniqueMatches.some(term =>
        this.normalize(tool.domain).includes(term),
      )
    ) {
      score += 0.1 * coverage;
    }

    return {
      tool,
      score,
      matchedTerms: uniqueMatches,
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
          .replace(/[^a-z0-9_.-]+/g, ' ')
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
}
