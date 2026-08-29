# Mark v0.2 Architecture

## Vision
Autonomous operations system with deterministic event handling and bounded LLM reasoning.

## High-Level Flow

```
EVENT SOURCES                    GATEWAY                      AGENTS
  │                                │                            │
  ├─ GitHub Webhooks ─┐           │                            │
  ├─ Docker Events    ├──→ Intent Classification ──→ Route to Specialist Agents
  ├─ User Commands    ┤           │                            │
  ├─ CI/CD Events ────┤           │        ┌──────────────────┴─────┐
  └─ Health Checks ───┘           │        │                        │
                                   │     GitAgent          DevOpsAgent
                                   │        │                   │
                                   └────────┼───────────────────┘
                                            │
                                         TOOL SYSTEM
                                            │
                                        EVENT BUS
                                            │
                                       MARK MEMORY
                                      (Incidents)
```

## Directory Structure (New)

```
app/src/
├── core/
│   ├── event-bus.ts          # Event pub/sub
│   ├── events.ts             # Event types
│   ├── gateway.ts            # Intent classifier
│   ├── agent-runtime.ts      # Agent executor
│   ├── policies.ts           # Execution policies
│   └── incident.ts           # Incident model + store
├── agents/
│   ├── agent-base.ts         # Base class
│   ├── git-agent.ts          # Git monitor + actions
│   ├── devops-agent.ts       # Deployment, health, rollback
│   └── cicd-agent.ts         # Pipeline orchestration
├── tools/
│   ├── git-tools.ts          # Git operations
│   ├── devops-tools.ts       # Docker, rollback, etc
│   └── cicd-tools.ts         # Pipeline tools
├── webhooks/
│   ├── github.ts             # GitHub event handler
│   └── docker.ts             # Docker event handler
├── db/
│   ├── postgres.ts           # (KEEP - reuse)
│   └── schema.sql            # Incident schema
├── llm/
│   ├── index.ts              # (KEEP - reuse)
│   └── embeddings.ts         # (KEEP for later)
├── api/
│   ├── server.ts             # (REFACTOR - event gateway)
│   └── webhook-receiver.ts   # GitHub/Docker webhooks
├── voice/
│   ├── input.ts              # Voice → event emitter
│   └── output.ts             # Event → text/voice
└── tests/
    └── agents/               # Agent behavior tests
```

## v0.2 Milestone: DevOps Monitor & Auto-Responder

### Events Handled
- `github.workflow.failed` → Investigate build failure
- `github.deployment.failed` → Rollback or alert
- `docker.health_check.failed` → Restart or investigate
- `ci.test.failed` → Run diagnostics
- `user.command` → Route to appropriate agent

### Agents Involved
1. **GitAgent** - Fetch logs, diffs, blame
2. **DevOpsAgent** - Health checks, rollback, restart
3. **CICDAgent** - Pipeline status, trigger rebuilds

### Execution Policies
- Auto-restart failed container (low risk)
- Propose rollback, await confirmation (medium risk)
- Alert on database issues (high risk)

### Key Components
- **IncidentStore** - Track events, decisions, outcomes
- **PolicyEngine** - Evaluate permission to act
- **AgentRuntime** - Execute agent actions with safe tool execution
- **Webhook Receivers** - Transform GitHub/Docker events to internal events

## Migration Path

### Phase 1: Foundation (Days 1-2)
1. Create event bus and event types
2. Create incident model + PostgreSQL schema
3. Create tool execution layer with policies
4. Create agent base class and runtime

### Phase 2: First Agent (Days 3-4)
1. Implement GitAgent with GitHub webhook receiver
2. Build failure classification logic
3. Create first state machine (build failure investigation)

### Phase 3: Integration (Days 5-6)
1. Implement DevOpsAgent with health checks
2. Add rollback state machine
3. Connect to voice/API as event sources

### Phase 4: Hardening (Days 7-8)
1. Add monitoring, logging
2. Test failure scenarios
3. Add approval workflow
