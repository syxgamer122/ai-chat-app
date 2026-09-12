/**
 * Environment Variable Scrubbing & Sanitization (Arcbox Model).
 * Strips or masks credentials, API keys, tokens, and database connection strings from subprocess environments.
 */

import { ScrubConfig } from './types';

export const DEFAULT_DENY_PATTERNS: RegExp[] = [
  /^((OPENAI|ANTHROPIC|GEMINI|COHERE|MISTRAL|GROQ|PERPLEXITY|DEEPSEEK|BEDROCK)_API_KEY)$/i,
  /^((GITHUB|GITLAB|BITBUCKET)_(TOKEN|PAT|SECRET))$/i,
  /^((AWS|AZURE|GCP|GOOGLE)_(SECRET|KEY|ACCESS_KEY|ACCESS_KEY_ID|SECRET_ACCESS_KEY|CREDENTIALS))$/i,
  /^(DATABASE_URL|DB_PASS|POSTGRES_PASSWORD|MYSQL_PWD|REDIS_AUTH|MONGODB_URI)$/i,
  /^(STRIPE|SLACK|DISCORD)_(TOKEN|KEY|SECRET|WEBHOOK)$/i,
  /.*(SECRET|PASSWORD|PASSWD|AUTH_TOKEN|PRIVATE_KEY|PRIVATE_CERT|ACCESS_TOKEN|BEARER_TOKEN).*/i,
];

export const DEFAULT_ALLOW_KEYS = new Set([
  'PATH',
  'NODE_PATH',
  'NODE_ENV',
  'HOME',
  'USERPROFILE',
  'LANG',
  'LC_ALL',
  'TERM',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'SHELL',
  'TMP',
  'TEMP',
  'TMPDIR',
  'PROCESSOR_ARCHITECTURE',
  'USERNAME',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMFILES',
]);

export class EnvScrubber {
  /**
   * Checks whether an environment variable key matches sensitive secret patterns.
   */
  public static isSensitiveKey(key: string, patterns: RegExp[] = DEFAULT_DENY_PATTERNS): boolean {
    return patterns.some((pattern) => pattern.test(key));
  }

  /**
   * Cleans ambient process environment by stripping or masking sensitive variables.
   */
  public static scrub(
    ambientEnv: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
    config?: ScrubConfig
  ): Record<string, string> {
    const denyPatterns = config?.denylistPatterns ?? DEFAULT_DENY_PATTERNS;
    const mode = config?.maskingMode ?? 'strip';
    const allowlistSet = config?.allowlistKeys ? new Set(config.allowlistKeys.map((k) => k.toUpperCase())) : null;
    const scrubbed: Record<string, string> = {};

    for (const [key, value] of Object.entries(ambientEnv)) {
      if (value === undefined || value === null) continue;

      const upperKey = key.toUpperCase();

      // If an explicit allowlist was specified, filter out keys not present
      if (allowlistSet && !allowlistSet.has(upperKey) && !DEFAULT_ALLOW_KEYS.has(upperKey)) {
        continue;
      }

      // Check if variable matches any sensitive denylist patterns
      const isSensitive = this.isSensitiveKey(key, denyPatterns);

      if (isSensitive) {
        if (mode === 'mask') {
          scrubbed[key] = '***SCRUBBED***';
        }
        // If mode === 'strip', we do not assign it to scrubbed
        continue;
      }

      scrubbed[key] = value;
    }

    // Merge custom environment overrides
    if (config?.customEnv) {
      for (const [k, v] of Object.entries(config.customEnv)) {
        if (v === undefined || v === null) continue;
        const isSensitive = this.isSensitiveKey(k, denyPatterns);
        if (isSensitive) {
          if (mode === 'mask') {
            scrubbed[k] = '***SCRUBBED***';
          }
        } else {
          scrubbed[k] = v;
        }
      }
    }

    return scrubbed;
  }

  /**
   * Filters an environment map strictly to allowed keys.
   */
  public static filterAllowlist(
    env: Record<string, string>,
    allowlist: string[]
  ): Record<string, string> {
    const allowed = new Set(allowlist.map((k) => k.toUpperCase()));
    const result: Record<string, string> = {};

    for (const [k, v] of Object.entries(env)) {
      if (allowed.has(k.toUpperCase())) {
        result[k] = v;
      }
    }

    return result;
  }
}
