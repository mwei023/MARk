// src/voice/stt.ts - FINAL CORRECTED VERSION
import { execFile } from 'child_process';
import { promisify } from 'util';
import { access, constants } from 'fs/promises';

const execFilePromise = promisify(execFile);

// Use the non-deprecated binary
const WHISPER_BIN = process.env.WHISPER_BIN || 
  '/home/mwei/jarvis-core/bin/whisper.cpp/build/bin/whisper-cli';
const WHISPER_MODEL = process.env.WHISPER_MODEL || 
  '/home/mwei/jarvis-core/models/ggml-small.en.bin';

const validateModel = async (modelPath: string): Promise<void> => {
  try {
    await access(modelPath, constants.F_OK);
  } catch {
    throw new Error(
      `🎯 Whisper model not found at: ${modelPath}\n` +
      `💡 Download it with:\n` +
      `   mkdir -p /home/mwei/jarvis-core/models\n` +
      `   curl -Lo /home/mwei/jarvis-core/models/ggml-small.en.bin \\\n` +
      `     https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin`
    );
  }
};

export const transcribe = async (audioPath: string): Promise<string> => {
  await validateModel(WHISPER_MODEL);

  try {
    const { stdout, stderr } = await execFilePromise(
      WHISPER_BIN,
      [
        '-m', WHISPER_MODEL,
        '-f', audioPath,
        '--no-timestamps',    // Clean text output
        '-l', 'en',           // Force English for small.en model
        '--no-gpu',           // Ensure CPU-only (avoid CUDA issues on Kali)
      ],
      {
        env: { ...process.env, LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH || '' },
        timeout: 60000,
        maxBuffer: 10 * 1024 * 1024,
      }
    );

    // whisper-cli outputs transcription to stdout when --no-timestamps is used
    // But may include progress markers like "transcribe: 100%" in stderr
    const rawOutput = stdout.trim();
    
    // Filter out common progress artifacts if any slip into stdout
    const cleanText = rawOutput
      .split('\n')
      .map(line => line.trim())
      .filter(line => 
        line.length > 0 && 
        !line.startsWith('transcribe:') && 
        !line.startsWith('log:') &&
        !line.startsWith('WARNING:')
      )
      .join(' ')
      .trim();

    if (!cleanText) {
      // Provide debugging context
      const stderrHint = stderr?.substring(0, 300)?.replace(/\n/g, ' ') || 'no stderr';
      throw new Error(
        `Empty transcription result.\n` +
        `🔍 Debug hints:\n` +
        `   • stdout: "${rawOutput.substring(0, 100)}..."\n` +
        `   • stderr: "${stderrHint}..."\n` +
        `💡 Try: speak louder, check microphone permissions, or test with a longer audio clip`
      );
    }

    return cleanText;

  } catch (error: any) {
    if (error.code === 'ENOENT') {
      throw new Error(`🔧 Whisper binary not found at: ${WHISPER_BIN}\n` +
        `💡 Build whisper.cpp: cd /home/mwei/jarvis-core/bin/whisper.cpp && make`);
    }
    if (error.code === 'ETIMEDOUT') {
      throw new Error(`⏱️  Transcription timed out after 60s. Try a shorter clip or ggml-tiny.en.bin model.`);
    }
    
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[STT Error]', message);
    throw new Error(`Transcription failed: ${message}`);
  }
};