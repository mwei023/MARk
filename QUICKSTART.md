# ⚡ Quick Start: Get Mark Running In 5 Minutes

## Prerequisites
- PostgreSQL running with `mark_db` database
- Node.js 18+
- Ollama running (optional, for LLM reasoning layer later)

---

## Step 1: Database Setup (2 min)

```bash
# Create the incident tracking schema
psql mark_db < app/Scripts/schema-v2.sql

# Verify tables were created
psql mark_db -c "\dt"
```

**Expected output:**
```
              List of relations
 Schema | Name                 | Type  | Owner
--------+----------------------+-------+-------
 public | incidents            | table | mwei
 public | incident_actions     | table | mwei
 public | event_log            | table | mwei
 public | approval_requests    | table | mwei
```

---

## Step 2: Update package.json (1 min)

```bash
# Make sure these scripts are in your package.json
cat >> app/package.json << 'EOF'
{
  "scripts": {
    "dev": "ts-node app/src/api/server-v2.ts",
    "dev:old": "ts-node app/src/api/server.ts",
    "test": "jest"
  }
}
EOF
```

---

## Step 3: Start the Server (1 min)

```bash
cd app
npm run dev
```

**Expected output:**
```
    ╔═══════════════════════════════════════╗
    ║    🤖 MARK v0.2 Autonomous Operations ║
    ║           API Server Started          ║
    ╠═══════════════════════════════════════╣
    ║  Port: 3001                           ║
    ║  Event Bus: Active                    ║
    ║  Agents: Ready                        ║
    ╚═══════════════════════════════════════╝
```

---

## Step 4: Test the System (1 min)

### Health Check
```bash
curl http://localhost:3001/api/health
```

### Create a Test Incident via GitHub Webhook
```bash
curl -X POST http://localhost:3001/webhooks/github \
  -H "X-GitHub-Event: workflow_run" \
  -H "Content-Type: application/json" \
  -d '{
    "workflow_run": {
      "id": 12345,
      "conclusion": "failure",
      "head_sha": "abc123def456",
      "head_branch": "main"
    },
    "workflow": {
      "name": "CI"
    },
    "repository": {
      "full_name": "mwei023/mark"
    }
  }'
```

### View Incidents
```bash
curl http://localhost:3001/api/incidents | jq
```

**Expected response:**
```json
{
  "success": true,
  "count": 1,
  "incidents": [
    {
      "id": "INC-1693...",
      "title": "Build failed: mwei023/mark",
      "status": "investigating",
      "severity": "warning",
      "assignedAgent": "git-agent",
      "actions": [...]
    }
  ]
}
```

### View Incident Details
```bash
curl http://localhost:3001/api/incidents/INC-1693... | jq
```

---

## ✅ Verification Checklist

- [ ] Server started (port 3001)
- [ ] Health check returns `ok`
- [ ] Can POST to `/webhooks/github`
- [ ] Can GET `/api/incidents`
- [ ] Incident was created automatically
- [ ] Git agent classified the failure
- [ ] Actions are logged in incident

---

## 🔥 Common Issues & Fixes

### Issue: Connection refused to PostgreSQL
```
Error: connect ECONNREFUSED 127.0.0.1:5432
```

**Fix:**
```bash
# Start PostgreSQL
brew services start postgresql
# or
docker run --name postgres -e POSTGRES_PASSWORD=password -d postgres
```

### Issue: Database schema not found
```
Error: relation "incidents" does not exist
```

**Fix:**
```bash
# Run schema migration again
psql mark_db < app/Scripts/schema-v2.sql
```

### Issue: Module not found errors
```
Error: Cannot find module '@langchain/core'
```

**Fix:**
```bash
cd app
npm install
```

### Issue: 404 on webhook POST
```
Cannot POST /webhooks/github
```

**Fix:** Make sure you're using the `-v2` server:
```bash
npm run dev  # Should use server-v2.ts
```

---

## 📊 What's Running

```
Event Bus
  ↓
  ├→ GitHub Webhook Receiver (listening on /webhooks/github)
  │   └→ Converts GitHub events to internal events
  │
  ├→ Gateway Classifier
  │   └→ Routes to appropriate agent
  │
  └→ Agent Runtime
      └→ GitAgent 
          ├→ Classifies build failures
          ├→ Suggests fixes
          └→ Logs to Incident Store (PostgreSQL)

API Endpoints:
  GET  /api/health          - Server health
  GET  /api/incidents       - List all incidents
  GET  /api/incidents/:id   - Get incident details
  POST /api/approve         - Approve/deny action
  POST /api/command         - Send user command
  POST /webhooks/github     - GitHub webhook
```

---

## 🧪 Test Scenarios

### Scenario 1: Build Failure Detection
```bash
# Send a workflow failure event
curl -X POST http://localhost:3001/webhooks/github \
  -H "X-GitHub-Event: workflow_run" \
  -H "Content-Type: application/json" \
  -d '{
    "workflow_run": { "conclusion": "failure", ... },
    "repository": { "full_name": "your/repo" }
  }'

# Check incident was created
curl http://localhost:3001/api/incidents | jq '.incidents[0]'

# Expected: GitAgent investigating the failure
```

### Scenario 2: View Investigation Results
```bash
# Get incident ID from previous response
INCIDENT_ID="INC-..."

# View full investigation
curl http://localhost:3001/api/incidents/$INCIDENT_ID | jq '.incident.actions'

# Expected: Actions showing logs fetched, diff analyzed, failure classified
```

### Scenario 3: User Command
```bash
# Send a command
curl -X POST http://localhost:3001/api/command \
  -H "Content-Type: application/json" \
  -d '{
    "command": "check git status",
    "userId": "me",
    "source": "api"
  }'

# Check if command was processed
curl http://localhost:3001/api/incidents | jq '.incidents[-1]'
```

---

## 🎯 Next Steps

1. **Verify this works** - Complete all verification items above
2. **Read IMPLEMENTATION_GUIDE.md** - Understand the architecture
3. **Implement DevOpsAgent** - Handle health checks & rollback (next milestone)
4. **Delete old code** - Follow CLEANUP_CHECKLIST.md
5. **Add more agents** - CICD, monitoring, etc.

---

## 📚 Documentation Map

- **New?** Start here → `SYSTEM_COMPLETE.md`
- **Architecture?** → `ARCHITECTURE.md`
- **Steps to build?** → `IMPLEMENTATION_GUIDE.md`
- **Cleanup?** → `CLEANUP_CHECKLIST.md`
- **Get running fast?** → **You are here** (`QUICKSTART.md`)

---

## 💬 Debugging

Enable verbose logging:
```bash
export DEBUG=*
npm run dev
```

Check logs:
```bash
# In another terminal
tail -f logs/*.log
```

Database queries:
```bash
psql mark_db
SELECT * FROM incidents ORDER BY created_at DESC LIMIT 1;
SELECT * FROM incident_actions WHERE incident_id = 'INC-...';
```

---

**Status:** ✅ Ready to go

**Next:** Run the server and test!
