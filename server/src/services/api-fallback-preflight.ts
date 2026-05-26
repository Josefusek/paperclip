import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scrubApiFallbackEnv, type ApiFallbackEnvKey } from "@paperclipai/adapter-utils";
import {
  trackApiFallbackBlocked,
  type TelemetryClient,
} from "@paperclipai/shared/telemetry";

/**
 * Adapter ids whose runtime requires a subscription token (claude.ai login,
 * codex login, etc.). For these, a non-whitelisted agent with no subscription
 * token must be blocked rather than silently falling back to direct-API auth.
 *
 * Cross-references: NUT-4494 §B (board policy), NUT-4496 (env scrub guard).
 */
const SUBSCRIPTION_DEPENDENT_ADAPTERS = new Set<string>([
  "claude_local",
  "codex_local",
]);

export type ApiFallbackBlockReason = "subscription_token_missing";

export interface ApiFallbackPreflightInput {
  agentId: string;
  adapterId: string;
  env: Record<string, string | undefined>;
  extraBackupAgentIds?: Iterable<string>;
  /** Test/override hook. When provided, skips filesystem probing. */
  subscriptionTokenAvailableOverride?: boolean;
}

export interface ApiFallbackPreflightResult {
  whitelisted: boolean;
  scrubbedKeys: ApiFallbackEnvKey[];
  hasSubscriptionToken: boolean;
  requiresSubscription: boolean;
  shouldBlock: boolean;
  blockReason: ApiFallbackBlockReason | null;
}

export class ApiFallbackBlockedError extends Error {
  readonly code = "subscription_token_missing" as const;
  readonly agentId: string;
  readonly adapterId: string;
  readonly scrubbedKeys: readonly ApiFallbackEnvKey[];
  constructor(input: {
    agentId: string;
    adapterId: string;
    scrubbedKeys: readonly ApiFallbackEnvKey[];
  }) {
    super(
      `Adapter ${input.adapterId} for agent ${input.agentId} requires a subscription token; ` +
        `API-key fallback is disallowed by board policy (NUT-4494 §B).`,
    );
    this.name = "ApiFallbackBlockedError";
    this.agentId = input.agentId;
    this.adapterId = input.adapterId;
    this.scrubbedKeys = input.scrubbedKeys;
  }
}

function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function claudeSubscriptionTokenPresent(): boolean {
  const dir = process.env.CLAUDE_CONFIG_DIR?.trim()
    ? process.env.CLAUDE_CONFIG_DIR
    : path.join(os.homedir(), ".claude");
  for (const filename of [".credentials.json", "credentials.json"]) {
    if (fileExists(path.join(dir, filename))) return true;
  }
  return false;
}

function codexSubscriptionTokenPresent(): boolean {
  const dir = process.env.CODEX_HOME?.trim()
    ? process.env.CODEX_HOME
    : path.join(os.homedir(), ".codex");
  for (const filename of ["auth.json", "session.json"]) {
    if (fileExists(path.join(dir, filename))) return true;
  }
  return false;
}

export function isSubscriptionDependentAdapter(adapterId: string): boolean {
  return SUBSCRIPTION_DEPENDENT_ADAPTERS.has(adapterId);
}

/**
 * Probe the runtime for a usable subscription token for the given adapter.
 * Returns `true` when the adapter does not require one.
 */
export function checkAdapterSubscriptionToken(adapterId: string): boolean {
  if (!isSubscriptionDependentAdapter(adapterId)) return true;
  if (adapterId === "claude_local") return claudeSubscriptionTokenPresent();
  if (adapterId === "codex_local") return codexSubscriptionTokenPresent();
  return true;
}

/**
 * Server-side preflight before adapter spawn. Combines the adapter-utils
 * env scrub helper with a subscription-token probe so the heartbeat can
 * (a) record a structured telemetry event when keys are stripped and
 * (b) refuse to spawn when no subscription token is available.
 */
export function evaluateApiFallbackPreflight(
  input: ApiFallbackPreflightInput,
): ApiFallbackPreflightResult {
  const scrub = scrubApiFallbackEnv({
    env: input.env,
    agentId: input.agentId,
    adapterId: input.adapterId,
    extraBackupAgentIds: input.extraBackupAgentIds,
  });
  const requiresSubscription = isSubscriptionDependentAdapter(input.adapterId);
  const hasSubscriptionToken =
    input.subscriptionTokenAvailableOverride !== undefined
      ? input.subscriptionTokenAvailableOverride
      : requiresSubscription
        ? checkAdapterSubscriptionToken(input.adapterId)
        : true;
  const shouldBlock = !scrub.whitelisted && requiresSubscription && !hasSubscriptionToken;
  return {
    whitelisted: scrub.whitelisted,
    scrubbedKeys: scrub.scrubbedKeys,
    hasSubscriptionToken,
    requiresSubscription,
    shouldBlock,
    blockReason: shouldBlock ? "subscription_token_missing" : null,
  };
}

/**
 * Emit the structured `adapter.api_fallback_blocked` telemetry event for a
 * preflight result. Safe to call when telemetry is disabled (`client` null)
 * and a no-op when nothing was scrubbed and no block fired.
 */
export function emitApiFallbackTelemetry(
  client: TelemetryClient | null,
  input: {
    agentId: string;
    adapterId: string;
    result: Pick<ApiFallbackPreflightResult, "scrubbedKeys" | "shouldBlock" | "whitelisted">;
  },
): void {
  if (!client) return;
  if (input.result.whitelisted) return;
  if (!input.result.shouldBlock && input.result.scrubbedKeys.length === 0) return;
  trackApiFallbackBlocked(client, {
    agentId: input.agentId,
    adapterId: input.adapterId,
    scrubbedKeys: input.result.scrubbedKeys,
    reason: input.result.shouldBlock ? "subscription_token_missing" : "key_scrubbed",
  });
}
