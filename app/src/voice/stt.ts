// src/voice/stt.ts
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';

const execFilePromise = promisify(execFile);

const WHISPER_BIN = process.env.WHISPER_BIN || '/home/mwei/jarvis-core/bin/whisper.cpp/main';
const WHISPER_MODEL = process.env.WHISPER_MODEL || '/home/mwei/jarvis-core/models/ggml-small.en.bin';

// src/voice/stt.ts - UPDATED for whisper-cli output
export const transcribe = async (audioPath: string): Promise<string> => {
  const WHISPER_BIN = process.env.WHISPER_BIN || '/home/mwei/jarvis-core/bin/whisper-bin';
  const WHISPER_MODEL = process.env.WHISPER_MODEL || '/home/mwei/jarvis-core/models/ggml-small.en.bin';
  
  try {
    const { stdout, stderr } = await execFilePromise(WHISPER_BIN, [
      '-m', WHISPER_MODEL,
      '-f', audioPath,
      '-l', 'en',  // Force English
    ], {
      timeout: 60000, // 60 second timeout for large models
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    
    // Parse whisper-cli output: extract text from timestamp lines
    // Format: [00:00:00.000 --> 00:00:02.640]   Hello Mark, can you hear me?
    const lines = (stdout + stderr).split('\n');
    const transcription = lines
      .filter(line => /^\[\d{2}:\d{2}:\d{2}\.\d{3}/.test(line)) // Match timestamp lines
      .map(line => line.replace(/^\[.*?\]\s+/, '').trim()) // Remove timestamp prefix
      .join(' ')
      .trim();
    
    if (!transcription) {
      // Fallback: return raw stdout if no timestamp lines found
      const clean = (stdout + stderr)
        .replace(/WARNING:.*deprecated.*$/gm, '')
        .replace(/whisper_.*?:.*$/gm, '') // Remove whisper logs
        .trim();
      if (clean) return clean;
      throw new Error('No transcription found in output');
    }
    
    return transcription;
    
  } catch (error: any) {
    console.error('[STT Error]', {
      cmd: error.cmd,
      message: error.message,
      stderr: error.stderr?.slice(0, 200), // First 200 chars
    });
    throw new Error(`Transcription failed: ${error.message}`);
  }
};