// src/test-imports.ts
import { createTool, toolsRegistry, Tool } from "./tools";
import { createSystemCheckTool } from "./tools/system_check";
import { z } from "zod";

console.log("✅ createTool:", typeof createTool);
console.log("✅ toolsRegistry:", Object.keys(toolsRegistry));
console.log("✅ system_check:", toolsRegistry.system_check?.name);

// Test manual tool creation
const hello = createTool({
  name: "hello",
  description: "Say hi",
  argsSchema: z.object({}),
  func: async () => "Hello!",
});
console.log("✅ Manual tool:", hello.name);