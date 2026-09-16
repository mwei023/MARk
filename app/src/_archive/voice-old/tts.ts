// Replace the playAudio function with this PulseAudio-aware version:
export const playAudio = async (filePath: string, retries = 3): Promise<void> => {
  // Try paplay first (PulseAudio), fallback to aplay
  const players = ['paplay', 'aplay'];
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    for (const player of players) {
      try {
        // Check if player exists
        await execPromise(`which ${player}`, { stdio: 'ignore' }).catch(() => {
          throw new Error(`${player} not found`);
        });
        
        const cmd = player === 'paplay' 
          ? `paplay "${filePath}"`
          : `aplay -q "${filePath}"`;
          
        await execPromise(cmd, {
          timeout: 30000,
          stdio: ['ignore', 'ignore', 'pipe']
        });
        console.log(`✅ Audio played via ${player}: ${filePath}`);
        return;
      } catch (error: any) {
        // If both players fail on last attempt, give up gracefully
        if (player === 'aplay' && attempt === retries) {
          console.warn(`⚠️ Audio playback failed after ${retries} attempts`);
          console.warn(`💡 Tip: Close other audio apps or run: sudo alsa force-reload`);
          return; // Don't crash — let the loop continue
        }
      }
    }
    // Exponential backoff between retry rounds
    await new Promise(res => setTimeout(res, attempt * 300));
  }
};