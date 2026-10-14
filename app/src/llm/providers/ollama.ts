/**
 * Ollama LLM Provider
 *
 * Local/self-hosted inference via Ollama.
 * Useful for development, fallback, or air-gapped systems.
 */

import { ChatOllama } from '@langchain/ollama';
import {
  LLMProvider,
  LLMProviderConfig,
  Message,
  LLMResponse,
  ProviderMetadata,
} from '../provider';

export class OllamaProvider implements LLMProvider {
  private model: ChatOllama;
  private baseUrl: string;
  private modelName: string;
  private _availabilityCache: {
    checked: number;
    available: boolean;
  } = {
    checked: 0,
    available: false,
  };

  constructor(config: LLMProviderConfig) {
    this.baseUrl = config.baseUrl || 'http://localhost:11434';
    this.modelName = config.model || 'llama3.2:3b';

    console.log(
      `[Ollama] Initializing model: ${this.modelName} @ ${this.baseUrl}`,
    );

    this.model = new ChatOllama({
      model: this.modelName,
      baseUrl: this.baseUrl,
      temperature: config.temperature ?? 0,
      format: 'json',
    });
  }

  async chat(
    messages: Message[],
    config?: Partial<LLMProviderConfig>,
  ): Promise<LLMResponse> {
    try {
      // Convert our Message type to LangChain format.
      const langchainMessages = messages.map((msg) => ({
        role: msg.role as 'system' | 'user' | 'assistant',
        content: msg.content,
      }));

      const response = await this.model.invoke(langchainMessages);

      const content =
        typeof response.content === 'string'
          ? response.content
          : JSON.stringify(response.content);

      return {
        content: content.trim(),
        model: this.modelName,
        provider: 'ollama',
      };
    } catch (error: any) {
      console.error(`[Ollama] Error: ${error.message}`);
      throw error;
    }
  }

  async stream(
    messages: Message[],
    _config: Partial<LLMProviderConfig> | undefined,
    onToken: (token: string) => void,
  ): Promise<LLMResponse> {
    const langchainMessages = messages.map((msg) => ({
      role: msg.role as 'system' | 'user' | 'assistant',
      content: msg.content,
    }));
    let content = '';
    for await (const chunk of await this.model.stream(langchainMessages)) {
      const text = typeof chunk.content === 'string' ? chunk.content : JSON.stringify(chunk.content);
      if (text.length > 0) {
        content += text;
        onToken(text);
      }
    }
    if (!content.trim()) throw new Error('Ollama returned an empty stream');
    return { content: content.trim(), model: this.modelName, provider: 'ollama' };
  }

  getMetadata(): ProviderMetadata {
    return {
      provider: 'ollama',
      model: this.modelName,
      status: 'available',
    };
  }

  async isAvailable(): Promise<boolean> {
    // Cache availability check for 30 seconds to avoid repeated requests.
    const now = Date.now();

    if (now - this._availabilityCache.checked < 30000) {
      return this._availabilityCache.available;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: controller.signal,
      });

      const available = response.ok;

      this._availabilityCache = {
        checked: now,
        available,
      };

      return available;
    } catch (error) {
      console.debug(`[Ollama] Availability check failed: ${error}`);

      this._availabilityCache = {
        checked: now,
        available: false,
      };

      return false;
    } finally {
      clearTimeout(timeout);
    }
  }
}