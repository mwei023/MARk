import {
  ToolInputSchema,
  ToolParameterSchema,
} from './types';

export interface OutputValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Minimal JSON-schema-like validator for kernel tool output contracts.
 *
 * Supports the subset MARK declares: string | number | boolean | object |
 * array | unknown, plus required, properties (recursive), items, and enum.
 * Unknown schema shape = skip (valid) so older tools without contracts
 * keep working.
 */
export function validateOutput(
  output: unknown,
  schema: ToolInputSchema | undefined,
): OutputValidationResult {
  if (!schema) return { valid: true, errors: [] };
  if (!schema || typeof schema !== 'object') return { valid: true, errors: [] };

  const errors: string[] = [];
  checkValue(output, schema as ToolParameterSchema & { required?: string[] }, 'output', errors);
  return { valid: errors.length === 0, errors };
}

function checkValue(
  value: unknown,
  schema: ToolParameterSchema,
  path: string,
  errors: string[],
): void {
  if (!schema || typeof schema !== 'object') return;
  const type = schema.type ?? 'unknown';
  if (type === 'unknown') return;

  if (type === 'string') {
    if (typeof value !== 'string') {
      errors.push(`${path} should be a string.`);
      return;
    }
    if (schema.enum && !schema.enum.includes(value)) {
      errors.push(`${path} should be one of: ${schema.enum.join(', ')}.`);
    }
    return;
  }

  if (type === 'number') {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      errors.push(`${path} should be a number.`);
    }
    return;
  }

  if (type === 'boolean') {
    if (typeof value !== 'boolean') {
      errors.push(`${path} should be a boolean.`);
    }
    return;
  }

  if (type === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`${path} should be an array.`);
      return;
    }
    if (schema.items) {
      value.forEach((item, index) => {
        checkValue(item, schema.items as ToolParameterSchema, `${path}[${index}]`, errors);
      });
    }
    return;
  }

  if (type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      errors.push(`${path} should be an object.`);
      return;
    }
    const record = value as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const name of required) {
      if (record[name] === undefined) {
        errors.push(`${path}.${name} is required but missing.`);
      }
    }
    for (const [key, prop] of Object.entries(schema.properties ?? {})) {
      if (record[key] === undefined) continue;
      checkValue(record[key], prop, `${path}.${key}`, errors);
    }
    return;
  }
}
