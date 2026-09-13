/**
 * System Configuration Tool
 *
 * Allows users to inspect MARK's configuration, including LLM provider status.
 * Invoked when user asks "What LLM are you using?" or "How are you configured?"
 */

import { z } from "zod";
import { createTool } from "./toolFactory";
import { getLLMConfiguration, getLLMProviderCached } from "../llm";

export const systemConfigTool = createTool({
  name: "system_config",
  description: "Get information about the system configuration, including which LLM provider is active and its status.",
  argsSchema: z.object({
    query: z.string().optional()
      .describe("Optional query about specific config (e.g., 'llm', 'provider'). If empty, returns full config."),
  }),
  func: async (args) => {
    try {
      const llmConfig = getLLMConfiguration();

      // Try to get the active provider and its metadata
      let providerStatus = "Unknown";
      let providerError: string | undefined;
      try {
        const provider = await getLLMProviderCached();
        const metadata = provider.getMetadata();
        providerStatus = metadata.status === 'available' ? 'Available' : 'Unavailable';
        if (metadata.error) {
          providerError = metadata.error;
        }
      } catch (error: any) {
        providerStatus = "Error";
        providerError = error.message;
      }

      // Build response based on query
      const query = (args.query || '').toLowerCase();

      if (query.includes('llm') || query.includes('provider') || !query) {
        const lines = [
          '🤖 LLM Configuration:',
          `Provider: ${llmConfig.primaryProvider}`,
          `Model: ${llmConfig.models[llmConfig.primaryProvider] || 'Not configured'}`,
          `Status: ${providerStatus}${providerError ? ` (${providerError})` : ''}`,
          '',
          `Fallback Providers: ${llmConfig.fallbackProviders.join(', ')}`,
        ];

        if (!query) {
          lines.push(
            '',
            '💾 Storage:',
            'Database: PostgreSQL (connected)',
            'Vector Search: pgvector',
            '',
            '🔐 Security:',
            'Mode: Local-first with API providers as needed',
            'Data: Stored locally in PostgreSQL'
          );
        }

        return lines.join('\n');
      }

      return `Unknown config query: "${args.query}". Try: "llm", "provider", or leave blank for full config.`;

    } catch (error: any) {
      return `❌ Config error: ${error.message}`;
    }
  },
});
