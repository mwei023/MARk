
---

## 🎁 Bonus: Quick Reference Commands

```bash
# Save this as ~/jarvis-core/cheatsheet.sh

#!/bin/bash
# Jarvis-Core Quick Reference

echo "🧠 Test agent brain:"
echo "  npx tsx src/test-agent.ts"

echo "🌱 Seed knowledge base:"
echo "  npx tsx src/seed-docs.ts"

echo "🔍 Test database connection:"
echo "  npx tsx src/test-db.ts"

echo "📊 Check infrastructure:"
echo "  docker compose -f ../docker-compose.yml ps"

echo "🦙 Verify Ollama models:"
echo "  curl -s http://localhost:11434/api/tags | jq '.models[].name'"

echo "🔐 View recent audit logs:"
echo "  tail -20 ../audit.log"
echo "  # Or query PostgreSQL:"
echo "  docker compose exec postgres psql -U mwei -d jarvis_memory -c \"SELECT action, status, created_at FROM audit_logs ORDER BY created_at DESC LIMIT 10;\""

echo "🛠️  Type check:"
echo "  npx tsc --noEmit"

echo "🎉 Celebrate a win:"
echo "  echo 'I built this.' && sleep 2 && echo 'And I'm proud.'"