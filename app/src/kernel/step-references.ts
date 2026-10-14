import type {
  PlanStepStatus,
} from './planner';

/**
 * Structured data flow between plan steps.
 *
 * A plan step can consume structured output produced by an earlier step in the
 * same plan. References use the compact format:
 *
 *   $steps.<stepId>
 *   $steps.<stepId>.output
 *   $steps.<stepId>.output.data.hostname
 *
 * The prefix is deliberately structured and namespaced so that ordinary
 * strings, shell-style expressions, and JavaScript expressions are never
 * interpreted as references. Reference resolution is pure data navigation:
 * it never executes code and never touches a shell.
 */

export const STEP_REFERENCE_PREFIX = '$steps.';

/** Root value segments of a stored step result that references may target. */
const RESULT_ROOT_FALLBACK_KEY = 'result';

export type StepReferenceErrorCode =
  | 'MALFORMED_REFERENCE'
  | 'UNKNOWN_STEP'
  | 'STEP_NOT_SUCCEEDED'
  | 'PATH_NOT_RESOLVED';

export class StepReferenceError extends Error {
  readonly code: StepReferenceErrorCode;
  readonly reference: string;

  constructor(
    code: StepReferenceErrorCode,
    reference: string,
    message: string,
  ) {
    super(message);
    this.name = 'StepReferenceError';
    this.code = code;
    this.reference = reference;
  }
}

export interface StepReferenceTarget {
  stepId: string;
  /** Property path below the step result root, e.g. ["output", "data", "hostname"]. */
  path: string[];
}

export interface StepResultSnapshot {
  stepId: string;
  status: PlanStepStatus;
  output?: unknown;
  /** Optional full execution result; used when no dedicated output exists. */
  result?: unknown;
  resolvedInput?: unknown;
  error?: string;
}

export type StepResultLookup =
  | ReadonlyMap<string, StepResultSnapshot>
  | ReadonlyArray<StepResultSnapshot>
  | Readonly<Record<string, StepResultSnapshot>>;

/**
 * Returns true only for strings that are step references.
 *
 * The prefix must be followed by at least one character, so "$steps" and
 * "$steps." are ordinary strings, as is any string that merely contains the
 * prefix somewhere in the middle.
 */
export function isStepReference(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith(STEP_REFERENCE_PREFIX) &&
    value.length > STEP_REFERENCE_PREFIX.length
  );
}

/**
 * Parses a step reference into its target step ID and property path.
 *
 * Returns null for strings that are not step references at all.
 */
export function parseStepReference(
  reference: string,
): StepReferenceTarget | null {
  if (!isStepReference(reference)) {
    return null;
  }

  const remainder = reference.slice(STEP_REFERENCE_PREFIX.length);
  const segments = remainder
    .split('.')
    .filter(segment => segment.length > 0);

  if (segments.length === 0) {
    return null;
  }

  const [stepId, ...path] = segments;

  return {
    stepId,
    path,
  };
}

/**
 * Collects every step reference contained in an input value, including
 * references nested inside objects and arrays. Used by plan validation to
 * reject references to steps that do not exist in the plan.
 */
export function collectStepReferences(value: unknown): string[] {
  const references: string[] = [];

  const visit = (node: unknown): void => {
    if (isStepReference(node)) {
      references.push(node);
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item);
      }
      return;
    }

    if (isPlainObject(node)) {
      for (const item of Object.values(node)) {
        visit(item);
      }
    }
  };

  visit(value);

  return references;
}

/**
 * Resolves every step reference inside a step input against the results of
 * previously executed steps.
 *
 * - A value that is entirely a reference is replaced by the referenced value.
 * - References inside objects and arrays are resolved recursively.
 * - Non-reference strings are preserved unchanged.
 * - References to unknown or unsuccessful steps, and references that cannot
 *   be navigated, throw a StepReferenceError with a clear message.
 */
export function resolveInputReferences(
  input: Record<string, unknown>,
  stepResults: StepResultLookup,
): Record<string, unknown> {
  const resultsByStepId = buildStepResultIndex(stepResults);

  const resolveNode = (value: unknown): unknown => {
    if (isStepReference(value)) {
      return resolveStepReference(value, resultsByStepId);
    }

    if (Array.isArray(value)) {
      return value.map(item => resolveNode(item));
    }

    if (isPlainObject(value)) {
      const resolved: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        resolved[key] = resolveNode(item);
      }
      return resolved;
    }

    return value;
  };

  return resolveNode(input) as Record<string, unknown>;
}

function buildStepResultIndex(
  stepResults: StepResultLookup,
): Map<string, StepResultSnapshot> {
  const index = new Map<string, StepResultSnapshot>();

  if (stepResults instanceof Map) {
    for (const [stepId, snapshot] of stepResults) {
      index.set(stepId, snapshot);
    }
    return index;
  }

  if (Array.isArray(stepResults)) {
    for (const snapshot of stepResults) {
      index.set(snapshot.stepId, snapshot);
    }
    return index;
  }

  for (const [stepId, snapshot] of Object.entries(stepResults)) {
    index.set(stepId, snapshot);
  }

  return index;
}

function resolveStepReference(
  reference: string,
  resultsByStepId: Map<string, StepResultSnapshot>,
): unknown {
  const target = parseStepReference(reference);

  if (!target) {
    throw new StepReferenceError(
      'MALFORMED_REFERENCE',
      reference,
      `Malformed step reference "${reference}". Expected "${STEP_REFERENCE_PREFIX}<stepId>" optionally followed by property segments such as "${STEP_REFERENCE_PREFIX}<stepId>.output.data.field".`,
    );
  }

  const snapshot = resultsByStepId.get(target.stepId);

  if (!snapshot) {
    const knownStepIds = [...resultsByStepId.keys()];
    const knownSuffix =
      knownStepIds.length > 0
        ? ` Known executed steps: ${knownStepIds.join(', ')}.`
        : ' No steps have completed yet.';

    throw new StepReferenceError(
      'UNKNOWN_STEP',
      reference,
      `Step reference "${reference}" points to step "${target.stepId}", which has not executed yet or does not exist in the plan.${knownSuffix}`,
    );
  }

  if (snapshot.status !== 'succeeded') {
    throw new StepReferenceError(
      'STEP_NOT_SUCCEEDED',
      reference,
      `Step reference "${reference}" points to step "${target.stepId}" with status "${snapshot.status}". Only succeeded steps can be referenced.`,
    );
  }

  // A bare reference resolves to the whole step output.
  if (target.path.length === 0) {
    return selectWholeOutput(snapshot, reference);
  }

  // The first path segment selects which part of the stored result to
  // navigate: `output` (the tool output, preferred), `result` (the full
  // execution result), or `resolvedInput` (the input the step actually ran
  // with). Any other segment navigates the output value directly.
  const [head, ...rest] = target.path;

  let root: unknown;
  let remainingPath: string[];

  if (head === 'output') {
    root = selectWholeOutput(snapshot, reference);
    remainingPath = rest;
  } else if (head === 'result') {
    if (snapshot.result === undefined) {
      throw new StepReferenceError(
        'PATH_NOT_RESOLVED',
        reference,
        `Step reference "${reference}" cannot resolve "result": no full execution result was stored for step "${snapshot.stepId}".`,
      );
    }
    root = snapshot.result;
    remainingPath = rest;
  } else if (head === 'resolvedInput') {
    if (snapshot.resolvedInput === undefined) {
      throw new StepReferenceError(
        'PATH_NOT_RESOLVED',
        reference,
        `Step reference "${reference}" cannot resolve "resolvedInput": step "${snapshot.stepId}" has no resolved input stored.`,
      );
    }
    root = snapshot.resolvedInput;
    remainingPath = rest;
  } else {
    root = selectWholeOutput(snapshot, reference);
    remainingPath = target.path;
  }

  const resolved = navigatePath(root, remainingPath, reference);

  return resolved;
}

/**
 * Returns the value a whole-result reference resolves to: the step's tool
 * output, falling back to the full execution result for result shapes that
 * carry no dedicated output field.
 */
function selectWholeOutput(
  snapshot: StepResultSnapshot,
  reference: string,
): unknown {
  if (snapshot.output !== undefined) {
    return snapshot.output;
  }

  if (snapshot.result !== undefined) {
    return snapshot.result;
  }

  throw new StepReferenceError(
    'PATH_NOT_RESOLVED',
    reference,
    `Step reference "${reference}" points to step "${snapshot.stepId}", which completed without producing an output to reference.`,
  );
}

function navigatePath(
  root: unknown,
  path: string[],
  reference: string,
): unknown {
  let current: unknown = root;

  for (const segment of path) {
    if (current === null || current === undefined) {
      throw new StepReferenceError(
        'PATH_NOT_RESOLVED',
        reference,
        `Step reference "${reference}" cannot resolve segment "${segment}" because the value at that point is ${current === null ? 'null' : 'undefined'}.`,
      );
    }

    if (typeof current !== 'object' || !(segment in current)) {
      const actualType = Array.isArray(current)
        ? 'array'
        : typeof current;

      throw new StepReferenceError(
        'PATH_NOT_RESOLVED',
        reference,
        `Step reference "${reference}" cannot resolve segment "${segment}": no property "${segment}" exists on the ${actualType} value.`,
      );
    }

    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}
