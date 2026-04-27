// src/voice/stt.ts
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';

const execFilePromise = promisify(execFile);

const WHISPER_BIN = process.env.WHISPER_BIN || '/home/mwei/jarvis-core/bin/whisper.cpp/main';
const WHISPER_MODEL = process.env.WHISPER_MODEL || '/home/mwei/jarvis-core/models/ggml-small.en.bin';

// src/voice/stt.ts - UPDATED for whisper-cli output
// src/voice/stt.ts - UPDATED for whisper-cli
export const transcribe = async (audioPath: string): Promise<string> => {
  const WHISPER_BIN = process.env.WHISPER_BIN || '/home/mwei/jarvis-core/bin/whisper.cpp/build/bin/whisper-cli';
  const WHISPER_MODEL = process.env.WHISPER_MODEL || '/home/mwei/jarvis-core/models/ggml-small.en.bin';
  
  try {
    const { stdout, stderr } = await execFilePromise(WHISPER_BIN, [
      '--model', WHISPER_MODEL,  // Use --model not -m
      '--file', audioPath,        // Use --file not -f
      // --language en is optional (small.en is English-only)
    ], {
  env: { ...process.env, LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH },
      timeout: 60000,
    });
    
    // Parse output: whisper-cli prints timestamps like [00:00:00.000 --> ...]   text
    const lines = (stdout + stderr).split('\n');
    const text = lines
      .filter(line => /^\[\d{2}:\d{2}:\d{2}\.\d{3}/.test(line))
      .map(line => line.replace(/^\[.*?\]\s+/, '').trim())
      .join(' ')
      .trim();
    
    return text || stdout.trim();
    
  } catch (error: any) {
    console.error('[STT Error]', error.message);
    throw new Error(`Transcription failed: ${error.message}`);
  }
};