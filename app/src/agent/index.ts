// src/agent/index.ts - ADD THIS LOGIC
import { executeCommand, ALLOWED_COMMANDS, CommandKey } from './commands/terminal';

export const runAgent = async (input: string, userId: string): Promise<string> => {
  const lower = input.toLowerCase().trim();
  
  // 🔍 Simple intent matching (expand with NLP later)
  const commandMap: Record<string, CommandKey> = {
    'list files': 'list files',
    'show files': 'list files',
    'what files': 'list files',
    'disk space': 'check disk',
    'check disk': 'check disk',
    'memory usage': 'check memory',
    'network status': 'check network',
    'restart cloudflare': 'restart cloudflared',
    'restart cloudflared': 'restart cloudflared',
  };

  const matchedCommand = Object.entries(commandMap).find(([key]) => 
    lower.includes(key)
  )?.[1];

  if (matchedCommand) {
    const config = ALLOWED_COMMANDS[matchedCommand];
    
    // 🔒 Require confirmation for destructive actions
    if (config.requiresConfirmation) {
      return `⚠️  This will restart ${config.args[1]}. Say "yes, restart" to confirm.`;
    }
    
    // Execute and return output
    const result = await executeCommand(matchedCommand, userId);
    return result.success 
      ? `✅ Done:\n${result.output}` 
      : `❌ Failed: ${result.error}`;
  }

  // Default: just respond conversationally
  return await getLLMResponse(input, userId);
};