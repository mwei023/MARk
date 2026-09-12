/**
 * OpenRouter LLM Provider
 * 
 * Access multiple LLM providers through a unified OpenAI-compatible API.
 * Includes built-in fallback to alternative models.
 * Requires OPENROUTER_API_KEY environment variable.
 */

import { LLMProvider, LLMProviderConfig, Message, LLMResponse, ProviderMetadata } from '../provider';

export class OpenRouterProvider implements LLMProvider {
  private apiKey: string;
  private modelName: string;
  private baseUrl = 'https://openrouter.ai/api/v1';
  private _availabilityCache: { checked: number; available: boolean } = { checked: 0, available: false };

  constructor(config: LLMProviderConfig) {
    this.apiKey = config.apiKey || process.env.OPENROUTER_API_KEY || '';
    // Default to a free tier model available on OpenRouter
    this.modelName = config.model || 'openrouter/free';

    if (!this.apiKey) {
      console.warn('[OpenRouter] No API key provided. Provider will not be available.');
    } else {
      console.log(`[OpenRouter] Initialized with model: ${this.modelName}`);
    }
  }

  async chat(messages: Message[], config?: Partial<LLMProviderConfig>): Promise<LLMResponse> {
    if (!this.apiKey) {
      throw new Error('OpenRouter API key not configured');
    }

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://mark-local.dev',
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
        throw new Error(`OpenRouter API error: ${response.status} ${error}`);
      }

      const data = await response.json() as any;
      const content = data.choices?.[0]?.message?.content || '';

      return {
        content: content.trim(),
        model: data.model || this.modelName,
        provider: 'openrouter',
        usage: {
          promptTokens: data.usage?.prompt_tokens,
          completionTokens: data.usage?.completion_tokens,
          totalTokens: data.usage?.total_tokens,
        },
      };
    } catch (error: any) {
      console.error(`[OpenRouter] Error: ${error.message}`);
      throw error;
    }
  }

  getMetadata(): ProviderMetadata {
    return {
      provider: 'openrouter',
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
      console.debug(`[OpenRouter] Availability check failed: ${error}`);
      this._availabilityCache = { checked: now, available: false };
      return false;
    }
  }
}
