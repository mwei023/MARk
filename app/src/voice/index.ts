// src/voice/index.ts
import { transcribe } from './stt';
import { speak, playAudio } from './tts';
import { runAgent } from '../agent';
import { join } from 'path';
import { tmpdir } from 'os';

export const voiceCommand = async (audioPath: string, userId: string = 'mwei'): Promise<void> => {
  try {
    // 1. Transcribe speech to text
    console.log('🎤 Listening...');
    const text = await transcribe(audioPath);
    console.log(`🗣️  You: "${text}"`);
    
    // 2. Process with agent
    const response = await runAgent(text, userId);
    console.log(`🤖 Jarvis: ${response}`);
    
    // 3. Speak response aloud
    const outputPath = join(tmpdir(), `jarvis_response_${Date.now()}.wav`);
    await speak(response, outputPath);
    await playAudio(outputPath);
    
  } catch (error: any) {
    console.error('[Voice Command Error]', error.message);
    // Fallback: speak error message
    await speak(`Sorry, I encountered an error: ${error.message}`);
  }
};