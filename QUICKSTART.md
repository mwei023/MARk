# MARK Quickstart: complete incident lifecycle in under 10 minutes

This is the Phase-3 exit proof: a new developer sets up the system, fires
a test webhook, and sees a complete incident lifecycle — create,
investigate, approve, execute, resolve-ready — with every step timed.
Reference run: **6 seconds** for the live loop (server boot included).

## Prerequisites

- Node.js 18+
- PostgreSQL running with a `mark_db` database
- No API keys needed (deterministic paths first; LLM is last resort)

## Step 1 — Install (one time, ~3 min)

```bash
git clone <repo> jarvis-core && cd jarvis-core/app
npm install
```

## Step 2 — Configure + migrate (~1 min)

```bash
# .env needs DATABASE_URL (see .env.example). Then:
npm run db:migrate   # numbered migrations 001-011, tracked in _migrations
```

## Step 3 — Boot (~5 s)

```bash
npm run dev          # server-v2.ts on :3001
curl http://localhost:3001/api/health
```

## Step 4 — Fire a test webhook (~1 s)

```bash
curl -X POST http://localhost:3001/webhooks/github \
  -H "X-GitHub-Event: workflow_run" \
  -H "Content-Type: application/json" \
  -d '{
    "repository": { "id": 9, "full_name": "quickstart/demo" },
    "workflow": { "name": "ci" },
    "workflow_run": { "id": 4242, "conclusion": "failure",
      "head_sha": "abc123", "head_branch": "main",
      "jobs_url": "https://x/j", "html_url": "https://x/w" }
  }'
# => {"status":"received"} (unsigned OK in dev; set GITHUB_WEBHOOK_SECRET to enforce HMAC)
```

## Step 5 — See the incident lifecycle (~4 s)

```bash
curl http://localhost:3001/api/incidents | jq '.incidents[0] | {id, status}'
# => git-agent owns it; status escalated after investigation

curl http://localhost:3001/api/incidents/INC-... | jq '.summary'
# => { findings: [...4 human-readable...], actionCount: 3, confidence, status, durationMs }
```

What just happened: webhook → `github.workflow.failed` → Gateway →
GitAgent (fetch logs → classify with confidence → findings written back)
→ incident correlated → escalation JSON line appended to `app/audit.log`.

## Step 6 — Approval leg: propose, approve, execute (~2 s)

Kernel mutations always pause for confirmation. Address a tool
explicitly, approve the confirmation, watch it execute:

```bash
curl -X POST http://localhost:3001/api/command \
  -H "Content-Type: application/json" \
  -d '{"command": "fs.directory_create with path: quickstart-probe", "userId": "quickstart"}'
# => ⏳ ... needs approval ... confirmation confirm_... Approve with confirmation confirm_...

curl -X POST http://localhost:3001/api/approve \
  -H "Content-Type: application/json" \
  -d '{"confirmationId": "confirm_...", "approved": true}'
# => {"success": true, ...} and app/quickstart-probe/ exists on disk
rmdir app/quickstart-probe 2>/dev/null; true
```

## Step 7 — World model (~1 s)

```bash
curl http://localhost:3001/api/status/ops | jq '{incidents: .openIncidents.total, degraded: .degraded}'
tail -1 app/audit.log | jq '{level, incidentId, title, severity}'
```

## Verification checklist

- [ ] `db:migrate` applies cleanly (001-011)
- [ ] Webhook returns `{"status":"received"}`
- [ ] One incident appears with git-agent findings + ≥1 action
- [ ] `audit.log` gains an `ESCALATION` JSON line
- [ ] Approval executes the gated action (directory on disk)
- [ ] `/api/status/ops` returns data with `degraded: []`
- [ ] Total wall time under 10 minutes

## Troubleshooting

- **Postgres refused**: `pg_isready`; create `mark_db`; re-run `db:migrate`.
- **401 on webhook**: unset in dev unless `GITHUB_WEBHOOK_SECRET` is set — then sign with `sha256=` HMAC.
- **"could not bind inputs"**: name tools explicitly (`fs.directory_create with path: ...`); see `isExplicitToolCall` in `gateway.ts`.
- **Stale docs**: historical design notes live in `docs/archive/`; `ARCHITECTURE.md` is current.
