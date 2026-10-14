/**
 * Structured logger: All logs go through here for consistency.
 * Outputs: JSON for prod, human-readable for dev (via NODE_ENV).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'critical';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
  context?: Record<string, any>;
  error?: string;
  stack?: string;
}

const isDev = (process.env.NODE_ENV ?? '').toLowerCase() !== 'production';

function formatEntry(entry: LogEntry): string {
  if (isDev) {
    // Human-readable format for development
    const time = new Date(entry.timestamp).toISOString().slice(11, 23);
    const ctx = entry.context ? ` ${JSON.stringify(entry.context)}` : '';
    const err = entry.error ? ` | ${entry.error}` : '';
    return `[${time}] ${entry.level.toUpperCase()} [${entry.module}] ${entry.message}${ctx}${err}`;
  }
  // JSON format for production
  return JSON.stringify(entry);
}

export class Logger {
  constructor(private readonly module: string) {}

  private log(level: LogLevel, message: string, context?: Record<string, any>, error?: Error) {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      module: this.module,
      message,
      context,
      ...(error && {
        error: error.message,
        stack: error.stack,
      }),
    };

    const formatted = formatEntry(entry);
    
    // Write to console based on level
    if (level === 'critical' || level === 'error') {
      console.error(formatted);
    } else if (level === 'warn') {
      console.warn(formatted);
    } else {
      console.log(formatted);
    }
  }

  debug(message: string, context?: Record<string, any>) {
    if (isDev) this.log('debug', message, context);
  }

  info(message: string, context?: Record<string, any>) {
    this.log('info', message, context);
  }

  warn(message: string, context?: Record<string, any>) {
    this.log('warn', message, context);
  }

  error(message: string, error?: Error | unknown, context?: Record<string, any>) {
    const err = error instanceof Error ? error : new Error(String(error));
    this.log('error', message, context, err);
  }

  critical(message: string, error?: Error | unknown, context?: Record<string, any>) {
    const err = error instanceof Error ? error : new Error(String(error));
    this.log('critical', message, context, err);
  }
}

/** Factory: create a logger for any module */
export function createLogger(module: string): Logger {
  return new Logger(module);
}
