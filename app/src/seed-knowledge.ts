// src/scripts/seed-knowledge.ts
import { ingestDocument } from '../../rags';
import * as dotenv from 'dotenv';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load env vars from project root
dotenv.config({ path: join(__dirname, '../../.env') });

const seed = async () => {
  console.log("🌱 Seeding knowledge base...\n");
  
  try {
    await ingestDocument(
      "pgvector uses cosine similarity (<=>) for vector search. Install with: CREATE EXTENSION vector; Query with: ORDER BY embedding <-> $1",
      { source: 'notes', topic: 'pgvector', date: '2026-04' }
    );
    
    await ingestDocument(
      "Cloudflare tunnel name is 'mwei-tunnel'. Config file: /etc/cloudflared/config.yml. Restart with: systemctl restart cloudflared",
      { source: 'ops', topic: 'cloudflare', date: '2026-04' }
    );
    
    await ingestDocument(
      "Mpesa Daraja API: Sandbox URL is https://sandbox.safaricom.co.ke, Production is https://api.safaricom.co.ke. Always use Bearer token auth.",
      { source: 'code-notes', topic: 'mpesa', date: '2026-03' }
    );
    
    console.log("\n✅ Seeded 3 documents. Ready to query!");
  } catch (error) {
    console.error("❌ Seed failed:", error);
    process.exit(1);
  }
};

seed();