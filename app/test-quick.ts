import * as dotenv from 'dotenv';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '.env') });

(async () => {
  const { toolsRegistry } = await import('./src/tools');
  
  console.log("✅ Tools loaded successfully:");
  Object.keys(toolsRegistry).forEach(name => {
    console.log(`  - ${name}`);
  });
})();
