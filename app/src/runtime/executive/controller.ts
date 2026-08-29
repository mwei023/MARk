// src/runtime/executive/controller.ts
export class ExecutiveController {
  async decide(input: UserInput): Promise<ActionPlan> {
    // 1. Update world model
    // 2. Score attention priority
    // 3. Match against active goals
    // 4. Return plan: { type: 'execute_capability' | 'respond' | 'observe' }
  }
}