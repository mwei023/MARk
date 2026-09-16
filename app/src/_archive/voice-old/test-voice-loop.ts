// src/voice/test-voice-loop.ts
import * as dotenv from 'dotenv';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { transcribe } from './stt';
import { speak, playAudio } from './tts';
import { runAgent } from '../agent';

// Load env
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '../../.env') });

const main = async () => {
  console.log('🎤 Testing full voice loop...\n');
  
  // 1. Transcribe
  console.log('🗣️  Transcribing audio...');
  const text = await transcribe('/tmp/whisper_input.wav');
  console.log(`🗣️  You: "${text}"\n`);
  
  // 2. Process with agent
  console.log('🧠 Processing with Jarvis...');
  const response = await runAgent(text, 'mwei');
  console.log(`🤖 Jarvis: ${response}\n`);
  
  // 3. Speak response
  console.log('🔊 Speaking response...');
  const outputPath = `/tmp/jarvis_response_${Date.now()}.wav`;
  await speak(response, outputPath);
  await playAudio(outputPath);
  
  console.log('\n✅ Voice loop complete!');
};

main().catch(console.error);