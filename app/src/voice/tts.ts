// src/voice/tts.ts
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { createWriteStream, createReadStream } from 'fs';
import { pipeline } from 'stream/promises';

const execFilePromise = promisify(execFile);

// src/voice/tts.ts - FIX THE PATHS
const PIPER_BIN = process.env.PIPER_BIN || '/home/mwei/jarvis-core/bin/piper/piper';
const PIPER_MODEL = process.env.PIPER_MODEL || '/home/mwei/jarvis-core/models/piper/en_US-lessac-medium.onnx';

export const speak = async (text: string, outputPath: string = '/tmp/piper_out.wav'): Promise<void> => {
  try {
    const { stdout, stderr } = await execFilePromise(PIPER_BIN, [
      '-m', PIPER_MODEL,  // ← Direct path, no join()
      '-f', outputPath,
    ], {
      input: text,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    
    if (stderr) console.debug('[Piper stderr]', stderr);
    console.log(`✅ TTS: Generated ${outputPath}`);
  } catch (error: any) {
    console.error('[TTS Error]', error.message);
    throw new Error(`Speech synthesis failed: ${error.message}`);
  }
};

// Optional: Play the generated WAV file
export const playAudio = async (audioPath: string): Promise<void> => {
  const { default: Speaker } = await import('speaker');
  const { createReadStream } = await import('fs');
  
  return new Promise((resolve, reject) => {
    const speaker = new Speaker({
      channels: 1,
      bitDepth: 16,
      sampleRate: 22050,
    });
    
    createReadStream(audioPath)
      .pipe(speaker)
      .on('finish', resolve)
      .on('error', reject);
  });
};