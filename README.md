# MARK — Autonomous Operations (jarvis-core)

Event → Gateway → Specialist Agent / Kernel Capability → Incident audit trail.
Deterministic first, LLM last. Historical design notes live in `docs/archive/`.

## Canonical path

```
interface (HTTP API, CLI) → MarkRuntime.executeCommand
  → EventBus: user.command.received → Gateway → capability | agent | kernel | reasoning
  → EventBus: agent.action.taken
```

Webhooks (`github.workflow.failed`, `github.deployment.failed`, docker health)
share the same bus: `Gateway.classify` → `AgentRuntime.handleEvent` → `GitAgent/DevOps/CICDAgent`
→ `IncidentStore` (Postgres) → escalation / approval.

## Run

```bash
cd app
psql mark_db < Scripts/schema-v2.sql
npm run dev            # POST /webhooks/github, GET /api/incidents, POST /api/command, POST /api/approve
```

## Verify

```bash
cd app
npm run typecheck:mark
npm run test:mark       # routing + webhook parsing + multi-repo incidents
npm run test:workflow   # github.workflow.failed -> git-agent -> incident + escalation + approval
npm run test:policy     # policy bridge (read auto, prod mutations confirm)
npm run test:classifier # LLM classifier fallback (null-safe)
```

## Layout

- `app/src/core/` — `event-bus.ts`, `events.ts`, `gateway.ts` (whole-word routing), `agent-runtime.ts`, `policies.ts`, `incident.ts`, `mark-runtime.ts`
- `app/src/agents/` — `git-agent.ts`, `devops-agent.ts`, `cicd-agent.ts`
- `app/src/kernel/` — capability resolver, task binder, authority/confirmations, workflow memory
- `app/src/runtime/capabilities/` — local host + mark status
- `app/src/webhooks/` — `github.ts`, `docker.ts`
- `app/src/api/server-v2.ts` — webhooks + incidents + command + approvals
- `app/src/_archive/` — legacy LangGraph agent, market/RAG tools, voice, old server (excluded from `tsc`)
- `docs/archive/` — superseded milestone docs

See `ARCHITECTURE.md` for design, `QUICKSTART.md` for setup, `PHASE1_STATUS.md` for scope notes.
