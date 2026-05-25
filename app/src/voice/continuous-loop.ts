// src/voice/continuous-loop.ts
import * as dotenv from 'dotenv';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';
import { unlink } from 'fs/promises';
import { transcribe } from './stt';
import { speak, playAudio } from './tts';
import { runAgent } from '../agent';
import * as readline from 'readline';
import { runHealthChecks, logAlert, Alert, type CommandKey } from '../monitoring/proactive';

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

// Main continuous loop
const continuousLoop = async () => {
  await checkAudioDependencies();

  console.log('');
  console.log('🤖 JARVIS is ready.');
  console.log('─────────────────────────────────────');
  console.log('Press ENTER to speak, Ctrl+C to quit.');
  console.log('─────────────────────────────────────');
  console.log('');

  // Handle Ctrl+C gracefully
  const cleanup = async () => {
    if (monitorInterval) clearInterval(monitorInterval);
    console.log('\n\n👋 Jarvis: Goodbye Mwei. Standing by.');
    process.exit(0);
  };
  process.on('SIGINT', cleanup);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // State flags
  let isProcessing = false;
  let awaitingConfirmation: { command: CommandKey; userId: string } | null = null;
  let awaitingAlertResponse: { alert: Alert; userId: string } | null = null;

  // 🔍 Start proactive monitoring (checks every 5 minutes)
  console.log('🔍 Starting proactive monitoring (checks every 5 minutes)...');
  const monitorInterval = setInterval(async () => {
    try {
      const alert = await runHealthChecks();
      if (alert && !awaitingAlertResponse) {
        console.log(`⚠️  Alert: ${alert.message}`);
        
        // Speak the alert + suggestion
        const alertMessage = `⚠️  ${alert.message}. ${alert.suggestion || ''}`;
        const outputPath = `/tmp/jarvis_alert_${Date.now()}.wav`;
        await speak(alertMessage, outputPath);
        await playAudio(outputPath);
        await unlink(outputPath).catch(() => {});
        
        // Log the alert
        await logAlert(alert, 'mwei', false);
        
        // Set flag to handle response in next voice interaction
        awaitingAlertResponse = { alert, userId: 'mwei' };
      }
    } catch (error) {
      console.error('[Monitor] Error:', error);
    }
  }, 5 * 60 * 1000);

  // Keep looping forever
  while (true) {
    // Declare response at top of loop scope
    let response: string = "I'm not sure how to help with that yet.";

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

      // 🔔 Handle pending alert response FIRST
      if (awaitingAlertResponse) {
        const { alert, userId } = awaitingAlertResponse;
        const lower = text.toLowerCase();
        
        if (lower.includes('yes') || lower.includes('sure') || lower.includes('go ahead')) {
          // Execute suggestion based on alert type
          let actionResponse = '';
          if (alert.type === 'disk' && alert.suggestion?.includes('large files')) {
            actionResponse = await runAgent('find large files', userId);
          } else if (alert.type === 'memory' && alert.suggestion?.includes('processes')) {
            actionResponse = await runAgent('show top processes', userId);
          } else if (alert.type === 'cloudflared' && alert.suggestion?.includes('restart')) {
            actionResponse = await runAgent('restart cloudflared', userId);
          } else {
            actionResponse = "I can help with that — what would you like to do?";
          }
          
          await logAlert(alert, userId, true); // Mark as resolved
          awaitingAlertResponse = null;
          response = actionResponse;
          
        } else if (lower.includes('no') || lower.includes('later') || lower.includes('dismiss')) {
          await logAlert(alert, userId, true); // Mark as dismissed
          awaitingAlertResponse = null;
          response = "✅ Alert dismissed. I'll check again later.";
          
        } else {
          // Unclear response — re-prompt
          response = `❓ ${alert.suggestion} (Say "yes" or "no")`;
          // Keep awaitingAlertResponse for next iteration
          isProcessing = false;
          continue;
        }
        
      } 
      // 🔐 Handle pending command confirmation
      else if (awaitingConfirmation) {
        const { command, userId } = awaitingConfirmation;
        const lower = text.toLowerCase();
        
        if (lower.includes('yes')) {
          // Execute the pending command via agent
          response = await runAgent(`execute ${command}`, userId);
          awaitingConfirmation = null;
        } else {
          response = "🚫 Command cancelled.";
          awaitingConfirmation = null;
        }
        
      } 
      // 🧠 Normal flow: run agent
      else {
        const agentResult = await runAgent(text, 'mwei');
        response = typeof agentResult === 'string' 
          ? agentResult 
          : agentResult?.messages?.[0] || response;
        
        // Check if agent wants confirmation for a command
        if (response.includes('Say "yes') && response.includes('to confirm')) {
          // Extract command key from response (simple parse)
          const cmdMatch = response.match(/restart (\w+)/);
          if (cmdMatch?.[1]) {
            awaitingConfirmation = { command: cmdMatch[1] as CommandKey, userId: 'mwei' };
          }
        }
      }

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