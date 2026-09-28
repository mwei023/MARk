import { describe, it, expect } from 'vitest';
import { attestAcceptance } from './attestation.js';
import type { Observation } from './types.js';

const obs = (summary: string, extra: Partial<Observation> = {}): Observation => ({
  id: 'o', kind: 'output', source: 'test', summary, data: {},
  observedAt: new Date().toISOString(), ...extra,
});

describe('attestation verdicts', () => {
  it('passes on explicit requirement-id stamps', () => {
    const v = attestAcceptance(
      ['REQ-001 OAuth callback persists session', 'REQ-002 expired token returns 401'],
      [
        obs('typecheck clean, login flow verified', { requirementId: 'REQ-001', attestation: 'pass' }),
        obs('401 on expired token confirmed', { requirementId: 'REQ-002', attestation: 'pass' }),
      ],
    );
    expect(v.allPass).toBe(true);
    expect(v.unresolvedCount).toBe(0);
  });

  it('a single fail rejects the verdict', () => {
    const v = attestAcceptance(
      ['REQ-001 persists session', 'REQ-002 returns 401', 'REQ-003 existing login tests pass'],
      [
        obs('session persists', { requirementId: 'REQ-001', attestation: 'pass' }),
        obs('401 missing on expired token', { requirementId: 'REQ-002', attestation: 'fail' }),
      ],
    );
    expect(v.allPass).toBe(false);
    expect(v.failCount).toBe(1);
    expect(v.unresolvedCount).toBe(2); // fail + unmatched REQ-003
  });

  it('infers from term overlap when nothing is stamped', () => {
    const v = attestAcceptance(
      ['expired token returns 401'],
      [obs('Verified: expired authentication tokens correctly return HTTP 401 unauthorized')],
    );
    expect(v.decisions[0].status).toBe('pass');
  });

  it('leaves genuinely unevidenced requirements unresolved (REJECT)', () => {
    const v = attestAcceptance(
      ['quantum entanglement latency under 3ms'],
      [obs('typecheck passed with zero errors')],
    );
    expect(v.decisions[0].status).toBe('unresolved');
    expect(v.allPass).toBe(false);
  });

  it('fail vocabulary beats pass vocabulary in one summary', () => {
    const v = attestAcceptance(
      ['existing login tests remain passing'],
      [obs('login tests passed but 2 regression errors found')],
    );
    expect(v.decisions[0].status).toBe('fail');
  });
});
