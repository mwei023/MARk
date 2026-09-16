import {
  ToolInputSchema,
  ToolParameterSchema,
} from './types';

export interface CompatibilityScore {
  score: number;
  compatible: boolean;
  reason: string;
}

/**
 * Type-level compatibility between a producer output value and a consumer
 * input field. Schema-aware, not app-aware: no knowledge of individual
 * tools, only their declared JSON-schema-like contracts.
 *
 * Scoring: exact type match = 1, either side unknown = 0.5 (possible),
 * mismatch = 0. Objects/arrays recurse only one level for the reason
 * string; deep validation happens at execution time.
 */
export function scoreCompatibility(
  producer: ToolParameterSchema | undefined,
  consumer: ToolParameterSchema | undefined,
): CompatibilityScore {
  if (!producer || !consumer) {
    return {
      score: 0,
      compatible: false,
      reason: 'Missing schema on one side; cannot assess compatibility.',
    };
  }

  const from = producer.type ?? 'unknown';
  const to = consumer.type ?? 'unknown';

  if (from === 'unknown' || to === 'unknown') {
    return {
      score: 0.5,
      compatible: true,
      reason: `Possible match: producer is ${from}, consumer expects ${to}.`,
    };
  }

  if (from === to) {
    return {
      score: 1,
      compatible: true,
      reason: `Types match (${from}).`,
    };
  }

  return {
    score: 0,
    compatible: false,
    reason: `Type mismatch: producer gives ${from}, consumer expects ${to}.`,
  };
}

/**
 * Walks an output schema along a property path (e.g. ["memory","totalBytes"]).
 * Numeric segments step into array items. Returns the terminal schema node,
 * or null when the path is not declared.
 */
export function resolveSchemaPath(
  schema: ToolInputSchema | undefined,
  path: string[],
): ToolParameterSchema | null {
  if (!schema) return null;
  let current: ToolParameterSchema | undefined = {
    type: 'object',
    properties: schema.properties,
    required: schema.required,
  };

  for (const segment of path) {
    if (!current) return null;
    if (current.type === 'array') {
      current = current.items;
      if (current === undefined) return null;
      // Numeric segment consumes the array level; non-numeric names a
      // property of the item schema.
      if (/^\d+$/.test(segment)) continue;
    }
    if (current.type !== 'object') return null;
    const next: ToolParameterSchema | undefined = current.properties?.[segment];
    if (!next) return null;
    current = next;
  }

  return current ?? null;
}
