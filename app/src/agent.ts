// src/agent.ts
import { agentGraph } from "./agent/graph";

/**
 * Run the Jarvis agent with a user input.
 * @param input - The user's message/command
 * @param userId - User identifier for audit logging (default: "mwei")
 * @returns The agent's final response string
 */
export const runAgent = async (input: string, userId: string = "mwei"): Promise<string> => {
  const initialState = {
    messages: [`User: ${input}`],
    next: undefined,
    tool_call: undefined,
    tool_result: undefined,
    userId,
  };
  
  try {
    const result = await agentGraph.invoke(initialState, {
    recursionLimit: 10, // Lower = safer, prevents runaway loops
  });
    console.log("[runAgent] Full graph result:", JSON.stringify(result, null, 2)); 
    const lastMessage = result.messages?.[result.messages.length - 1];
    
    // Clean up the response prefix if present
    return lastMessage?.replace(/^Jarvis:\s*/, "") || "No response generated";
  } catch (error) {
    console.error("[runAgent error]", error);
    return `⚠️ Error: ${error instanceof Error ? error.message : "Unknown error"}`;
  };
};