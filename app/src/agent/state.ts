// src/agent/state.ts
import { Annotation } from "@langchain/langgraph";

export type ToolCall = {
  name: string;
  args: Record<string, any>;
};

export const AgentState = Annotation.Root({
  /** Conversation history */
  messages: Annotation<string[]>({
    reducer: (x, y) => x.concat(y),
  }),
  // Persistent conversation history (for RAG + context)
  conversationHistory: Annotation<Array<{
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
  }>>({
    reducer: (x, y) => [...x, ...y].slice(-20), // Keep last 20 messages
  }),
  /** Next node to execute */
  next: Annotation<string | undefined>,
  /** Parsed tool call from LLM */
  tool_call: Annotation<ToolCall | undefined>,
  /** Result from tool execution */
  tool_result: Annotation<string | undefined>,
  /** User ID for audit logging */
  userId: Annotation<string>,
});