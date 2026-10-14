// src/runtime/io/adapter.ts
export interface Context {
  userId?: string;
  source?: string;
  sessionId?: string;
}

export interface IOAdapter {
  onInput(handler: (text: string, context: Context) => Promise<void>): void;
  sendOutput(text: string, context: Context): Promise<void>;
  isReady(): boolean;
}
// Implementations: VoiceAdapter (current loop), CLIAdapter, WebSocketAdapter