import {
  ActionResult,
  KernelId,
  Observation,
  ObservationKind,
} from './types';

import { createKernelId } from './execution-context';

export interface CreateObservationInput {
  kind: ObservationKind;
  source: string;
  summary: string;
  data: unknown;
  subject?: string;
  confidence?: number;
  relatedActionId?: KernelId;
  relatedResourceIds?: KernelId[];
  metadata?: Record<string, unknown>;
}

export class ObservationStore {
  private readonly observations: Observation[] = [];

  constructor(
    private readonly maxEntries = 10_000,
  ) {}

  record(input: CreateObservationInput): Observation {
    const observation: Observation = {
      id: createKernelId('observation'),
      kind: input.kind,
      source: input.source,
      subject: input.subject,
      summary: input.summary,
      data: input.data,
      confidence: input.confidence,
      observedAt: new Date().toISOString(),
      relatedActionId: input.relatedActionId,
      relatedResourceIds: input.relatedResourceIds,
      metadata: input.metadata,
    };

    this.observations.push(observation);

    if (this.observations.length > this.maxEntries) {
      this.observations.splice(
        0,
        this.observations.length - this.maxEntries,
      );
    }

    return observation;
  }

  recordMany(inputs: CreateObservationInput[]): Observation[] {
    return inputs.map(input => this.record(input));
  }

  get(observationId: KernelId): Observation | undefined {
    return this.observations.find(
      observation => observation.id === observationId,
    );
  }

  list(): Observation[] {
    return [...this.observations];
  }

  findByAction(actionId: KernelId): Observation[] {
    return this.observations.filter(
      observation => observation.relatedActionId === actionId,
    );
  }

  findByResource(resourceId: KernelId): Observation[] {
    return this.observations.filter(observation =>
      observation.relatedResourceIds?.includes(resourceId),
    );
  }

  clear(): void {
    this.observations.length = 0;
  }
}

/**
 * Converts an action result into an observation that can be used by
 * verification, diagnosis, memory, or later workflow steps.
 */
export function observationFromActionResult(
  result: ActionResult,
  source = 'kernel.executor',
): Observation {
  return {
    id: createKernelId('observation'),
    kind: result.error ? 'error' : 'output',
    source,
    subject: result.actionId,
    summary: result.error
      ? `Action ${result.actionId} failed.`
      : `Action ${result.actionId} completed with status ${result.status}.`,
    data: {
      status: result.status,
      output: result.output,
      error: result.error,
    },
    observedAt: new Date().toISOString(),
    relatedActionId: result.actionId,
  };
}

export const observationStore = new ObservationStore();
