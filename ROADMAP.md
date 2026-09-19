# MARK Roadmap — Ops Domain First

**Rule:** No new domains, no new providers, no new interfaces until the ops
domain is fully done. "Fully done" is defined at the end of Phase 3 with
explicit exit criteria. Every phase has a hard stop — if a phase isn't
done, the next one doesn't start.

The chosen domain: **Autonomous DevOps Operations** — GitHub → incident →
investigate → act → learn → close. When this is production-grade, the
cognitive OS pattern is proven and generalizes cleanly to other domains.

---

## Phase 0 — Foundation (do first, unblocks everything)

**Goal:** The project can be trusted. Every change is verifiable.

### 0.1 Real test runner
- Add Vitest (`npm i -D vitest`)
- Port the 5 most critical existing test scripts to proper `describe/it/expect` tests:
  - Gateway routing decisions (`gateway.ts`)
  - `isHollowReuse` logic (`mark-runtime.ts`)
  - Incident create/resolve lifecycle (`incident.ts`)
  - Policy bridge read vs. mutate (`policy-bridge.ts`)
  - Kernel dispatch fallthrough (deterministic → agent → kernel → reasoning)
- Add `npm run test:unit` script
- All tests pass on every `npm run dev` startup (import the suite, don't just run it)

### 0.2 Database migrations
- Create `app/Scripts/migrations/` folder
- Rename existing SQL to numbered files: `001_initial.sql` through whatever version you're currently on (infer from schema-v5, fill the gaps)
- Write `app/Scripts/migrate.ts` — reads migration folder, tracks applied migrations in a `_migrations` table, runs missing ones in order
- Add `npm run db:migrate` script
- Run it successfully against the current DB

### 0.3 Config centralization
- Add `MARK_DEFAULT_USER`, `MARK_ENABLE_AUTOFIX`, `MARK_SMART` to a `.env.example`
- Replace every hardcoded `'mwei'` in source with `process.env.MARK_DEFAULT_USER ?? 'mark'`
- Single `app/src/config.ts` that exports typed config — no `process.env` scattered in source files

### 0.4 Silent catch audit
- Find every `catch {}` and `catch (e) { return undefined }` in `mark-runtime.ts`, `kernel/bridge.ts`, `kernel/plan-execution.ts`
- Replace with at minimum: `catch (err) { trace.push('error: ' + String(err)); }`
- Errors that are intentionally swallowed get a comment explaining why

**Exit criteria:** `npm run test:unit` passes, `npm run db:migrate` runs clean, no bare silent catches in the critical path.

---

## Phase 1 — Ops Incident Lifecycle (the core loop)

**Goal:** A real GitHub workflow failure produces a real, complete, queryable incident with a meaningful investigation trail. No simulated logs.

### 1.1 Real log fetching
- `GitAgent.fetch_logs` currently returns `[simulated log - gh unavailable]` on failure
- Replace the fallback with a structured `LogFetchResult` that clearly marks whether logs are real or unavailable — never silently return fake data to the investigation
- Add `fetch_logs` integration test against a real (or fixture) GitHub run ID

### 1.2 Failure classification — make it real
- `classifyFailure()` in `git-agent.ts` is a string-match on lowercased logs
- Extract it to `app/src/core/failure-classifier.ts`
- Add confidence scores (0.0–1.0) — a weak match (`UNKNOWN`) should not trigger the same path as a strong match (`TYPE_ERROR` with 5 matching signals)
- Add unit tests covering every failure type + edge cases (empty logs, truncated logs)

### 1.3 Incident correlation
- Right now each webhook creates a fresh incident — repeated failures on the same repo/branch/workflow create N independent incidents
- Add correlation logic: before creating an incident, query for open incidents with the same `correlationId` or matching (`repository`, `branch`, `triggerEvent`) within the last 2 hours
- If found: append to existing incident instead of creating a new one
- Add a test for this: fire 3 identical webhook events, assert 1 incident with 3 action entries

### 1.4 Investigation findings written back
- The `investigation.findings` field exists on `Incident` but is never populated
- After each tool execution in `GitAgent.handle()`, append a human-readable finding: `"Fetched 200 log lines. Classified as TYPE_ERROR (confidence 0.87). Suggested fix: review TypeScript errors."`
- Surface findings in `GET /api/incidents/:id`

### 1.5 Escalation → notification (minimal)
- When an incident reaches `escalated` status, emit a structured event that goes somewhere real: write to `app/audit.log` with a machine-readable JSON line (you already have this file)
- Format: `{ "ts": "...", "level": "ESCALATION", "incidentId": "...", "title": "...", "severity": "...", "findings": [...] }`
- Add a test: create escalated incident → assert log line written

**Exit criteria:** Fire a `github.workflow.failed` webhook → one incident created → log lines show real classification with confidence → repeated events correlate to same incident → escalation produces audit log entry.

---

## Phase 2 — Agent Actions and Approval Flow

**Goal:** MARK can propose and (with approval) execute a fix. The approval flow is production-safe and auditable.

### 2.1 Action proposals before execution
- Before any mutating action (auto-fix branch, npm install, lint:fix), the agent writes a structured proposal to the incident:
  ```
  { action: "create_branch", branch: "auto-fix/deps-1234", rationale: "MISSING_DEPENDENCY confidence 0.91", riskLevel: "low" }
  ```
- `MARK_ENABLE_AUTOFIX=true` executes low-risk proposals automatically
- Medium/high risk always require a confirmation (already have the kernel confirmation flow — use it here)

### 2.2 Approval API is fully wired
- `POST /api/approve` exists but trace it through to the actual pending action
- Write an end-to-end test: create incident → proposal written → approve via API → action executes → incident resolves
- Denial path: deny → incident stays open → `escalated` with reason

### 2.3 Rollback proposal (DevOpsAgent)
- `DevOpsAgent` currently responds to `github.deployment.failed` with "needs review" and opens an incident
- Add: query the last 3 successful deployment incidents for the same service (by tag + context)
- Propose rollback to the last known-good version as a medium-risk action requiring approval
- If no prior success found: escalate with explicit message "no prior successful deployment found for this service"

### 2.4 Dry-run mode
- Add `MARK_DRY_RUN=true` env flag
- When set: all mutating kernel tools and agent actions log "WOULD HAVE: ..." but do nothing
- This makes the agent safe to run in staging environments and useful for demos

**Exit criteria:** Full loop — webhook in, proposal out, approval in, action executed, incident resolved. All steps auditable in incident actions. Dry-run mode works.

---

## Phase 3 — Memory and Learning (the cognitive layer)

**Goal:** MARK gets better at handling incidents it has seen before. The system has a measurable world model for the ops domain.

### 3.1 Incident outcome memory
- After an incident resolves, write a compact summary to workflow memory:
  - `{ triggerEvent, failureType, confidence, actionsAttempted, resolution, success, durationMs }`
- On new incident creation, query memory for similar past incidents (same failure type + repo pattern)
- If a prior successful resolution exists, include it in `investigation.findings`: "Similar incident resolved in 14 min by: npm install on branch auto-fix/deps-9234"

### 3.2 Fix effectiveness tracking
- Track whether auto-fixes actually worked: did the workflow pass on the next run after the fix branch was created?
- This requires a follow-up webhook: `github.workflow.completed` on the auto-fix branch → look up the originating incident → mark fix as verified or failed
- After 5+ verified successes on a fix type, promote it to "trusted" — trusted fixes run without dry-run confirmation in `MARK_ENABLE_AUTOFIX=true` mode

### 3.3 Anomaly baseline
- For each monitored repo, track: average time between workflow failures, average resolution time, most common failure type
- Store in a `repo_baselines` table (add migration)
- When a new incident arrives, compare against baseline: "This repo fails 3x more than usual this week" becomes an `investigation.finding`

### 3.4 World model snapshot
- Add `GET /api/status/ops` endpoint that returns:
  - Open incidents count by severity
  - Monitored repos and their health (last event, last resolution)
  - Auto-fix success rate (last 30 days)
  - Most common failure type this week
- This is the system's self-knowledge about the ops domain — a cognitive OS must be able to answer "what do I know about my environment?"

### 3.5 Close the loop — the ops domain is done when:
- [ ] A new developer can set up the system, fire a test webhook, and see a complete incident lifecycle in under 10 minutes (write a QUICKSTART that proves this)
- [ ] The system handles the same failure type better on the 5th occurrence than the 1st (measurable via resolution time or confidence scores)
- [ ] `GET /api/status/ops` returns meaningful data after 1 week of operation
- [ ] All Phase 0 tests pass, all Phase 1–3 behaviors have at least one Vitest test
- [ ] No hardcoded usernames, no bare silent catches, no schema version confusion

**Exit criteria (all must pass):** QUICKSTART works end-to-end, learning is measurable, world model endpoint returns real data, test suite is green.

---

## What Comes After (don't touch until Phase 3 is done)

These are explicitly deferred. They are listed here so you don't forget them — but they are locked.

- **Personal assistant domain** (desktop, media, browser tools) — already partially built; clean it up after ops is solid
- **Voice interface** — whisper.cpp is in `/bin`; wire it properly once the command path is stable
- **Multi-user / multi-tenant** — the `userId` abstraction is already there; fill it in
- **Cross-domain reasoning** — the kernel handles both ops events and personal commands; unify the world model across both domains
- **External integrations** (PagerDuty, Slack, etc.) — natural escalation targets once the audit log is real

---

## What to Do Right Now

1. `npm i -D vitest` and write the first 5 unit tests
2. Create `app/Scripts/migrations/` and `app/Scripts/migrate.ts`
3. Create `app/src/config.ts` and remove hardcoded `'mwei'`

Phase 0 takes 1–2 days. Everything else is built on it.
