/**
 * Groq LLM Provider
 * 
 * Fast inference via Groq API.
 * Requires GROQ_API_KEY environment variable.
 */

import { LLMProvider, LLMProviderConfig, Message, LLMResponse, ProviderMetadata } from '../provider';

// We'll use fetch directly since langchain/groq might not be installed yet
// This avoids an immediate hard dependency while allowing the provider to be initialized

export class GroqProvider implements LLMProvider {
  private apiKey: string;
  private modelName: string;
  private baseUrl = 'https://api.groq.com/openai/v1';
  private _availabilityCache: { checked: number; available: boolean } = { checked: 0, available: false };

  constructor(config: LLMProviderConfig) {
    this.apiKey = config.apiKey || process.env.GROQ_API_KEY || '';
    this.modelName = config.model || 'openai/gpt-oss-20b';

    if (!this.apiKey) {
      console.warn('[Groq] No API key provided. Provider will not be available.');
    } else {
      console.log(`[Groq] Initialized with model: ${this.modelName}`);
    }
  }

  async chat(messages: Message[], config?: Partial<LLMProviderConfig>): Promise<LLMResponse> {
    if (!this.apiKey) {
      throw new Error('Groq API key not configured');
    }

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.modelName,
          messages: messages.map(msg => ({
            role: msg.role,
            content: msg.content,
          })),
          temperature: config?.temperature ?? 0.7,
          max_tokens: config?.maxTokens,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Groq API error: ${response.status} ${error}`);
      }

      const data = await response.json() as any;
      const content = data.choices?.[0]?.message?.content || '';

      return {
        content: content.trim(),
        model: data.model || this.modelName,
        provider: 'groq',
        usage: {
          promptTokens: data.usage?.prompt_tokens,
          completionTokens: data.usage?.completion_tokens,
          totalTokens: data.usage?.total_tokens,
        },
      };
    } catch (error: any) {
      console.error(`[Groq] Error: ${error.message}`);
      throw error;
    }
  }

  getMetadata(): ProviderMetadata {
    return {
      provider: 'groq',
      model: this.modelName,
      status: this.apiKey ? 'available' : 'unavailable',
      error: this.apiKey ? undefined : 'No API key configured',
    };
  }

  async isAvailable(): Promise<boolean> {
    // Cache availability check for 30 seconds
    const now = Date.now();
    if (now - this._availabilityCache.checked < 30000) {
      return this._availabilityCache.available;
    }

    if (!this.apiKey) {
      this._availabilityCache = { checked: now, available: false };
      return false;
    }

    try {
      // Quick health check via models list endpoint
      const response = await fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
        signal: AbortSignal.timeout(5000),
      });

      const available = response.ok;
      this._availabilityCache = { checked: now, available };
      return available;
    } catch (error) {
      console.debug(`[Groq] Availability check failed: ${error}`);
      this._availabilityCache = { checked: now, available: false };
      return false;
    }
  }
}
