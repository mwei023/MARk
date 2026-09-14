import { ToolDescriptor } from './types';

export interface TaskBinding {
  input: Record<string, unknown>;
  missingRequired: string[];
  matchedFields: string[];
  complete: boolean;
  reason: string;
}

export interface TaskBinderDependencies {}

export class TaskBinder {
  constructor(
    private readonly dependencies: TaskBinderDependencies = {},
  ) {}

  bind(
    goal: string,
    tool: ToolDescriptor,
  ): TaskBinding {
    const schema = tool.inputSchema as {
      type?: string;
      properties?: Record<string, {
        type?: string;
        description?: string;
      }>;
      required?: string[];
    };

    const properties = schema.properties ?? {};
    const required = schema.required ?? [];

    if (Object.keys(properties).length === 0) {
      return {
        input: {},
        missingRequired: [],
        matchedFields: [],
        complete: true,
        reason: `Tool "${tool.id}" does not declare any input fields.`,
      };
    }

    const normalizedGoal = goal.toLowerCase();

    const input: Record<string, unknown> = {};
    const matchedFields: string[] = [];

    for (const [field, definition] of Object.entries(properties)) {
      const fieldName = field.toLowerCase();
      const description = definition.description?.toLowerCase() ?? '';

      if (
        normalizedGoal.includes(fieldName) ||
        (description &&
          this.matchesDescription(normalizedGoal, description))
      ) {
        const value = this.extractFieldValue(
          goal,
          field,
          definition,
        );

        if (value !== undefined) {
          input[field] = value;
          matchedFields.push(field);
        }
      }
    }

    const missingRequired = required.filter(
      field => input[field] === undefined,
    );

    return {
      input,
      missingRequired,
      matchedFields,
      complete: missingRequired.length === 0,
      reason: this.buildReason(
        tool,
        missingRequired,
        matchedFields,
      ),
    };
  }

  private matchesDescription(
    goal: string,
    description: string,
  ): boolean {
    const terms = description
      .split(/[^a-z0-9]+/)
      .filter(term => term.length >= 4);

    return terms.some(term => goal.includes(term));
  }

  private extractFieldValue(
    goal: string,
    field: string,
    definition: {
      type?: string;
      description?: string;
    },
  ): unknown {
    const fieldPattern = new RegExp(
      `${this.escapeRegExp(field)}\\s*[:=]\\s*["']?([^"',\\n]+)["']?`,
      'i',
    );

    const explicitMatch = goal.match(fieldPattern);

    if (explicitMatch?.[1]) {
      return this.coerceValue(
        explicitMatch[1].trim(),
        definition.type,
      );
    }

    return undefined;
  }

  private coerceValue(
    value: string,
    type?: string,
  ): unknown {
    switch (type) {
      case 'number': {
        const parsed = Number(value);
        return Number.isNaN(parsed) ? value : parsed;
      }

      case 'boolean':
        if (value.toLowerCase() === 'true') {
          return true;
        }

        if (value.toLowerCase() === 'false') {
          return false;
        }

        return value;

      default:
        return value;
    }
  }

  private buildReason(
    tool: ToolDescriptor,
    missingRequired: string[],
    matchedFields: string[],
  ): string {
    if (missingRequired.length > 0) {
      return `Capability "${tool.id}" requires input that could not yet be bound: ${missingRequired.join(', ')}.`;
    }

    if (matchedFields.length > 0) {
      return `Bound goal values to the declared input schema of "${tool.id}".`;
    }

    return `Capability "${tool.id}" declares inputs, but no explicit values were found in the goal.`;
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
