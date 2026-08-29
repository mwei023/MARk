// src/agent.ts
import { compiledGraph } from "./agent/graph";// Adjust import if your graph variable is named differently
import { getRecentHistory, saveTurn } from "./agent/history";
import { AgentState } from "./agent/state";

export const runAgent = async (input: string, userId: string = "mwei") => {
  try {
    // 1. Load History
    const history = await getRecentHistory(userId, 3); // Last 3 turns

    // 2. Run Graph with History injected into State
    // Assuming your graph takes an input like { input, messages, userId, history }
    const result = await compiledGraph.invoke({
      input: input,  // Keep user input in state for consistent routing
      userId: userId,
      history: history,
      messages: [`User: ${input}`]
    });

    // 3. Extract Response (adjust based on your graph's output structure)
    const lastMsg = result.messages?.at(-1) || "";
    const response = lastMsg.replace(/^Jarvis:\s*/i, ""); // Clean up prefix

    // 4. Save to Database
    await saveTurn(userId, input, response);

    return response;
  // src/agent.ts - UPDATE THE CATCH BLOCK
} catch (error: any) {
  // 🔍 Detailed error logging - log EVERYTHING
  console.error('🔍 [Agent] Full error debug:', {
    errorType: typeof error,
    errorConstructor: error?.constructor?.name,
    errorMessage: error?.message,
    errorName: error?.name,
    errorStack: error?.stack?.split('\n')[0],
    errorString: String(error),
    errorKeys: error ? Object.keys(error) : 'null',
    // Safe stringify attempt
    errorJSON: (() => {
      try {
        return JSON.stringify(error, Object.getOwnPropertyNames(error), 2).slice(0, 800);
      } catch {
        return '[JSON stringify failed]';
      }
    })(),
  });
  
  // Build a safe message for the user
  const message = 
    error instanceof Error ? error.message :
    typeof error === 'string' ? error :
    error?.message || 
    error?.toString() || 
    'Unknown error occurred';
    
  return `⚠️ Error: ${message}`;
}
};