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
export function resolveSchemaPath(  schema: ToolInputSchema | undefined,
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
      // Arrays resolve ONLY by numeric index. A bare name (`tracks.kind`)
      // is ambiguous across items and crashes at execution while passing
      // validation — that exact gap shipped a broken plan live. Authors
      // must write the index explicitly (`tracks.0.kind`).
      if (!/^\d+$/.test(segment)) return null;
      current = current.items;
      if (current === undefined) return null;
      continue;
    }
    if (current.type !== 'object') return null;
    const next: ToolParameterSchema | undefined = current.properties?.[segment];
    if (!next) return null;
    current = next;
  }

  return current ?? null;
}

export interface SchemaLeafPath {
  path: string[];
  schema: ToolParameterSchema;
}

/**
 * Enumerates every declared leaf path of an output schema, e.g.
 * ["hostname"], ["memory","totalBytes"], ["entries","name"].
 * Array items are traversed without consuming a path segment for the index;
 * callers address items by property name (validation accepts numeric
 * segments at execution depth).
 */
export function listSchemaLeafPaths(
  schema: ToolInputSchema | undefined,
): SchemaLeafPath[] {
  if (!schema?.properties) return [];
  const leaves: SchemaLeafPath[] = [];

  const visit = (node: ToolParameterSchema, path: string[]): void => {
    if (node.type === 'object' && node.properties) {
      const keys = Object.keys(node.properties);
      if (keys.length === 0) {
        leaves.push({ path, schema: node });
        return;
      }
      for (const [key, child] of Object.entries(node.properties)) {
        visit(child, [...path, key]);
      }
      return;
    }
    if (node.type === 'array' && node.items) {
      visit(node.items, path);
      return;
    }
    leaves.push({ path, schema: node });
  };

  for (const [key, child] of Object.entries(schema.properties)) {
    visit(child, [key]);
  }

  return leaves;
}
