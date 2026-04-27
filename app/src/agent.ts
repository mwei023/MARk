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
      input: input, 
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
  } catch (error: any) {
    console.error("[Agent Error]", error.message);
    return `⚠️ Error: ${error.message}`;
  }
};