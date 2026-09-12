/**
 * Google Gemini LLM Provider
 * 
 * Uses Google's Gemini API for inference.
 * Requires GEMINI_API_KEY environment variable.
 */

import { LLMProvider, LLMProviderConfig, Message, LLMResponse, ProviderMetadata } from '../provider';

export class GeminiProvider implements LLMProvider {
  private apiKey: string;
  private modelName: string;
  private baseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai';
  private _availabilityCache: { checked: number; available: boolean } = { checked: 0, available: false };

  constructor(config: LLMProviderConfig) {
    this.apiKey = config.apiKey || process.env.GEMINI_API_KEY || '';
    this.modelName = config.model || 'gemini-3.1-pro-preview';

    if (!this.apiKey) {
      console.warn('[Gemini] No API key provided. Provider will not be available.');
    } else {
      console.log(`[Gemini] Initialized with model: ${this.modelName}`);
    }
  }

  async chat(messages: Message[], config?: Partial<LLMProviderConfig>): Promise<LLMResponse> {
    if (!this.apiKey) {
      throw new Error('Gemini API key not configured');
    }

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'x-goog-api-client': 'gl-node/1.0.0 gapic/1.0.0',
        },
        body: JSON.stringify({
          model: this.modelName,
          messages: messages.map(msg => ({
            role: msg.role === 'assistant' ? 'model' : msg.role,
            content: msg.content,
          })),
          temperature: config?.temperature ?? 0.7,
          max_tokens: config?.maxTokens,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Gemini API error: ${response.status} ${error}`);
      }

      const data = await response.json() as any;
      const content = data.choices?.[0]?.message?.content || '';

      return {
        content: content.trim(),
        model: data.model || this.modelName,
        provider: 'gemini',
        usage: {
          promptTokens: data.usage?.prompt_tokens,
          completionTokens: data.usage?.completion_tokens,
          totalTokens: data.usage?.total_tokens,
        },
      };
    } catch (error: any) {
      console.error(`[Gemini] Error: ${error.message}`);
      throw error;
    }
  }

  getMetadata(): ProviderMetadata {
    return {
      provider: 'gemini',
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
      // Quick health check with a minimal request
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.modelName,
          messages: [{ role: 'user', content: 'test' }],
          max_tokens: 1,
        }),
        signal: AbortSignal.timeout(5000),
      });

      const available = response.ok || response.status === 400; // 400 is ok - means API is up
      this._availabilityCache = { checked: now, available };
      return available;
    } catch (error) {
      console.debug(`[Gemini] Availability check failed: ${error}`);
      this._availabilityCache = { checked: now, available: false };
      return false;
    }
  }
}
