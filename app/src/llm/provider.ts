/**
 * LLM Provider Abstraction
 * 
 * Canonical interface for all LLM providers. MARK's reasoning layer depends
 * on this interface, not on specific implementations (Groq, Gemini, OpenRouter, Ollama).
 */

export type MessageRole = 'system' | 'user' | 'assistant';

export interface Message {
  role: MessageRole;
  content: string;
}

/**
 * Response from an LLM provider
 */
export interface LLMResponse {
  content: string;
  model: string;
  provider: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

/**
 * Configuration for an LLM provider
 */
export interface LLMProviderConfig {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
}

/**
 * Provider metadata for debugging and inspection
 */
export interface ProviderMetadata {
  provider: string;
  model: string;
  status: 'available' | 'unavailable' | 'error';
  error?: string;
}

/**
 * Canonical LLM Provider interface.
 * All reasoning in MARK depends on this, not on specific provider implementations.
 */
export interface LLMProvider {
  /**
   * Send messages to the LLM and get a response
   */
  chat(messages: Message[], config?: Partial<LLMProviderConfig>): Promise<LLMResponse>;

  /**
   * Get provider metadata for inspection/debugging
   */
  getMetadata(): ProviderMetadata;

  /**
   * Check if provider is available (network, API key, etc.)
   * Resolves to true if available, false otherwise.
   * Should NOT throw.
   */
  isAvailable(): Promise<boolean>;
}
