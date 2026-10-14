import { describe, expect, it } from 'vitest';
import { ProposalStore, type ProposalDatabase } from './proposal.js';

class FakeProposalDatabase implements ProposalDatabase {
  rows: Array<Record<string, any>> = [];

  async query(text: string, params: unknown[] = []): Promise<{ rows: Array<Record<string, any>> }> {
    if (text.includes('SELECT id, incident_id')) {
      return { rows: this.rows.filter(row => row.status === 'pending').slice(0, Number(params[0])) };
    }
    if (text.includes('INSERT INTO action_proposals')) {
      this.rows.push({
        id: params[0],
        incident_id: params[1],
        action: params[2],
        tool: params[3],
        input: JSON.parse(String(params[4])),
        rationale: params[5],
        risk_level: params[6],
        status: params[7],
        created_at: params[8],
      });
      return { rows: [] };
    }
    if (text.includes('UPDATE action_proposals')) {
      const row = this.rows.find(candidate => candidate.id === params[0]);
      if (row) {
        row.status = params[1];
        row.decided_at = params[2];
        row.decided_by = params[3];
        row.execution_result = params[4];
      }
      return { rows: [] };
    }
    throw new Error(`Unexpected query: ${text}`);
  }
}

describe('ProposalStore durability contract', () => {
  it('hydrates a pending proposal into a fresh store instance', async () => {
    const db = new FakeProposalDatabase();
    const firstProcess = new ProposalStore(db);
    const created = firstProcess.create({
      incidentId: 'INC-1',
      action: 'Restart service',
      tool: 'docker_compose_restart',
      input: { container: 'api' },
      rationale: 'Health check failed',
      riskLevel: 'low',
    });
    await firstProcess.flush();

    const afterRestart = new ProposalStore(db);
    expect(await afterRestart.loadFromDatabase()).toBe(1);
    expect(afterRestart.get(created.id)).toMatchObject({
      id: created.id,
      status: 'pending',
      input: { container: 'api' },
    });

    afterRestart.approve(created.id, 'api');
    await afterRestart.flush();
    expect(db.rows[0].status).toBe('approved');
  });
});
