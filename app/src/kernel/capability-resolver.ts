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
      .filter(candidate => candidate.score > 0)
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
     */
    const uniqueMatches = [...new Set(matchedTerms)];

    let score = uniqueMatches.length / Math.max(terms.length, 1);

    if (
      uniqueMatches.some(term =>
        this.normalize(tool.id).includes(term),
      )
    ) {
      score += 0.35;
    }

    if (
      uniqueMatches.some(term =>
        this.normalize(tool.name).includes(term),
      )
    ) {
      score += 0.2;
    }

    if (
      uniqueMatches.some(term =>
        this.normalize(tool.domain).includes(term),
      )
    ) {
      score += 0.1;
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
