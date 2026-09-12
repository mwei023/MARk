/**
 * LLM Provider Factory and Configuration
 * 
 * Handles provider initialization, configuration, and fallback logic.
 * Ensures MARK's reasoning layer always gets a valid LLMProvider instance.
 */

import { LLMProvider, LLMProviderConfig } from './provider';
import { OllamaProvider } from './providers/ollama';
import { GroqProvider } from './providers/groq';
import { GeminiProvider } from './providers/gemini';
import { OpenRouterProvider } from './providers/openrouter';

export interface LLMConfig {
  primaryProvider: string;
  fallbackProviders: string[];
  models: Record<string, string>;
  apiKeys: Record<string, string | undefined>;
  baseUrls: Record<string, string | undefined>;
}

/**
 * Load configuration from environment variables
 */
export function loadLLMConfig(): LLMConfig {
  // Parse primary provider and fallback chain
  const primaryProvider = process.env.LLM_PROVIDER || 'groq';
  const fallbackProvidersEnv =
  process.env.LLM_FALLBACK_PROVIDERS || 'openrouter, ollama';
  const fallbackProviders = [
    ...new Set(
      fallbackProvidersEnv
      .split(',')
      .map((provider) => provider.trim().toLowerCase())
      .filter(Boolean)
      .filter((provider) => provider !== primaryProvider.toLowerCase())
    ),
  ];

  // Model configuration per provider
  const models: Record<string, string> = {
    groq: process.env.GROQ_MODEL || 'openai/gpt-oss-20b',
    gemini: process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview',
    openrouter: process.env.OPENROUTER_MODEL || 'openrouter/free',
    ollama: process.env.OLLAMA_MODEL || 'llama3.2:3b',
  };

  // API keys per provider
  const apiKeys: Record<string, string | undefined> = {
    groq: process.env.GROQ_API_KEY,
    gemini: process.env.GEMINI_API_KEY,
    openrouter: process.env.OPENROUTER_API_KEY,
    ollama: undefined, // Ollama doesn't require API key
  };

  // Base URLs for self-hosted or alternative endpoints
  const baseUrls: Record<string, string | undefined> = {
    ollama: process.env.OLLAMA_HOST,
    groq: undefined, // Uses official endpoint
    gemini: undefined,
    openrouter: undefined,
  };

  return {
    primaryProvider,
    fallbackProviders,
    models,
    apiKeys,
    baseUrls,
  };
}

/**
 * Create a provider instance for a given name
 */
function createProvider(name: string, config: LLMConfig): LLMProvider | null {
  const providerName = name.toLowerCase();
  const model = config.models[providerName];
  const apiKey = config.apiKeys[providerName];
  const baseUrl = config.baseUrls[providerName];

  const providerConfig: LLMProviderConfig = {
    provider: providerName,
    model: model || '',
    apiKey,
    baseUrl,
    temperature: 0, // Default to 0 for deterministic reasoning
  };

  switch (providerName) {
    case 'ollama':
      return new OllamaProvider(providerConfig);
    case 'groq':
      return new GroqProvider(providerConfig);
    case 'gemini':
      return new GeminiProvider(providerConfig);
    case 'openrouter':
      return new OpenRouterProvider(providerConfig);
    default:
      console.warn(`[LLM Factory] Unknown provider: ${name}`);
      return null;
  }
}

/**
 * Try to instantiate and validate a provider
 * Returns null if provider cannot be created or is unavailable
 */
async function tryProvider(name: string, config: LLMConfig): Promise<LLMProvider | null> {
  try {
    const provider = createProvider(name, config);
    if (!provider) return null;

    // Check availability
    const available = await provider.isAvailable();
    if (!available) {
      console.warn(`[LLM Factory] Provider '${name}' is not available`);
      return null;
    }

    console.log(`[LLM Factory] ✅ Provider '${name}' is ready`);
    return provider;
  } catch (error: any) {
    console.warn(`[LLM Factory] Failed to initialize provider '${name}': ${error.message}`);
    return null;
  }
}

/**
 * Get the active LLM provider with fallback logic
 * 
 * Tries primary provider first, then falls back through the chain.
 * Only falls back on provider availability, not on programming errors.
 * Will try all providers before giving up.
 */
export async function getLLMProvider(): Promise<LLMProvider> {
  const config = loadLLMConfig();

  // Try primary provider first
  const primary = await tryProvider(config.primaryProvider, config);

if (primary) {
  _activeLLMInfo = {
    configuredPrimary: config.primaryProvider,
    activeProvider: config.primaryProvider,
    activeModel: config.models[config.primaryProvider] || null,
    fallbackUsed: false,
    fallbackReason: null,
  };

  return primary;
}

  // Try fallback providers in order
  console.log(`[LLM Factory] Attempting fallback providers: ${config.fallbackProviders.join(', ')}`);
  for (const fallback of config.fallbackProviders) {
  const provider = await tryProvider(fallback, config);

  if (provider) {
    _activeLLMInfo = {
      configuredPrimary: config.primaryProvider,
      activeProvider: fallback,
      activeModel: config.models[fallback] || null,
      fallbackUsed: true,
      fallbackReason: `${config.primaryProvider} was unavailable`,
    };

    console.warn(`[LLM Factory] ⚠️  Using fallback provider: ${fallback}`);
    return provider;
  }
}

  // If we got here, no provider worked. This is a fatal error for MARK.
  const error = `[LLM Factory] FATAL: No LLM provider available. Checked: ${
    [config.primaryProvider, ...config.fallbackProviders].join(', ')
  }. Please ensure at least one provider is configured and available.`;
  
  console.error(error);
  throw new Error(error);
}

/**
 * Lazy singleton instance
 */
let _provider: LLMProvider | null = null;
let _getting: Promise<LLMProvider> | null = null;

/**
 * Runtime information about the provider actually selected.
 */
export interface ActiveLLMInfo {
  configuredPrimary: string;
  activeProvider: string | null;
  activeModel: string | null;
  fallbackUsed: boolean;
  fallbackReason: string | null;
}

let _activeLLMInfo: ActiveLLMInfo = {
  configuredPrimary: loadLLMConfig().primaryProvider,
  activeProvider: null,
  activeModel: null,
  fallbackUsed: false,
  fallbackReason: null,
};

/**
 * Get cached provider instance
 * Lazy initialization on first call
 */
export async function getLLMProviderCached(): Promise<LLMProvider> {
  if (_provider) return _provider;
  
  // Prevent multiple concurrent initialization attempts
  if (_getting) return _getting;

  _getting = getLLMProvider();
  _provider = await _getting;
  _getting = null;

  return _provider;
}

/**
 * Reset the cached provider (useful for testing)
 */
export function resetLLMProvider(): void {
  _provider = null;
  _getting = null;

  _activeLLMInfo = {
    configuredPrimary: loadLLMConfig().primaryProvider,
    activeProvider: null,
    activeModel: null,
    fallbackUsed: false,
    fallbackReason: null,
  };
}

/**
 * Get configuration for inspection
 */
export function getLLMConfiguration() {
  const config = loadLLMConfig();
  return {
    primaryProvider: config.primaryProvider,
    fallbackProviders: config.fallbackProviders,
    models: {
      ...config.models,
      // Filter out nullish values for cleaner output
    },
  };
}

/**
 * Return the provider selected during the latest provider initialization.
 *
 * This does not initialize a provider or contact any external service.
 */
export function getActiveLLMInfo(): ActiveLLMInfo {
  return { ..._activeLLMInfo };
}