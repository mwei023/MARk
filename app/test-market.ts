import * as dotenv from 'dotenv';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '.env') });

(async () => {
  // Import AFTER dotenv config is loaded
  const { runAgent } = await import('./src/agent');
  
  console.log("🔍 Testing market snapshot tool...\n");
  const result = await runAgent("what's BTC price?", "mwei");
  console.log("🤖", result);
})();

