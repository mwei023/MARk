# Mark Refactor: Cleanup Checklist

**Status:** Ready to execute
**Target:** Remove old chatbot code, keep new autonomous system
**Estimated Time:** 1-2 hours

---

## 🗑️ Delete (Old Chatbot System)

These files are superseded by the new event-driven architecture:

### Voice System
- `[DELETE]` `app/src/voice/continuous-loop.ts` - Voice loop (replaced by event-based voice input)
- `[DELETE]` `app/src/voice/stt.ts` - Speech-to-text (optional, can keep if using voice later)
- `[DELETE]` `app/src/voice/tts.ts` - Text-to-speech (optional, can keep if using voice later) 
- `[DELETE]` `app/src/voice/index.ts`

### Agent Graph (Old)
- `[DELETE]` `app/src/agent/graph.ts` - LangGraph workflow (replaced by AgentRuntime)
- `[DELETE]` `app/src/agent/nodes.ts` - LLM routing logic (replaced by Gateway)
- `[DELETE]` `app/src/agent/state.ts` - Old state management (replaced by Incident model)
- `[DELETE]` `app/src/agent/cache.ts` - Old caching (not needed)

### Agent Support (Obsolete)
- `[DELETE]` `app/src/agent/history.ts` - Conversation history (replaced by IncidentStore + IncidentActions)
- `[DELETE]` `app/src/agent/memory.ts` - Conversation memory (replaced by IncidentStore)
- `[DELETE]` `app/src/agent/commands/` - Old command system (if it exists)
- `[DELETE]` `app/src/agent/index.ts` - Old agent exports

### Monitoring System (Integrate into Agents)
- `[DELETE]` `app/src/monitoring/proactive.ts` - Replaced by DevOpsAgent
- `[DELETE]` `app/src/monitoring/` - Entire directory

### RAG System (Not for v0.2)
- `[DELETE]` `app/src/rags.ts` - RAG not needed in first milestone
- `[DELETE]` `app/src/seed-docs.ts` - Seed not needed
- `[DELETE]` `app/src/seed-knowledge.ts` - Seed not needed
- `[DELETE]` `app/src/llm/embeddings.ts` - Embeddings not needed yet

### Old Entry Points
- `[DELETE]` `app/src/agent.ts` - Old agent runner (replaced by agentRuntime)
- `[DELETE]` `app/src/repl.ts` - REPL interface (replaced by API)
- `[DELETE]` `app/src/index.ts` - Empty

### Market System (Out of Scope for v0.2)
- `[DELETE]` `app/src/tools/market/` - Market tools (not needed yet)
- `[DELETE]` `app/src/tools/market.ts` - Market snapshot tool
- `[DELETE]` `app/tools/rag_query.ts` - RAG queries not needed

### Test Files (Update Later)
- `[ARCHIVE]` `app/test-*.ts` - Move to `archive/` folder, update to test new system
  - `test-agent.ts`
  - `test-db.ts`
  - `test-embedding-dim.ts`
  - `test-imports.ts`
  - `test-integration.ts`
  - `test-market.ts`
  - `test-model-debug.ts`
  - `test-retrieve.ts`
  - `test-routing.ts`

---

## 📦 Keep (Reusable Components)

### Core Database
- `app/src/db/postgres.ts` - ✅ Reuse as-is (good pattern)
- `app/Scripts/init-db.sql` - Archive old schema, use new schema-v2.sql

### LLM Integration
- `app/src/llm/index.ts` - ✅ Reuse (good Ollama init pattern)
- `app/src/llm/embeddings.ts` - Archive (not v0.2, but keep for later)

### Security
- `app/src/security.ts` - ✅ Keep and enhance (add signature verification for webhooks)

### Tool System (Adapt)
- `app/src/tools/toolFactory.ts` - ✅ Keep
- `app/src/tools/index.ts` - ⚠️ Refactor (already removed market/rag tools)
- `app/src/tools/system_check.ts` - ⚠️ Adapt (convert to DevOpsAgent tool)
- `app/src/tools/remember.ts` - ⏳ Archive (for later)

### Routes
- `app/src/routes/` - Check if anything useful, otherwise delete

### Runtime
- `app/src/runtime/router.ts` - ⏳ Archive (local routing, not needed with event bus)

---

## 🔄 Refactor (Adapt to New System)

### Package.json
Update scripts to start new server:
```json
{
  "scripts": {
    "dev": "ts-node app/src/api/server-v2.ts",
    "dev:old": "ts-node app/src/api/server.ts",
    "test": "jest",
    "lint": "eslint app/src"
  }
}
```

### Database Schema
```bash
# Old tables (can keep for historical data):
# - conversation_history
# - jarvis_alerts

# New tables (run new schema):
psql mark_db < app/Scripts/schema-v2.sql

# Creates:
# - incidents
# - incident_actions
# - event_log (optional for sampling)
# - approval_requests
```

### API Server
- Old: `app/src/api/server.ts` (archive)
- New: `app/src/api/server-v2.ts` (in use)

---

## 📋 Cleanup Commands

```bash
# 1. Create archive directory
mkdir -p app/src/_archive

# 2. Move voice system
mv app/src/voice app/src/_archive/voice-old

# 3. Move agent system (old)
mv app/src/agent/graph.ts app/src/_archive/
mv app/src/agent/nodes.ts app/src/_archive/
mv app/src/agent/state.ts app/src/_archive/
mv app/src/agent/cache.ts app/src/_archive/
mv app/src/agent/history.ts app/src/_archive/
mv app/src/agent/memory.ts app/src/_archive/

# 4. Move old entry points
mv app/src/agent.ts app/src/_archive/
mv app/src/repl.ts app/src/_archive/

# 5. Move market/RAG
mv app/src/tools/market app/src/_archive/market-tools
mv app/src/rags.ts app/src/_archive/
mv app/src/seed-*.ts app/src/_archive/

# 6. Move monitoring
mv app/src/monitoring app/src/_archive/monitoring-old

# 7. Archive tests
mkdir -p app/_archive/tests
mv app/test-*.ts app/_archive/tests/

# 8. Clean up old API
mv app/src/api/server.ts app/src/_archive/server-old.ts

# 9. Remove empty directories
rm -rf app/src/routes app/src/agent/commands
```

---

## ✅ Verification Checklist

After cleanup:

- [ ] `app/src/voice/` deleted
- [ ] `app/src/agent/graph.ts` deleted
- [ ] `app/src/agent/nodes.ts` deleted
- [ ] `app/src/monitoring/` deleted
- [ ] `app/src/rags.ts` deleted
- [ ] `app/src/tools/market/` deleted
- [ ] `app/src/api/server-v2.ts` exists and starts
- [ ] `app/src/core/` directory has 6 files
- [ ] `app/src/agents/git-agent.ts` exists
- [ ] `app/src/webhooks/github.ts` exists
- [ ] Database schema updated: `schema-v2.sql` applied
- [ ] Old files in `_archive/` (can delete after verification)

---

## 🚀 Final Steps

1. **Run new server:**
   ```bash
   npm run dev
   ```

2. **Verify it starts:**
   ```
   ╔═══════════════════════════════════════╗
   ║    🤖 MARK v0.2 Autonomous Operations ║
   ║           API Server Started          ║
   ```

3. **Test webhook receiver:**
   ```bash
   curl -X POST http://localhost:3001/webhooks/github \
     -H "X-GitHub-Event: workflow_run" \
     -H "Content-Type: application/json" \
     -d '{"workflow_run": {"id": 123, "conclusion": "failure"}, ...}'
   ```

4. **Check incidents endpoint:**
   ```bash
   curl http://localhost:3001/api/incidents
   ```

5. **After stable, delete `_archive/`:**
   ```bash
   rm -rf app/src/_archive
   ```

---

## Notes

- **Keep git history**: Don't force-push. This cleanup is a normal refactor.
- **Test before deleting**: Verify new system works, then remove old.
- **Gradual migration**: You can run both servers during transition (different ports).
- **Backup**: Consider saving `app/src/_archive` in git for a few commits, then delete.
