# MARK Phase 1: Runtime Consolidation

## Canonical command path

Every normal user command now enters `MarkRuntime`:

```text
interface (HTTP API, REPL, or voice)
  → MarkRuntime.executeCommand
  → canonical EventBus: user.command.received
  → Gateway classification
  → local capability | specialist agent | reasoning adapter
  → canonical EventBus: agent.action.taken
  → interface response
```

- The canonical event bus is `app/src/core/event-bus.ts`.
- The canonical capability registry is `app/src/runtime/capabilities/registry.ts`.
- The initial local capability is `LocalHostCapability`, which wraps the
  existing safe system-check tool for time, date, files, disk, memory, and CPU.
- The existing GitAgent handles Git-domain commands and delegates host Git work
  to that same capability registry.
- The legacy LangGraph Jarvis agent remains available as the reasoning adapter;
  it retains its conversation/RAG/tool behavior rather than being removed.

Voice remains an I/O adapter. It now submits its transcribed commands to the
runtime, but its recording, speech-to-text, and text-to-speech implementation
was not redesigned in this phase.

## Validation

`cd app && npm run typecheck:mark` validates the canonical Phase 1 runtime.
`cd app && npm run test:mark` verifies deterministic capability, specialist
agent, and reasoning routes without requiring Ollama or PostgreSQL.

The full project type-check remains red from pre-existing, out-of-scope areas:

- incomplete alternate `agent/index.ts` and command executor;
- legacy LangGraph node typing and tool-registry incompatibilities;
- missing Express type declarations;
- unfinished runtime executive, I/O, and memory stubs;
- mixed CommonJS/NodeNext import configuration in legacy scripts;
- voice TTS implementation/export defects;
- RAG/market/tool typing inconsistencies.

None of those modules are part of the Phase 1 command routing foundation. They
remain intentionally untouched for later, deliberate migrations.

## Integration verification fixes

The Phase 1 end-to-end verification found and fixed three concrete runtime
defects without changing the architecture:

1. `npm run dev` could not start the API because ts-node performed the
   repository-wide type-check. The development launchers now use
   `--transpile-only`; `typecheck:mark` remains the focused type check for the
   canonical runtime.
2. The legacy reasoning adapter used dynamic ESM resolution for `../agent`,
   which selected the `agent/` directory rather than `agent.ts`. It now uses
   CommonJS resolution to load the preserved `agent.ts` entry point.
3. A failing reasoning adapter previously rejected the complete command. The
   runtime now returns an explicit `unavailable` result instead, so a failed
   LLM/service does not turn into an unhandled MARK command failure.
