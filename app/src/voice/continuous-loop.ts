// src/voice/continuous-loop.ts
import * as dotenv from 'dotenv';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFile, exec } from 'child_process';
import { promisify } from 'util';
import { unlink } from 'fs/promises';
import { transcribe } from './stt';
import { speak, playAudio } from './tts';
import { runAgent } from '../agent';
import * as readline from 'readline';

const execPromise = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '../../.env') });

const RECORD_SECONDS = parseInt(process.env.RECORD_SECONDS || '5');
const AUDIO_INPUT = '/tmp/jarvis_input.wav';

// Pre-flight: Ensure required system dependencies are available
const checkAudioDependencies = async (): Promise<void> => {
  try {
    await execPromise('which arecord');
  } catch {
    console.error('❌ arecord not found. Install with: sudo apt install alsa-utils');
    process.exit(1);
  }
};

// Record audio for N seconds using arecord
const recordAudio = async (seconds: number): Promise<void> => {
  console.log(`🎙️  Recording for ${seconds} seconds...`);
  await execPromise(
    `arecord -d ${seconds} -f cd -r 16000 -c 1 ${AUDIO_INPUT}`
  );
};

let awaitingConfirmation: { command: CommandKey; userId: string } | null = null;

// Main continuous loop
const continuousLoop = async () => {
  // Validate environment before starting
  await checkAudioDependencies();

  console.log('');
  console.log('🤖 JARVIS is ready.');
  console.log('─────────────────────────────────────');
  console.log('Press ENTER to speak, Ctrl+C to quit.');
  console.log('─────────────────────────────────────');
  console.log('');

  // Handle Ctrl+C gracefully
  process.on('SIGINT', async () => {
    console.log('\n\n👋 Jarvis: Goodbye Mwei. Standing by.');
    process.exit(0);
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // Concurrency lock: prevent overlapping interactions
  let isProcessing = false;

  // Keep looping forever
while (true) {
  // ✅ Declare ALL response variables at the TOP of the loop
  let response: string = "I'm not sure how to help with that yet.";
  let response2: string = ""; // ← Add this if you're using response2 anywhere

  try {
    await new Promise<void>((resolve) => {
      rl.question('⏎  Press ENTER to speak...', () => resolve());
    });

    if (isProcessing) {
      console.log('⏳ Jarvis is still processing... please wait.\n');
      continue;
    }
    isProcessing = true;

    // Step 1: Record
    await recordAudio(RECORD_SECONDS);
    console.log('🧠 Processing...\n');

    // Step 2: Transcribe
    const text = await transcribe(AUDIO_INPUT);
    if (!text || text.trim().length < 2) {
      console.log("🤖 Jarvis: I didn't catch that. Try again.\n");
      continue;
    }
    console.log(`🗣️  You: "${text}"`);

    // Step 3: Think
    const agentResult = await runAgent(text, 'mwei');
    
    // Handle if runAgent returns an object or string
    response = typeof agentResult === 'string' 
      ? agentResult 
      : agentResult?.messages?.[0] || response;

    console.log(`🤖 Jarvis: ${response}\n`);

    // Step 4: Speak
    const outputPath = `/tmp/jarvis_response_${Date.now()}.wav`;
    await speak(response, outputPath);
    await playAudio(outputPath);
    await unlink(outputPath).catch(err => 
      console.warn('⚠️  Cleanup failed:', err.message)
    );

  } catch (error: any) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('⚠️ Error:', message);
    response = "⚠️  I encountered an error. Please try again.";
  } finally {
    isProcessing = false;
  }
}
};

// Entry point
continuousLoop().catch((error) => {
  const message = error instanceof Error ? error.message : 'Fatal error';
  console.error('💥 Fatal startup error:', message);
  process.exit(1);
});