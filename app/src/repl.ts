// src/repl.ts - Interactive Jarvis REPL (FIXED)
import * as dotenv from "dotenv";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// Load .env from project root
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, "../.env") });

import { runAgent } from "./agent";

const showThinking = () => process.stdout.write("🤖 Jarvis: ⋯ ");
const clearThinking = () => process.stdout.write("\r🤖 Jarvis: ");

const animateThinking = () => {
  let dots = 0;
  const interval = setInterval(() => {
    process.stdout.write(`\r🤖 Jarvis${'.'.repeat(dots)}`);
    dots = (dots + 1) % 4;
  }, 300);
  return () => clearInterval(interval);
};

// Simple REPL loop
const repl = async () => {
  console.log("🤖 Jarvis is listening. Type 'quit' or 'exit' to stop.\n");
  
  const readline = await import("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "🗣️  You: ",
  });
  
  rl.prompt();
  
  for await (const line of rl) {
    const input = line.trim();
    
    if (["quit", "exit", "q"].includes(input.toLowerCase())) {
      console.log("👋 Jarvis: Ciao, Mwei. Me Bomboclat.");
      rl.close();
      break;
    }
    
    if (!input) {
      rl.prompt();
      continue;
    }
    
    try {
        const stopThinking = animateThinking();
        process.stdout.write("🤖 ");
        const response = await runAgent(input, "mwei");
        stopThinking();
        console.log(response + "\n");
    } catch (error: any) {
        console.log(`⚠️ Error: ${error.message}\n`);
    }
    
    rl.prompt();
  }
};

repl().catch(console.error);