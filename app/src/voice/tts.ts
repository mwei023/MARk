// src/voice/tts.ts - SIMPLIFIED: Uses system aplay, no native modules
import { exec } from 'child_process';
import { promisify } from 'util';

const execPromise = promisify(exec);

export const speak = async (text: string, outputPath: string): Promise<void> => {
  const PIPER_MODEL = process.env.PIPER_MODEL || '/home/mwei/jarvis-core/models/piper/en_US-lessac-medium.onnx';
  
  try {
    // Escape text for shell safety
    const escapedText = text
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\$/g, '\\$')
      .replace(/`/g, '\\`');
    
    // Generate WAV using Piper via shell pipe (reliable stdin handling)
    const command = `echo "${escapedText}" | piper -m "${PIPER_MODEL}" -f "${outputPath}"`;
    
    await execPromise(command, {
      env: { ...process.env, LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH },
      timeout: 30000, // 30 second timeout
    });
    
    console.log(`✅ TTS Generated: ${outputPath}`);
  } catch (error: any) {
    console.error('[Piper Error]', error.stderr || error.message);
    throw new Error(`Speech synthesis failed: ${error.message}`);
  }
};

// Play audio using system aplay (no Node.js native modules)
export const playAudio = async (filePath: string): Promise<void> => {
  try {
    await execPromise(`aplay "${filePath}"`, { 
      timeout: 30000,
      stdio: ['ignore', 'ignore', 'pipe'] // Suppress aplay output
    });
    console.log(`✅ Audio played: ${filePath}`);
  } catch (error: any) {
    console.warn('⚠️ Audio playback failed:', error.message);
    console.warn('💡 Try: sudo apt install alsa-utils');
    // Don't throw - let the loop complete even if playback fails
  }
};