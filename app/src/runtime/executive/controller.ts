// src/runtime/executive/controller.ts
export interface UserInput {
  text: string;
  userId?: string;
  source?: string;
}

export interface ActionPlan {
  type: 'execute_capability' | 'respond' | 'observe';
  detail?: string;
}

export class ExecutiveController {
  async decide(input: UserInput): Promise<ActionPlan> {
    // 1. Update world model
    // 2. Score attention priority
    // 3. Match against active goals
    // 4. Return plan: { type: 'execute_capability' | 'respond' | 'observe' }
    if (!input?.text) return { type: 'observe', detail: 'empty input' };
    return { type: 'respond', detail: input.text };
  }
}