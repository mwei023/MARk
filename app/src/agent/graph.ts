// src/agent/graph.ts
import { StateGraph, END } from "@langchain/langgraph";
import { AgentState } from "./state";
import { llmNode, toolExecutorNode } from "./nodes";

const workflow = new StateGraph(AgentState)
  // Entry point: LLM decides what to do
  .addNode("llm", llmNode)
  // Execute tool if requested
  .addNode("execute_tool", toolExecutorNode)
  
  // Routing logic
  .addConditionalEdges("llm", (state) => {
    if (state.next === "execute_tool") return "execute_tool";
    if (state.next === "end") return END;
    return "llm"; // default fallback
  })
  
  // After tool execution, return to LLM to craft response
  .addEdge("execute_tool", "llm")
  
  .setEntryPoint("llm");

const compiledGraph = workflow.compile();
export { compiledGraph };