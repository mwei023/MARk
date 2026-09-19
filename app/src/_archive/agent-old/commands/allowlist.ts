// Strict, type-safe command allowlist
export type AllowedCommand = 'ls' | 'pwd' | 'date' | 'uptime' | 'df' | 'git-status';

export const COMMAND_CONFIG: Record<AllowedCommand, {
  binary: string;
  args?: string[];
  description: string;
  requiresConfirmation?: boolean;
}> = {
  'ls': { 
    binary: 'ls', 
    args: ['-la'], 
    description: 'List directory contents' 
  },
  'pwd': { 
    binary: 'pwd', 
    description: 'Show current working directory' 
  },
  'date': { 
    binary: 'date', 
    description: 'Show current date/time' 
  },
  'uptime': { 
    binary: 'uptime', 
    description: 'Show system uptime and load' 
  },
  'df': { 
    binary: 'df', 
    args: ['-h'], 
    description: 'Show disk usage (human-readable)' 
  },
  'git-status': { 
    binary: 'git', 
    args: ['status', '--short'], 
    description: 'Show Git repository status',
    requiresConfirmation: true // Optional: prompt before running
  },
};

export const isCommandAllowed = (cmd: AllowedCommand): boolean => 
  cmd in COMMAND_CONFIG;
  