# Mark v0.2 Implementation Guide

## What We Just Built

The foundation for an **autonomous operations system** that:
- Routes events deterministically before considering LLM reasoning
- Tracks all problems as **incidents** with full audit trails
- Executes actions via **specialized agents** with policy controls
- Integrates GitHub, Docker, and CI/CD events
- Provides **web API** and **approval workflows**

## Architecture Summary

```
GitHub Webhooks
    │
    ├─→ GitHub Event Parser
    │        │
    │        ▼
    │  Internal Event
    │        │
    │        ▼
    │   Event Bus
    │        │
    │        ▼
    │   Gateway (classify)
    │        │
    │        ├─→ Deterministic Path → GitAgent
    │        ├─→ Agent Path → DevOpsAgent  
    │        ├─→ Reasoning Path → LLM (later)
    │        └─→ Escalate → Alert User
    │
    └─→ Incident Store (PostgreSQL)
         │
         ├─ Incident record
         ├─ Actions audit trail
         └─ Resolution + AI analysis
```

## Project Structure

```
app/src/
├── core/
│   ├── events.ts           ✅ Event type definitions
│   ├── event-bus.ts        ✅ Pub/sub mechanism
│   ├── gateway.ts          ✅ Intent router
│   ├── incident.ts         ✅ Problem tracker
│   ├── policies.ts         ✅ Safety rules
│   └── agent-runtime.ts    ✅ Agent executor
├── agents/
│   ├── git-agent.ts        ✅ Build/git operations
│   ├── devops-agent.ts     ⏳ Deployment/health (NEXT)
│   └── cicd-agent.ts       ⏳ Pipeline orchestration (LATER)
├── webhooks/
│   ├── github.ts           ✅ GitHub event parser
│   └── docker.ts           ⏳ Docker events (LATER)
├── api/
│   └── server-v2.ts        ✅ Event-driven API server
├── db/
│   └── schema-v2.sql       ✅ Incident tables
└── tools/
    ├── git-tools.ts        ⏳ Git operations
    └── devops-tools.ts     ⏳ Deployment tools
```

## Next Steps: Cleaning Up The Codebase

### Phase 1: Remove Old System (Immediate)
```bash
# These are the old chatbot pieces - can be removed
rm -rf app/src/voice/           # Voice loop (replaced by event-driven)
rm -rf app/src/agent/graph.ts   # Old LangGraph (replaced by AgentRuntime)
rm -rf app/src/agent/nodes.ts   # Old routing logic
rm -rf app/src/agent/state.ts   # Old conversation state
rm -rf app/src/monitoring/      # Old monitoring (integration → agents)
rm -f  app/src/rags.ts          # RAG not needed for v0.2

# Keep but refactor:
# - agent/history.ts → Archive (superseded by incident tracking)
# - agent/memory.ts → Archive
# - tools/* → Adapt for agent usage
# - llm/index.ts → Reuse
# - api/server.ts → Archive (replaced by server-v2.ts)
```

### Phase 2: Database Migration
```bash
# Run the new schema
psql -U postgres mark_db < app/Scripts/schema-v2.sql

# Optional: Keep old tables if you want to preserve conversation history
# But don't use them for new operations
```

### Phase 3: Testing & Integration

1. **Manual testing of GitHub webhook receiver:**
   ```bash
   # Start the server
   npm run dev-v2

   # Test webhook handler
   curl -X POST http://localhost:3001/webhooks/github \
     -H "X-GitHub-Event: workflow_run" \
     -H "Content-Type: application/json" \
     -d '{
       "workflow_run": {"id": 123, "conclusion": "failure"},
       "repository": {"full_name": "mwei023/mark"},
       "workflow": {"name": "CI"},
       "head_commit": {"id": "abc123"}
     }'
   ```

2. **Check incident was created:**
   ```bash
   curl http://localhost:3001/api/incidents
   ```

3. **View GitAgent investigation:**
   ```bash
   curl http://localhost:3001/api/incidents/INC-<id>
   ```

## Key Differences from Old System

| Old (Jarvis) | New (Mark) |
|---|---|
| Voice loop → agent graph → LLM routing | Events → Gateway → Specialized agents |
| Conversation history for context | Incident tracking for audit |
| General-purpose agent | Specialized agents (Git, DevOps, CICD) |
| LLM makes routing decisions | Deterministic gateway, LLM only for reasoning |
| One tool registry | Per-agent tool definitions |
| No approval workflow | Policy-driven approval system |
| All decisions logged as text | All actions tracked as structured incidents |

## Testing Strategy

### Unit Tests (Next)
```typescript
// tests/agents/git-agent.test.ts
describe('GitAgent', () => {
  it('detects missing dependency failures', () => {
    const logs = 'npm ERR! Cannot find module "@typescript"';
    expect(agent.classifyFailure(logs)).toBe('MISSING_DEPENDENCY');
  });

  it('creates incident on workflow failure', async () => {
    const event = { type: 'github.workflow.failed', ... };
    await agent.handle(event);
    // Assert incident was created
  });
});
```

### Integration Tests (Later)
- Webhook receives real GitHub event
- GitAgent processes it
- Incident created in DB
- Correct actions logged

## Monitoring & Observability

### What to track:
1. **Event flow** - How many events/minute, types distribution
2. **Agent performance** - Incident resolution time, success rate
3. **Policy decisions** - How many auto vs. confirm vs. escalate
4. **Tool execution** - Success/failure rate per tool
5. **Approval workflow** - Approval time, approval rate

### Logs to look at:
```
[EventBus] Event INC-1234 emitted
[Gateway] github.workflow.failed → agent (git-agent)
[GitAgent] Handling github.workflow.failed...
[GitAgent] Step 1: Gathering information...
[GitAgent] Created incident INC-1234
[GitAgent] Classified as: MISSING_DEPENDENCY
[GitAgent] Attempting auto-fix...
```

## Environment Variables Needed

```bash
# Existing
DATABASE_URL=postgresql://...
API_PORT=3001
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=llama3.2:3b

# New (optional, for GitHub verification)
GITHUB_WEBHOOK_SECRET=your_secret_here
APPROVE_TIMEOUT_MS=300000

# Git operations
GIT_AUTHOR_NAME=Mark
GIT_AUTHOR_EMAIL=mark@autonomous.local
```

## Success Criteria for v0.2

- ✅ GitHub workflow failures detected
- ✅ Build failure classification working (missing deps, lint, type errors)
- ✅ Automatic fixes attempted for low-risk failures
- ✅ User approval requested for medium-risk actions
- ✅ Full incident audit trail stored
- ✅ API to view incidents and approve actions
- ⏳ Rollback state machine (high-risk, needs careful policy)

## Common Pitfalls to Avoid

1. **Don't invoke LLM eagerly** - Try heuristics first
2. **Don't execute high-risk actions automatically** - Always require approval for production
3. **Don't skip the audit trail** - Every decision must be logged
4. **Don't assume tool success** - Always check return values
5. **Don't scale agents yet** - Get GitAgent solid first

---

## FAQs

**Q: When should I use the LLM?**
A: Only when you hit an unknown situation that needs reasoning. Examples: "logs show X but I don't have a heuristic for it", "multiple strategies available, which is best?", "user submitted a vague request"

**Q: How do policies work?**
A: Rules are evaluated in order. Most specific rule that matches wins. Example: "restart in production" → check policy → "confirm" → ask user → execute on approval.

**Q: What if a tool fails?**
A: It's logged as a failed action in the incident. The agent can retry, escalate, or create a follow-up incident.

**Q: Can I override policies?**
A: Not yet. We'll add per-environment overrides later. For now, all agents follow the default PolicyEngine.

**Q: What about the voice interface?**
A: Coming in Phase 2. The voice loop will emit `user.command.received` events instead of calling agent directly. Everything routes through the event bus.
