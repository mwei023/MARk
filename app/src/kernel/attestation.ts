/**
 * Acceptance attestation: the DECIDE gate.
 *
 * A plan step declares acceptance criteria ("OAuth callback persists the
 * session"). Verifiers emit observations, optionally stamped with an
 * explicit requirementId + attestation. This module matches the two
 * deterministically — no LLM gets to say "overall, this looks good":
 *
 * - Explicit stamp wins: observation.requirementId matches the
 *   requirement id (REQ-001 form) or its index, attestation decides.
 * - Otherwise term overlap: an observation shares >=2 significant terms
 *   with the requirement; pass/fail inferred from pass/fail vocabulary
 *   in the summary, else unresolved.
 * - Anything unmatched is unresolved — and unresolved findings REJECT.
 */
import type { Observation } from './types';

export type AttestationStatus = 'pass' | 'fail' | 'unresolved';

export interface AttestationDecision {
  requirement: string;
  status: AttestationStatus;
  evidence: string[];
}

export interface AttestationVerdict {
  decisions: AttestationDecision[];
  allPass: boolean;
  unresolvedCount: number;
  failCount: number;
}

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with',
  'is', 'are', 'be', 'that', 'this', 'it', 'as', 'at', 'by', 'from',
  'must', 'should', 'when', 'then', 'than', 'into', 'remain', 'existing',
  'you', 'we', 'do', 'so', 'no', 'up', 'out', 'off', 'its', 'our',
  'am', 'go', 'he', 'if', 'me', 'my', 'us', 'ex', 'ox', 'ax', 'ad',
]);

const PASS_WORDS = [
  'pass', 'passed', 'passing', 'success', 'succeeded', 'verified', 'clean',
  'zero', '0 errors', 'all good',
  // Reporting verbs: a matched observation that reports findings with no
  // failure vocabulary is successful evidence (fail words still win first).
  'read', 'reads', 'listed', 'lists', 'found', 'returned', 'returns',
  'showing', 'shows', 'contains', 'includes', 'completed', 'retrieved',
];
const FAIL_WORDS = ['fail', 'failed', 'failing', 'failure', 'error', 'errors', 'regression', 'broken', 'missing', 'did not', 'does not', 'not found', 'unresolved'];

function singular(value: string): string {
  if (value.endsWith('ies') && value.length > 4) return value.slice(0, -3) + 'y';
  if (value.endsWith('es') && value.length > 4) return value.slice(0, -2);
  if (value.endsWith('s') && value.length > 3) return value.slice(0, -1);
  return value;
}

function terms(text: string): string[] {
  // Floor at 2 chars so short identifiers (db, api, os) match; two-letter
  // glue is covered by STOP instead. Threshold (>=2 shared) still guards
  // against single-term coincidence.
  return [...new Set(
    text.toLowerCase().split(/[^a-z0-9]+/)
      .filter(t => t.length >= 2)
      .filter(t => !STOP.has(t))
      .map(singular),
  )];
}

function reqId(text: string): string | undefined {
  return text.match(/REQ-\d+/i)?.[0]?.toUpperCase();
}

function summaryOf(obs: Observation): string {
  const dataText = typeof obs.data === 'string' ? obs.data : safeJson(obs.data);
  return `${obs.summary} ${dataText}`.toLowerCase();
}

function safeJson(data: unknown): string {
  try {
    const text = JSON.stringify(data) ?? '';
    return text.length > 2000 ? text.slice(0, 2000) : text;
  } catch {
    return '';
  }
}

function inferredStatus(summary: string): 'pass' | 'fail' | undefined {
  // Negated failures ("zero errors", "no errors found") are pass signals,
  // not failures: strip the negated span before the fail check.
  const cleaned = summary.replace(/\b(zero|no|without|0)\b[^.]{0,24}?\berrors?\b/g, '');
  if (FAIL_WORDS.some(w => cleaned.includes(w))) return 'fail';
  if (PASS_WORDS.some(w => summary.includes(w))) return 'pass';
  return undefined;
}

export function attestAcceptance(
  acceptance: string[],
  observations: Observation[],
): AttestationVerdict {
  const decisions: AttestationDecision[] = [];
  for (let i = 0; i < acceptance.length; i++) {
    const req = acceptance[i];
    const id = reqId(req);
    const evidence: string[] = [];
    let status: AttestationStatus = 'unresolved';

    // 1. Explicit stamp: requirement id on the observation wins outright.
    if (id) {
      const stamped = observations.filter(o =>
        (o.requirementId ?? '').toUpperCase() === id ||
        summaryOf(o).includes(id.toLowerCase()),
      );
      for (const o of stamped) {
        evidence.push(o.summary.slice(0, 200));
        if (o.attestation === 'fail') status = 'fail';
        else if (o.attestation === 'pass' && status !== 'fail') status = 'pass';
      }
      if (status !== 'unresolved') {
        decisions.push({ requirement: req, status, evidence });
        continue;
      }
      // Stamped observations without attestation: fall through to inference.
      if (stamped.length > 0) {
        const inferred = stamped.map(o => inferredStatus(summaryOf(o)));
        if (inferred.includes('fail')) status = 'fail';
        else if (inferred.includes('pass')) status = 'pass';
        decisions.push({ requirement: req, status, evidence });
        continue;
      }
    }

    // 2. Term overlap: >=2 significant shared terms (or all, when fewer).
    const need = terms(req);
    if (need.length > 0) {
      const threshold = Math.min(2, need.length);
      let best: Observation | undefined;
      let bestOverlap = 0;
      for (const o of observations) {
        const hay = new Set(terms(summaryOf(o)));
        const overlap = need.filter(t => hay.has(t)).length;
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          best = o;
        }
      }
      if (best && bestOverlap >= threshold) {
        evidence.push(best.summary.slice(0, 200));
        if (best.attestation === 'fail') status = 'fail';
        else if (best.attestation === 'pass') status = 'pass';
        else status = inferredStatus(summaryOf(best)) ?? 'unresolved';
      }
    }
    decisions.push({ requirement: req, status, evidence });
  }
  const failCount = decisions.filter(d => d.status === 'fail').length;
  const unresolvedCount = decisions.filter(d => d.status !== 'pass').length;
  return { decisions, allPass: unresolvedCount === 0, unresolvedCount, failCount };
}
