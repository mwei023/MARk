// src/agent/state.ts
import { Annotation } from "@langchain/langgraph";

export const AgentState = Annotation.Root({
  // 📝 Conversation History
  messages: Annotation<string[]>({
    reducer: (x, y) => x.concat(y),
    default: () => [],
  }),
  history: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),

  // 🧠 Agent Logic
  next: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => "__end__",
  }),
  userId: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => "mwei",
  }),

  // 🔧 Tool Execution
  tool_call: Annotation<any>({
    reducer: (x, y) => y ?? x,
    default: () => null,
  }),
  tool_result: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),
});

export type StateType = typeof AgentState.State;