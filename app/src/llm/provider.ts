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
 * Shared SSE streamer for OpenAI-compatible /chat/completions endpoints
 * (Groq, OpenRouter, Gemini-compatible). Reads `data: {...}` lines, emits
 * delta.content tokens, returns the accumulated response. Throws on HTTP
 * errors so callers fall back to chat(). Pure fetch — no SDK needed.
 */
export async function streamOpenAICompletions(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  onToken: (token: string) => void,
): Promise<{ content: string; model: string; usage?: LLMResponse['usage'] }> {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...body, stream: true }),
  });
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '');
    throw new Error(`stream request failed: ${response.status} ${detail.slice(0, 200)}`.trim());
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let model = '';
  let usage: LLMResponse['usage'];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice('data:'.length).trim();
      if (payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload) as {
          model?: string;
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
          choices?: Array<{ delta?: { content?: string } }>;
        };
        if (typeof json.model === 'string') model = json.model;
        if (json.usage) {
          usage = {
            promptTokens: json.usage.prompt_tokens,
            completionTokens: json.usage.completion_tokens,
            totalTokens: json.usage.total_tokens,
          };
        }
        const token = json.choices?.[0]?.delta?.content;
        if (typeof token === 'string' && token.length > 0) {
          content += token;
          onToken(token);
        }
      } catch {
        // Partial JSON across chunk boundary — keep buffering.
        buffer = `${line}\n${buffer}`;
      }
    }
  }
  return { content, model, usage };
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
   * Stream a response, emitting each token as it arrives. Optional: callers
   * must fall back to chat() when absent. Implementations without native
   * streaming may emit the full text as one token.
   */
  stream?(messages: Message[], config: Partial<LLMProviderConfig> | undefined, onToken: (token: string) => void): Promise<LLMResponse>;

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
