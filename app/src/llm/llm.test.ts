/**
 * LLM Provider Tests
 * 
 * Tests for the provider abstraction, factory, fallback logic, and configuration.
 */

import assert from 'node:assert/strict';
import { OllamaProvider } from './providers/ollama';
import { GroqProvider } from './providers/groq';
import { GeminiProvider } from './providers/gemini';
import { OpenRouterProvider } from './providers/openrouter';
import { loadLLMConfig, getLLMConfiguration, resetLLMProvider } from './factory';
import { LLMProvider, Message } from './provider';

// ────────────────────────────────────────────────
// Test Suite
// ────────────────────────────────────────────────

async function runTests() {
  console.log('🧪 LLM Provider Tests\n');

  await testProviderInstantiation();
  await testConfigurationLoading();
  await testProviderMetadata();
  await testFallbackLogic();
  await testProviderAvailability();
  
  console.log('\n✅ All tests passed!');
}

// ────────────────────────────────────────────────
// Test: Provider Instantiation
// ────────────────────────────────────────────────

async function testProviderInstantiation() {
  console.log('Test: Provider Instantiation');

  const ollamaConfig = {
    provider: 'ollama',
    model: 'llama3.2:3b',
    baseUrl: 'http://localhost:11434',
  };
  const ollama = new OllamaProvider(ollamaConfig);
  assert.ok(ollama, 'Ollama provider should instantiate');
  assert.equal(ollama.getMetadata().provider, 'ollama');

  const groqConfig = {
    provider: 'groq',
    model: 'mixtral-8x7b-32768',
    apiKey: 'test-key',
  };
  const groq = new GroqProvider(groqConfig);
  assert.ok(groq, 'Groq provider should instantiate');
  assert.equal(groq.getMetadata().provider, 'groq');

  const geminiConfig = {
    provider: 'gemini',
    model: 'gpt-4-turbo',
    apiKey: 'test-key',
  };
  const gemini = new GeminiProvider(geminiConfig);
  assert.ok(gemini, 'Gemini provider should instantiate');
  assert.equal(gemini.getMetadata().provider, 'gemini');

  const openrouterConfig = {
    provider: 'openrouter',
    model: 'meta-llama/llama-2-70b-chat',
    apiKey: 'test-key',
  };
  const openrouter = new OpenRouterProvider(openrouterConfig);
  assert.ok(openrouter, 'OpenRouter provider should instantiate');
  assert.equal(openrouter.getMetadata().provider, 'openrouter');

  console.log('  ✓ All providers instantiate correctly\n');
}

// ────────────────────────────────────────────────
// Test: Configuration Loading
// ────────────────────────────────────────────────

async function testConfigurationLoading() {
  console.log('Test: Configuration Loading');

  // Save original env
  const originalEnv = { ...process.env };

  // Set test environment
  process.env.LLM_PROVIDER = 'groq';
  process.env.LLM_FALLBACK_PROVIDERS = 'gemini,ollama';
  process.env.GROQ_MODEL = 'test-groq-model';
  process.env.GEMINI_MODEL = 'test-gemini-model';
  process.env.GROQ_API_KEY = 'test-groq-key';

  const config = loadLLMConfig();
  assert.equal(config.primaryProvider, 'groq');
  assert.deepEqual(config.fallbackProviders, ['gemini', 'ollama']);
  assert.equal(config.models['groq'], 'test-groq-model');
  assert.equal(config.models['gemini'], 'test-gemini-model');
  assert.equal(config.apiKeys['groq'], 'test-groq-key');

  console.log('  ✓ Configuration loads correctly from environment\n');

  // Restore original env carefully - delete keys that didn't exist before
  delete process.env.LLM_PROVIDER;
  delete process.env.LLM_FALLBACK_PROVIDERS;
  delete process.env.GROQ_MODEL;
  delete process.env.GEMINI_MODEL;
  delete process.env.GROQ_API_KEY;
  
  // Restore any keys that existed in the original env
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }
}

// ────────────────────────────────────────────────
// Test: Provider Metadata
// ────────────────────────────────────────────────

async function testProviderMetadata() {
  console.log('Test: Provider Metadata');

  const ollamaConfig = {
    provider: 'ollama',
    model: 'llama3.2:3b',
    baseUrl: 'http://localhost:11434',
  };
  const ollama = new OllamaProvider(ollamaConfig);
  const ollaMeta = ollama.getMetadata();
  assert.equal(ollaMeta.provider, 'ollama');
  assert.equal(ollaMeta.model, 'llama3.2:3b');
  assert.equal(ollaMeta.status, 'available');

  const groqNoKeyConfig = {
    provider: 'groq',
    model: 'mixtral-8x7b-32768',
  };
  const groqNoKey = new GroqProvider(groqNoKeyConfig);
  const groqMeta = groqNoKey.getMetadata();
  assert.equal(groqMeta.provider, 'groq');
  assert.equal(groqMeta.status, 'unavailable');
  assert.ok(groqMeta.error);

  console.log('  ✓ Provider metadata is correct\n');
}

// ────────────────────────────────────────────────
// Test: Fallback Logic (Configuration)
// ────────────────────────────────────────────────

async function testFallbackLogic() {
  console.log('Test: Fallback Logic');

  // Test that configuration includes fallback chain
  const config = loadLLMConfig();
  assert.ok(Array.isArray(config.fallbackProviders));
  assert.ok(config.fallbackProviders.length > 0);
  assert.ok(config.primaryProvider);

  // Fallback should not include primary provider
  const hasPrimaryInFallback = config.fallbackProviders.some(
    f => f === config.primaryProvider
  );
  assert.equal(hasPrimaryInFallback, false, 'Primary provider should not be in fallback list');

  console.log('  ✓ Fallback logic is configured correctly\n');
}

// ────────────────────────────────────────────────
// Test: Provider Availability (Mocked)
// ────────────────────────────────────────────────

async function testProviderAvailability() {
  console.log('Test: Provider Availability');

  // Ollama check (localhost)
  const ollamaConfig = {
    provider: 'ollama',
    model: 'llama3.2:3b',
    baseUrl: 'http://localhost:11434',
  };
  const ollama = new OllamaProvider(ollamaConfig);
  // Note: availability check will fail unless Ollama is actually running
  const ollamaAvail = await ollama.isAvailable();
  // We don't assert true/false here because Ollama might not be running
  assert.strictEqual(typeof ollamaAvail, 'boolean', 'Ollama availability check should return boolean');

  // Groq without API key should not be available
  const groqNoKey = new GroqProvider({
    provider: 'groq',
    model: 'mixtral-8x7b-32768',
  });
  const groqAvail = await groqNoKey.isAvailable();
  assert.equal(groqAvail, false, 'Groq without API key should not be available');

  // Caching should work
  const groqAvail2 = await groqNoKey.isAvailable();
  assert.equal(groqAvail2, false, 'Groq availability should remain false (cached)');

  console.log('  ✓ Provider availability checks work correctly\n');
}

// ────────────────────────────────────────────────
// Run Tests
// ────────────────────────────────────────────────

runTests().catch(error => {
  console.error('❌ Test failed:', error);
  process.exit(1);
});
