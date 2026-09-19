# Quick Start: MARK with LLM Providers

Get MARK running with your preferred LLM provider in 5 minutes.

## Option 1: Groq (Recommended - Free)

**Why Groq?**
- Fast inference (LLaMA 2, Mixtral models)
- Free tier with generous rate limits
- No installation, just an API key

### Setup
```bash
# 1. Sign up: https://console.groq.com
# 2. Create API key in account settings
# 3. Copy your .env.example to .env (if not already done)
cp .env.example .env

# 4. Add Groq API key to .env
echo 'GROQ_API_KEY=your_api_key_here' >> .env

# 5. Ensure Groq is primary provider (default)
echo 'LLM_PROVIDER=groq' >> .env

# 6. Start MARK
npm run dev
```

### Verify It's Working
```bash
# In MARK chat/REPL:
> What LLM are you using?
# Response: Provider: Groq, Model: llama-3.3-70b-versatile, Status: Available
```

---

## Option 2: Google Gemini (Free Alternative)

**Why Gemini?**
- Multi-modal support (vision)
- Free tier available
- No credit card required

### Setup
```bash
# 1. Get API key: https://aistudio.google.com
# 2. Add to .env
echo 'GEMINI_API_KEY=your_api_key_here' >> .env
echo 'LLM_PROVIDER=gemini' >> .env

# 3. Start MARK
npm run dev
```

---

## Option 3: OpenRouter (Diverse Models)

**Why OpenRouter?**
- Access to many models in one API
- Model variety
- Good fallback option

### Setup
```bash
# 1. Sign up: https://openrouter.ai
# 2. Get API key from account
# 3. Add to .env
echo 'OPENROUTER_API_KEY=your_api_key_here' >> .env
echo 'LLM_PROVIDER=openrouter' >> .env

# 4. Start MARK
npm run dev
```

---

## Option 4: Ollama (Local Only)

**Why Ollama?**
- No API keys needed
- Works offline
- Complete privacy
- Maximum control

### Setup
```bash
# 1. Install Ollama: https://ollama.ai
# 2. Pull a model
ollama pull llama3.2:3b

# 3. Start Ollama server (in another terminal)
ollama serve

# 4. Configure .env
echo 'LLM_PROVIDER=ollama' >> .env
echo 'OLLAMA_HOST=http://localhost:11434' >> .env

# 5. Start MARK
npm run dev
```

---

## Option 5: Automatic Fallback (Recommended for Production)

Use multiple providers with automatic fallback:

```bash
# .env
LLM_PROVIDER=groq
LLM_FALLBACK_PROVIDERS=gemini,openrouter,ollama

# Add all API keys
GROQ_API_KEY=your_groq_key
GEMINI_API_KEY=your_gemini_key
OPENROUTER_API_KEY=your_openrouter_key

# Ollama (optional, for local fallback)
OLLAMA_HOST=http://localhost:11434
```

Now if Groq is down, MARK automatically tries:
1. Groq (primary)
2. Gemini (fallback 1)
3. OpenRouter (fallback 2)
4. Ollama (fallback 3)

The first available provider is used.

---

## Switching Providers

Simply change `LLM_PROVIDER` in `.env` and restart:

```bash
# From Groq to Gemini
sed -i 's/LLM_PROVIDER=groq/LLM_PROVIDER=gemini/' .env
npm run dev
```

No code changes needed.

---

## Verify Configuration

```bash
# Run MARK test
npm run test:llm

# Run full MARK test
npm run test:mark

# Check if compiles
npm run typecheck:mark
```

---

## Troubleshooting

### "No LLM provider available"
Ensure at least one provider is configured with a valid API key or Ollama is running.

### "GROQ_API_KEY not configured"
Add your API key to `.env`:
```bash
echo 'GROQ_API_KEY=your_key' >> .env
```

### Provider keeps timing out
Increase the timeout in `src/llm/providers/*.ts`:
```typescript
signal: AbortSignal.timeout(10000), // was 5000
```

### Want to see what's happening?
Enable debug logging:
```typescript
// In src/llm/factory.ts
console.log = (...args) => console.error('[DEBUG]', ...args);
```

---

## Cost Estimates

| Provider | Free Tier | Cost |
|----------|-----------|------|
| Groq | Yes | $0/month (generous) |
| Gemini | Yes | $0.075/input million tokens |
| OpenRouter | Partial | Variable (model-dependent) |
| Ollama | Yes | $0 (hardware + power) |

---

## Recommended Setup

For **development**:
```bash
LLM_PROVIDER=groq
LLM_FALLBACK_PROVIDERS=ollama
```
(Uses free Groq by default, falls back to local Ollama if needed)

For **production**:
```bash
LLM_PROVIDER=groq
LLM_FALLBACK_PROVIDERS=gemini,openrouter,ollama
```
(Multiple fallbacks ensure reliability)

For **air-gapped**:
```bash
LLM_PROVIDER=ollama
LLM_FALLBACK_PROVIDERS=
```
(Ollama only, fully local)

---

## Next Steps

1. ✅ Choose a provider
2. ✅ Run `npm run dev`
3. ✅ Ask MARK: "What LLM are you using?"
4. ✅ Enjoy reasoning with your preferred provider

See [LLM_PROVIDER_GUIDE.md](./LLM_PROVIDER_GUIDE.md) for detailed documentation.
