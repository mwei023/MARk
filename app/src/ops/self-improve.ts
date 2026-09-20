/**
 * Self-improvement bridge — research becomes problem statements, problem
 * statements become Mark incidents, incidents become better Mark.
 *
 * Loop:
 *   ResearchAgent.report → assessUsefulness (is there a gap worth filing?)
 *     → fileProblemStatements (one incident per gap, correlated by area)
 *       → opsObjective + opsMemory learn → CodeAgent / proposals fix it.
 *
 * Rules:
 * - Filing is deterministic and offline-safe (no LLM required).
 * - Usefulness is scored on evidence: a gap with cited sources and an
 *   actionable remedy is useful; a vague "could be better" is not filed.
 * - Every file is best-effort against the incident store: DB offline means
 *   the statements are returned to the caller, never thrown away silently.
 * - This module never mutates source itself. Self-improvement proposals
 *   travel the normal incident → approval → CodeAgent path like any fix.
 */

import { incidentStore, Incident } from '../core/incident';
import { opsObjective } from './objective';

export interface ProblemStatement {
  /** Short title, e.g. "Mark's retry policy ignores 429 backoff headers". */
  title: string;
  /** Capability area, e.g. "kernel-reliability", "web-research". */
  area: string;
  /** What Mark is missing, in one or two sentences. */
  gap: string;
  /** Cited source URLs backing the claim (may be empty). */
  evidenceUrls: string[];
  /** Concrete remedy Mark could implement. */
  suggestedFix: string;
  /** 0–1 confidence the gap is real (not a research artefact). */
  confidence: number;
}

export interface UsefulnessVerdict {
  useful: boolean;
  reason: string;
  /** Distinct gap areas among the useful statements. */
  gapAreas: string[];
}

export interface FiledStatement {
  statement: ProblemStatement;
  incidentId: string | null;
  correlated: boolean;
}

/** Minimum confidence for a statement to be worth filing. */
export const MIN_FILE_CONFIDENCE = 0.4;

/**
 * Deterministic usefulness gate. A statement is useful when it names a real
 * gap (non-empty), proposes something actionable (non-empty fix), and clears
 * the confidence floor. Evidence URLs raise confidence but are not required
 * — internal gaps (e.g. "no test covers X") have no web citation by nature.
 */
export function assessUsefulness(statements: ProblemStatement[]): UsefulnessVerdict {
  const useful = statements.filter(
    s => s.title.trim().length > 0
      && s.gap.trim().length > 0
      && s.suggestedFix.trim().length > 0
      && s.confidence >= MIN_FILE_CONFIDENCE,
  );
  const gapAreas = [...new Set(useful.map(s => slug(s.area) || 'general'))];
  if (useful.length === 0) {
    const reason = statements.length === 0
      ? 'No problem statements produced — nothing to file.'
      : 'All statements below the usefulness bar (missing gap/fix or confidence < 0.4).';
    return { useful: false, reason, gapAreas: [] };
  }
  return {
    useful: true,
    reason: `${useful.length}/${statements.length} statement(s) clear the bar across area(s): ${gapAreas.join(', ')}.`,
    gapAreas,
  };
}

/**
 * Files each useful statement as a correlated incident. Returns per-statement
 * receipts; incidentId is null only when the store is unreachable (the
 * statement itself is still returned — callers surface it in the report).
 */
export async function fileProblemStatements(
  researchTopic: string,
  reportSummary: string,
  statements: ProblemStatement[],
): Promise<FiledStatement[]> {
  const out: FiledStatement[] = [];
  for (const statement of statements) {
    if (!isFileWorthwhile(statement)) {
      out.push({ statement, incidentId: null, correlated: false });
      continue;
    }
    const area = slug(statement.area) || 'general';
    try {
      const incident: Incident & { _wasCorrelated: boolean } = await incidentStore.findOrCreateIncident({
        title: `Self-improvement: ${statement.title.slice(0, 140)}`,
        description:
          `Research on "${researchTopic.slice(0, 200)}" surfaced a Mark capability gap.\n` +
          `Gap: ${statement.gap}\nSuggested fix: ${statement.suggestedFix}`,
        severity: statement.confidence >= 0.75 ? 'medium' : 'low',
        triggerEvent: 'research.problem_statement',
        triggerEventId: `RES-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        correlationId: `self-improve:${area}`,
        assignedAgent: 'research-agent',
        tags: ['self-improvement', 'research', area],
        context: {
          researchTopic: researchTopic.slice(0, 300),
          area,
          confidence: statement.confidence,
          evidenceUrls: statement.evidenceUrls.slice(0, 10),
          reportSummary: reportSummary.slice(0, 800),
        },
      });
      try {
        await incidentStore.addFinding(
          incident.id,
          `Gap (${area}, confidence ${(statement.confidence * 100).toFixed(0)}%): ${statement.gap}`,
        );
        await incidentStore.addFinding(
          incident.id,
          `Suggested remedy: ${statement.suggestedFix}` +
          (statement.evidenceUrls.length > 0
            ? ` Evidence: ${statement.evidenceUrls.slice(0, 5).join(', ')}`
            : ' (no external citation — internal gap)'),
        );
        await incidentStore.addAction(incident.id, {
          timestamp: new Date(),
          agent: 'research-agent',
          action: 'file_problem_statement',
          tool: 'self-improve',
          result: 'success',
          details: `Filed from research on "${researchTopic.slice(0, 120)}"${incident._wasCorrelated ? ' (correlated to existing gap incident)' : ''}.`,
        });
      } catch { /* trail best-effort; incident itself exists */ }
      try { opsObjective.record('incident.seen'); } catch { /* never fails a run */ }
      try {
        const { opsMemory } = await import('../core/ops-memory.js');
        void opsMemory.save({
          incidentId: incident.id,
          triggerEvent: 'research.problem_statement',
          failureType: 'SELF_IMPROVEMENT_GAP',
          classificationConfidence: statement.confidence,
          repository: null,
          resolution: statement.suggestedFix.slice(0, 500),
          success: false,
          durationMs: 0,
        }).catch(() => undefined);
      } catch { /* memory best-effort */ }
      out.push({ statement, incidentId: incident.id, correlated: incident._wasCorrelated });
    } catch {
      out.push({ statement, incidentId: null, correlated: false });
    }
  }
  return out;
}

function isFileWorthwhile(s: ProblemStatement): boolean {
  return s.title.trim().length > 0
    && s.gap.trim().length > 0
    && s.suggestedFix.trim().length > 0
    && s.confidence >= MIN_FILE_CONFIDENCE;
}

function slug(area: string): string {
  return (area || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
