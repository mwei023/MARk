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

The UI ships with the API: `http://localhost:3001/ui/control-room.html` (Control Room),
`http://localhost:3001/ui/playground.html` (Playground).

API command clients may send `sessionId` in the JSON body or an
`X-Mark-Session-Id` header. Interaction traces and lightweight context are
isolated by session; omit it only for single-user local use.

## Security boundary (localhost-first)

The API can trigger real agent actions (approvals, kernel tool execution), so the
default posture is closed:

- **Bind:** `127.0.0.1` unless `API_BIND_HOST` is set explicitly. Binding `0.0.0.0`
  logs a loud warning — only do it on a trusted network (firewall/VPN).
- **Auth:** set `API_TOKEN` to require `Bearer`/ `x-api-token` on `/api/*`. With
  `NODE_ENV=production` and no token, the server **refuses to start**; the only
  override is the explicit `MARK_ALLOW_UNAUTHENTICATED_API=true` escape hatch.
- **Webhooks:** set `GITHUB_WEBHOOK_SECRET` to require HMAC signatures; without it,
  unsigned events are accepted (local default) with a warning.

This box is safe on loopback with secrets set. It is not hardened for the open
internet (no TLS/rate-limiting in the app) — terminate TLS and filter traffic in
front of it if you expose it. Source of truth: `app/src/api/security.ts`.

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
