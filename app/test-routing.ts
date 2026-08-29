import 'dotenv/config';
import { runAgent } from './src/agent';

(async () => {
  console.log("Testing market brief routing...\n");

  // This should route to market_brief, NOT rag_query
  const result = await runAgent("give me a brief on bitcoin", "mwei");
  console.log("Result:", result.slice(0, 200));
})().catch(console.error);
