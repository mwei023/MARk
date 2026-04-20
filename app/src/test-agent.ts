// src/test-agent.ts
import { runAgent } from "./agent";
import * as dotenv from "dotenv";
import { join } from "path";

dotenv.config({ path: join(__dirname, "../.env") });

const main = async () => {
  console.log("🧠 Jarvis: RAG + Context Test\n");
  
  // Test 1: RAG query (make sure you have docs ingested first!)
  console.log(`🗣️  User: "What did I learn about pgvector?"`);
  let response = await runAgent("What did I learn about pgvector?", "mwei");
  console.log(`🤖 Jarvis: ${response}\n`);
  
  // Test 2: Conversational follow-up
  console.log(`🗣️  User: "Tell me more about that"`);
  response = await runAgent("Tell me more about that", "mwei");
  console.log(`🤖 Jarvis: ${response}\n`);
  
  // Test 3: Context switch (should NOT confuse topics)
  console.log(`🗣️  User: "Are my Docker containers running?"`);
  response = await runAgent("Are my Docker containers running?", "mwei");
  console.log(`🤖 Jarvis: ${response}\n`);
  
  console.log("✅ Test complete. Check audit.log and conversation_history table.");
};

main().catch(console.error);