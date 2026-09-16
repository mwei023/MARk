import * as dotenv from 'dotenv';
import { join } from 'path';
dotenv.config({ path: join(process.cwd(), '.env') });

import { ChatOllama } from '@langchain/ollama';

const main = async () => {
  console.log('OLLAMA_HOST:', process.env.OLLAMA_HOST);
  console.log('OLLAMA_MODEL:', process.env.OLLAMA_MODEL);
  
  const model = new ChatOllama({
  model: process.env.OLLAMA_MODEL || "llama3.2:3b",
  baseUrl: process.env.OLLAMA_HOST,
}).bind({
  system: SYSTEM_PROMPT, // ← Critical: bind the system prompt
});
  
  console.log('Model created:', model ? 'YES' : 'NO');
  
  const res = await model.invoke([{ role: 'user', content: 'say hi' }]);
  console.log('Response:', res.content);
};

main().catch(console.error);
