# mark-runtime → jarvis-core merge plan

Source: `github.com/mwei023/mark-runtime` v0.1 (portable probe, model
cascade, computer-use MCP, voice). Target: this repo (brain: bus, gateway,
agents, incident store, policy).

Rule: prove each phase with existing `npm run` checks before the next.
Voice comes LAST.

## Phase 1 — field probe + device registry (this PR)
- New: `app/src/runtime/capabilities/field-node.ts`
  - `FieldNodeRegistry`: nodes keyed by hostname `{ manifest, lastSeen }`.
    Manifest schema mirrors `mark-runtime/host-manifest.json`
    (cameras, audio, tools, models_local, gpio, i2c, serial).
  - `FieldProbeCapability` (`field.probe`): answers "which nodes have
    camera/lidar/gpio/docker/ollama?" from the registry. Task-binder can
    route capability-constrained work to the right node.
- Register in `MarkRuntime` constructor next to `host.local`/`mark.status`.
- Model cascade: document mapping only — `MARK_PRIMARY/SECONDARY/OFFLINE`
  env onto existing `getLLMConfiguration()` primary + `fallbackProviders`
  (see `mark.status`). No code change; offline Ollama stays last resort.
- Prove: `npm run typecheck:mark`, new unit test for registry matching.

## Phase 2 — computer-use tools as kernel capabilities
- Expose mark-runtime MCP tools as capabilities: `field.screenshot`,
  `field.click`, `field.type`, `field.camshot` (eyes/hands per node).
- Wire send/post-class actions through `policy-bridge` confirmations;
  attach before/after screenshots to approval requests and incident audit.
- Prove: approval-flow test with screenshot evidence attached.

## Phase 3 — edge event sources
- ESP32/Arduino TinyML nodes publish MQTT (`obstacle`, `low-batt`, `wake`)
  into the EventBus next to `github.workflow.failed` / docker health.
- Same path: `Gateway.classify → AgentRuntime.handleEvent → IncidentStore`
  → escalation / approval.
- Prove: `test:workflow`-style test for a hardware event → incident.

## Phase 4 — voice (LAST, only after 1–3 proven)
- Un-archive voice: Piper `speak` + arecord `listen` from mark-runtime as
  third interface into `MarkRuntime.executeCommand(source='voice')`
  (signature already accepts it). STT step still open (whisper vs cloud).
- Prove: voice command → action → spoken confirmation, end to end.

## Non-goals
- No brain fork: jarvis-core stays authoritative (bus, policy, store).
- No secrets in repo (`.env` never committed; models via env).
