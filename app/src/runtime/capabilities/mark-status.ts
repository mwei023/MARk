import { Capability } from './registry';
import { getLLMConfiguration, getActiveLLMInfo } from '../../llm';

/**
 * Local capability for inspecting MARK's own configuration.
 *
 * This capability reads local configuration only. It does not initialize
 * or contact any LLM provider.
 */
export class MarkStatusCapability implements Capability {
  id = 'mark.status';
  name = 'MARK status and configuration';

  canHandle(input: string): boolean {
    return /\b(what llm|which llm|what model|which model|llm provider|ai provider|mark status|system status|how are you configured|configuration)\b/i.test(
      input,
    );
  }

  async execute(_input: string): Promise<string> {
    const config = getLLMConfiguration();
    const active = getActiveLLMInfo();

    const primaryModel =
      config.models[config.primaryProvider] || 'Not configured';

    const fallbackText =
      config.fallbackProviders.length > 0
        ? config.fallbackProviders
            .map(provider => `${provider} (${config.models[provider] || 'default model'})`)
            .join(', ')
        : 'None configured';

    return [
      '🤖 MARK LLM Configuration',
      `Configured primary provider: ${config.primaryProvider}`,
      `Configured primary model: ${primaryModel}`,
      `Fallback providers: ${fallbackText}`,
      '',
      `Active provider: ${active.activeProvider || 'Not initialized yet'}`,
      `Active model: ${active.activeModel || 'Not initialized yet'}`,
      `Fallback used: ${active.fallbackUsed ? 'Yes' : 'No'}`,
      ...(active.fallbackReason ? [`Fallback reason: ${active.fallbackReason}`] : []),
      '',
      '💾 Storage',
      'Database: PostgreSQL',
      'Vector search: pgvector',
      '',
      '🔐 Execution mode',
      'Local-first; LLM providers are used only when reasoning is required.',
    ].join('\n');
  }
}
