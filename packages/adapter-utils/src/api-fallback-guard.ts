/**
 * API-fallback guard: scrubs subscription-bypassing API keys from adapter spawn
 * env for any agent not on the explicit backup whitelist.
 *
 * Background: NUT-4494 §B / board NUT-4491. Only one agent (the AI integration
 * tester) is allowed to fall back to direct API auth; every other agent must
 * use subscription auth, and must `blocked` rather than silently switch to API
 * billing if no subscription session is available.
 */

const DEFAULT_BACKUP_AGENT_IDS = new Set<string>([
  // AI integrační tester (board-approved API backup)
  "28429d0d-0000-0000-0000-000000000000",
]);

/**
 * Env var names that flip a `*-local` adapter from subscription auth into
 * direct-API auth. Keeping a single shared list lets us reason about the
 * scrub blast radius from one place.
 */
export const API_FALLBACK_ENV_KEYS = Object.freeze([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_ORG_ID",
  "CURSOR_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GROK_API_KEY",
  "XAI_API_KEY",
] as const);

export type ApiFallbackEnvKey = (typeof API_FALLBACK_ENV_KEYS)[number];

export interface ScrubApiFallbackEnvInput {
  env: Record<string, string | undefined>;
  agentId: string;
  adapterId: string;
  /** Extra agent IDs allowed to keep API keys (in addition to the built-in default). */
  extraBackupAgentIds?: Iterable<string>;
}

export interface ScrubApiFallbackEnvResult {
  /** New env object with offending keys removed when not whitelisted. */
  env: Record<string, string | undefined>;
  /** Keys that were present and would have been kept if whitelisted. */
  scrubbedKeys: ApiFallbackEnvKey[];
  /** True when the agent is on the backup whitelist, so env was passed through unchanged. */
  whitelisted: boolean;
}

function normalizeAgentId(value: string): string {
  return value.trim().toLowerCase();
}

function buildWhitelist(extra?: Iterable<string>): Set<string> {
  if (!extra) return DEFAULT_BACKUP_AGENT_IDS;
  const merged = new Set<string>(DEFAULT_BACKUP_AGENT_IDS);
  for (const id of extra) {
    if (typeof id === "string" && id.trim().length > 0) {
      merged.add(normalizeAgentId(id));
    }
  }
  return merged;
}

function hasNonEmpty(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Remove API-fallback env vars unless `agentId` is on the backup whitelist.
 * Returns the resulting env, the keys that were stripped, and whether the
 * agent was whitelisted (in which case env is returned untouched). The input
 * env is never mutated.
 */
export function scrubApiFallbackEnv(
  input: ScrubApiFallbackEnvInput,
): ScrubApiFallbackEnvResult {
  const whitelist = buildWhitelist(input.extraBackupAgentIds);
  const whitelisted = whitelist.has(normalizeAgentId(input.agentId));

  if (whitelisted) {
    return { env: { ...input.env }, scrubbedKeys: [], whitelisted: true };
  }

  const next: Record<string, string | undefined> = { ...input.env };
  const scrubbedKeys: ApiFallbackEnvKey[] = [];
  for (const key of API_FALLBACK_ENV_KEYS) {
    if (hasNonEmpty(next[key])) {
      scrubbedKeys.push(key);
      delete next[key];
    }
  }
  return { env: next, scrubbedKeys, whitelisted: false };
}

/** Test helper: snapshot the active whitelist (for diagnostics, not enforcement). */
export function getDefaultApiFallbackBackupAgentIds(): readonly string[] {
  return [...DEFAULT_BACKUP_AGENT_IDS];
}
