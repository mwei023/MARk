import 'dotenv/config';
import { runAgent } from './src/agent';

(async () => {
  console.log("📊 Market Intelligence System Test\n");
  
  // Test 1: Price snapshot
  console.log("1️⃣ Testing market snapshot...");
  const snapshot = await runAgent("what's bitcoin price?", "mwei");
  console.log("Result:", snapshot.slice(0, 150));
  console.log();
  
  // Test 2: Market brief with analysis
  console.log("2️⃣ Testing market brief (with LLM reasoning)...");
  const brief = await runAgent("give me a brief on bitcoin", "mwei");
  console.log("Result:", brief.slice(0, 200));
  console.log();
  
  process.exit(0);
})().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});
