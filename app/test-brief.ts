import "dotenv/config";
import { runAgent } from './src/agent';

(async () => {
  console.log("🔍 Testing market_brief tool...\n");
  
  const result = await runAgent("give me a brief on bitcoin", "mwei");
  console.log("🤖", result);
})();
