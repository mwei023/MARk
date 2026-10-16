/**
 * API security boundary: auth-by-default + localhost-only default.
 *
 * MARK is a local-first system whose API can trigger real agent actions
 * (approvals, kernel tool execution). Two guards keep the default safe:
 *
 * 1. Bind host defaults to loopback. Binding 0.0.0.0 is allowed but only
 *    via explicit config (API_BIND_HOST), and it logs a loud warning.
 * 2. In production (NODE_ENV=production) the server refuses to start with
 *    an open API. Set API_TOKEN, or explicitly opt out with
 *    MARK_ALLOW_UNAUTHENTICATED_API=true (documented escape hatch for
 *    locked-down networks, never the default).
 *
 * Pure functions (testable without booting the server); server-v2 passes
 * in centralised config values at startup.
 */

export interface ApiSecurityInput {
  nodeEnv?: string;
  apiToken?: string;
  bindHost?: string;
  allowUnauthenticatedApi?: boolean;
  githubWebhookSecret?: string;
}

export interface ApiSecurityResolution {
  /** Host the server should bind. Defaults to loopback. */
  bindHost: string;
  /** Effective API auth mode. */
  authMode: 'token' | 'open';
  /** When set, the server must refuse to start with this message. */
  fatal?: string;
  /** Startup warnings to log (loud, every boot). */
  warnings: string[];
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Known placeholder secrets (shipped in .env.example). These must NEVER
 * count as "a token is set": the placeholder is public, so treating it as
 * a real token gives security theater (guessable password) AND breaks the
 * bundled UI (every /api/* call 401s with no token field to fill).
 */
const PLACEHOLDER_TOKENS = new Set([
  '***', 'changeme', 'placeholder', 'example', 'test', 'token', 'secret',
]);

export function isPlaceholderSecret(value: string | undefined): boolean {
  const v = (value ?? '').trim();
  if (!v) return true;
  if (v.includes('***')) return true;
  if (/^your_/i.test(v)) return true;
  return PLACEHOLDER_TOKENS.has(v.toLowerCase());
}

export function resolveApiSecurity(input: ApiSecurityInput = {}): ApiSecurityResolution {
  const warnings: string[] = [];
  const nodeEnv = (input.nodeEnv ?? '').toLowerCase();
  const isProduction = nodeEnv === 'production';

  const bindHost = (input.bindHost ?? '').trim() || '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(bindHost) && bindHost !== '') {
    warnings.push(
      `[security] API bound to non-loopback host "${bindHost}" — the MARK API can approve ` +
      'real agent actions. Ensure the network path is trusted (firewall/VPN) and API_TOKEN is set.',
    );
  }

  const rawToken = (input.apiToken ?? '').trim();
  const hasToken = !!rawToken && !isPlaceholderSecret(rawToken);
  if (rawToken && !hasToken) {
    warnings.push(
      '[security] API_TOKEN looks like an .env.example placeholder — treating the API as OPEN. ' +
      'Generate a real token (e.g. `openssl rand -hex 32`) to enable token auth.',
    );
  }
  if (hasToken) {
    if (!input.githubWebhookSecret) {
      warnings.push(
        '[security] GITHUB_WEBHOOK_SECRET is not set — unsigned GitHub webhooks are accepted. ' +
        'Set it to require HMAC signatures.',
      );
    }
    return { bindHost, authMode: 'token', warnings };
  }

  // No token: open API.
  if (isProduction && !input.allowUnauthenticatedApi) {
    return {
      bindHost,
      authMode: 'open',
      warnings,
      fatal:
        '[security] Refusing to start: NODE_ENV=production with an open API (API_TOKEN is not set). ' +
        'Set API_TOKEN, or explicitly opt out with MARK_ALLOW_UNAUTHENTICATED_API=true on a trusted network.',
    };
  }

  if (isProduction) {
    warnings.push(
      '[security] API_TOKEN is not set and the open-API escape hatch ' +
      '(MARK_ALLOW_UNAUTHENTICATED_API=true) is active in production. Only use on a trusted network.',
    );
  } else {
    warnings.push(
      '[security] API_TOKEN is not set — /api/* is open (local-first default, safe on loopback only). ' +
      'Set API_TOKEN to require Bearer/x-api-token.',
    );
  }
  if (!input.githubWebhookSecret) {
    warnings.push(
      '[security] GITHUB_WEBHOOK_SECRET is not set — unsigned GitHub webhooks are accepted. ' +
      'Set it to require HMAC signatures.',
    );
  }
  return { bindHost, authMode: 'open', warnings };
}
