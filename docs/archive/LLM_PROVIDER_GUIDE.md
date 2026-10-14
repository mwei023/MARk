# MARK LLM Provider Abstraction

## Overview

MARK now uses a **canonical provider abstraction** for all LLM operations. The reasoning layer depends on the `LLMProvider` interface, not on specific implementations.

This means:
- ✅ Easy to swap providers without code changes
- ✅ Support for free tier API services (Groq, Gemini, OpenRouter)
- ✅ Automatic fallback when a provider is unavailable
- ✅ Keeps Ollama as an optional local/fallback option
- ✅ Never exposes API keys in logs

## Supported Providers

### Groq (Primary Default)
**Best for**: Development with free tier, fast inference

```bash
# Features
- Fast inference (LLaMA 2, Mixtral models)
- Free tier available
- No dependencies on local compute

# Setup
1. Sign up: https://console.groq.com
2. Get API key from console
3. Set in .env:
GROQ_API_KEY=your_api_key
LLM_PROVIDER=groq
```

### Google Gemini (Fallback)
**Best for**: Multi-modal reasoning, fallback option

```bash
# Setup
1. Get API key: https://aistudio.google.com
2. Set in .env:
GEMINI_API_KEY=your_api_key
```

### OpenRouter (Fallback)
**Best for**: Regional availability, model variety

```bash
# Setup
1. Sign up: https://openrouter.ai
2. Get API key from account
3. Set in .env:
OPENROUTER_API_KEY=your_api_key
```

### Ollama (Local/Fallback)
**Best for**: Air-gapped systems, development without internet, maximum privacy

```bash
# Setup
1. Install Ollama: https://ollama.ai
2. Pull model: ollama pull llama3.2:3b
3. Start server: ollama serve
4. MARK will auto-discover on localhost:11434

# Environment (optional)
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=llama3.2:3b
OLLAMA_EMBEDDING_MODEL=nomic-embed-text
```

## Configuration

### Environment Variables

```bash
# Primary provider (required)
LLM_PROVIDER=groq

# Fallback chain (optional, default: gemini,openrouter,ollama)
LLM_FALLBACK_PROVIDERS=gemini,openrouter,ollama

# Provider-specific API keys
GROQ_API_KEY=...
GEMINI_API_KEY=...
OPENROUTER_API_KEY=...

# Provider-specific models (optional, defaults provided)
GROQ_MODEL=llama-3.3-70b-versatile
GEMINI_MODEL=gemini-2.0-flash
OPENROUTER_MODEL=meta-llama/llama-3.3-70b-instruct
OLLAMA_MODEL=llama3.2:3b
```

### .env.example

A ``.env.example`` file is provided with all configuration options and defaults.

## Fallback Behavior

MARK implements **intelligent runtime fallback**:

1. **Primary Provider**: Tries first
2. **Fallback Chain**: If primary unavailable, tries in order
3. **No Silent Failures**: Only falls back on:
   - Network failures
   - Missing API keys
   - Rate limits (503, 429 status codes)
   - Explicit `404 Not Found` for provider
4. **Programming Errors Propagate**: Malformed requests, invalid JSON, etc. fail fast (don't fallback)

Example fallback in action:
```
Primary: Groq → [network error]
Fallback 1: Gemini → [rate limited]
Fallback 2: OpenRouter → [network error]
Fallback 3: Ollama → ✅ Available → Use Ollama
```

## Inspection

Users can ask MARK about its configuration:

```
User: "What LLM are you using?"
Jarvis: "🤖 LLM Configuration:
Provider: Groq
Model: llama-3.3-70b-versatile
Status: Available

Fallback Providers: gemini, openrouter, ollama"
```

This is handled by the `system_config` tool, which can be called programmatically:

```typescript
const { getLLMProviderCached, getLLMConfiguration } = await import('./llm');

const provider = await getLLMProviderCached();
const metadata = provider.getMetadata();
console.log(`Using: ${metadata.provider}/${metadata.model}`);

const config = getLLMConfiguration();
console.log('Fallbacks:', config.fallbackProviders);
```

## Architecture

### Provider Interface

All providers implement:

```typescript
interface LLMProvider {
  chat(messages: Message[]): Promise<LLMResponse>;
  getMetadata(): ProviderMetadata;
  isAvailable(): Promise<boolean>;
}
```

### Files

```
src/llm/
├── provider.ts              # Interface & types
├── factory.ts               # Factory, configuration, fallback logic
├── index.ts                 # Public exports
├── embeddings.ts            # Embeddings (Ollama only for privacy)
├── providers/
│   ├── ollama.ts            # Ollama implementation
│   ├── groq.ts              # Groq implementation
│   ├── gemini.ts            # Gemini implementation
│   └── openrouter.ts        # OpenRouter implementation
└── llm.test.ts              # Tests
```

### Entry Points

**For reasoning code:**
```typescript
import { getLLMProviderCached } from '../llm';

const provider = await getLLMProviderCached();
const response = await provider.chat(messages);
```

**For configuration inspection:**
```typescript
import { getLLMConfiguration } from '../llm';

const config = getLLMConfiguration();
// { primaryProvider: 'groq', fallbackProviders: [...], models: {...} }
```

## Development & Testing

### Run Provider Tests

```bash
npm run test:llm   # If you add this script
# or manually:
npx tsx src/llm/llm.test.ts
```

### Mocking Providers in Tests

```typescript
import { resetLLMProvider, getLLMProviderCached } from '../llm';

// Reset to force re-initialization
resetLLMProvider();

// Set test env vars
process.env.LLM_PROVIDER = 'ollama';
process.env.OLLAMA_HOST = 'http://mock-ollama:11434';

// Re-init
const provider = await getLLMProviderCached();
```

## Running MARK Without API Keys

Use Ollama as your only provider:

```bash
# 1. Install Ollama (https://ollama.ai)

# 2. Pull a model
ollama pull llama3.2:3b

# 3. Start Ollama
ollama serve

# 4. Update .env
LLM_PROVIDER=ollama
LLM_FALLBACK_PROVIDERS=

# 5. Run MARK
npm run dev
```

MARK will now run entirely locally with no external API dependencies.

## Routing Boundaries (Preserved)

The following boundaries remain **unchanged**:

| Query Type | Router | Handler | Notes |
|-----------|--------|---------|-------|
| Time/date | Local | `system_check` | No LLM |
| Disk/sys/CPU | Local | `system_check` | No LLM |
| Git operations | Agent | Git Agent | No LLM |
| Personal memory | Tool | `rag_query` | No LLM |
| Market data | Tool | `market_brief/snapshot` | Uses LLM |
| General knowledge | LLM | Reasoning layer | Uses LLM |

**Key invariant**: The LLM cannot invent `system_check` commands for ordinary questions. Routing is deterministic; fallback only applies to provider availability, not to decision logic.

## Migration Notes

If you were using the old `getModel()` function directly:

**Before:**
```typescript
import { getModel } from '../llm';
const response = await getModel().invoke([...]);
```

**After:**
```typescript
import { getLLMProviderCached, Message } from '../llm';
const provider = await getLLMProviderCached();
const response = await provider.chat(messages as Message[]);
```

## Troubleshooting

### "No LLM provider available"
Set at least one valid provider with API key or Ollama running:
```bash
# Option 1: Use Ollama (local)
ollama serve &
OLLAMA_HOST=http://localhost:11434

# Option 2: Add API key for Groq/Gemini/OpenRouter
GROQ_API_KEY=sk-...
LLM_PROVIDER=groq
```

### Provider network timeouts
Increase the timeout in the specific provider (default: 5s):
Edit `src/llm/providers/*.ts` and increase `AbortSignal.timeout(5000)` value.

### API key appears in logs
This should never happen. If you see an API key in logs, please report it as a bug. The provider implementations explicitly avoid logging credentials.

## Future Improvements

- [ ] Provider-specific retry logic with exponential backoff
- [ ] Token counting before sending (cost estimation)
- [ ] Per-provider rate limit tracking
- [ ] Provider-specific prompt optimization
- [ ] Structured/tool-capable reasoning for specific providers
- [ ] Skills system (separate checkpoint)
