import { describe, expect, it } from "vitest";
import {
  API_FALLBACK_ENV_KEYS,
  getDefaultApiFallbackBackupAgentIds,
  scrubApiFallbackEnv,
} from "./api-fallback-guard.js";

const NON_BACKUP_AGENT = "338ba831-cbc7-4d0f-bc82-55dd444a645f";
const BACKUP_AGENT = getDefaultApiFallbackBackupAgentIds()[0]!;

describe("scrubApiFallbackEnv", () => {
  it("preserves API keys for whitelisted backup agent", () => {
    const env = {
      ANTHROPIC_API_KEY: "sk-anthropic",
      OPENAI_API_KEY: "sk-openai",
      OTHER: "keep",
    };
    const result = scrubApiFallbackEnv({
      env,
      agentId: BACKUP_AGENT,
      adapterId: "claude_local",
    });
    expect(result.whitelisted).toBe(true);
    expect(result.scrubbedKeys).toEqual([]);
    expect(result.env.ANTHROPIC_API_KEY).toBe("sk-anthropic");
    expect(result.env.OPENAI_API_KEY).toBe("sk-openai");
    expect(result.env.OTHER).toBe("keep");
  });

  it("scrubs API keys for non-backup agent and reports stripped keys", () => {
    const env = {
      ANTHROPIC_API_KEY: "sk-anthropic",
      OPENAI_API_KEY: "sk-openai",
      CURSOR_API_KEY: "cur-1",
      GROK_API_KEY: "grok-1",
      GEMINI_API_KEY: "gem-1",
      OTHER: "keep",
    };
    const result = scrubApiFallbackEnv({
      env,
      agentId: NON_BACKUP_AGENT,
      adapterId: "claude_local",
    });
    expect(result.whitelisted).toBe(false);
    expect(result.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.env.OPENAI_API_KEY).toBeUndefined();
    expect(result.env.CURSOR_API_KEY).toBeUndefined();
    expect(result.env.GROK_API_KEY).toBeUndefined();
    expect(result.env.GEMINI_API_KEY).toBeUndefined();
    expect(result.env.OTHER).toBe("keep");
    expect(result.scrubbedKeys.sort()).toEqual(
      ["ANTHROPIC_API_KEY", "CURSOR_API_KEY", "GEMINI_API_KEY", "GROK_API_KEY", "OPENAI_API_KEY"].sort(),
    );
  });

  it("does not report keys that were absent or empty", () => {
    const result = scrubApiFallbackEnv({
      env: { ANTHROPIC_API_KEY: "   ", OPENAI_API_KEY: "" },
      agentId: NON_BACKUP_AGENT,
      adapterId: "claude_local",
    });
    expect(result.scrubbedKeys).toEqual([]);
    expect(result.whitelisted).toBe(false);
  });

  it("does not mutate the input env object", () => {
    const env = { ANTHROPIC_API_KEY: "sk-anthropic" };
    const snapshot = { ...env };
    scrubApiFallbackEnv({ env, agentId: NON_BACKUP_AGENT, adapterId: "claude_local" });
    expect(env).toEqual(snapshot);
  });

  it("honours extraBackupAgentIds whitelist additions", () => {
    const env = { ANTHROPIC_API_KEY: "sk-extra" };
    const result = scrubApiFallbackEnv({
      env,
      agentId: NON_BACKUP_AGENT,
      adapterId: "claude_local",
      extraBackupAgentIds: [NON_BACKUP_AGENT],
    });
    expect(result.whitelisted).toBe(true);
    expect(result.env.ANTHROPIC_API_KEY).toBe("sk-extra");
  });

  it("matches whitelist case-insensitively", () => {
    const result = scrubApiFallbackEnv({
      env: { ANTHROPIC_API_KEY: "sk-x" },
      agentId: BACKUP_AGENT.toUpperCase(),
      adapterId: "claude_local",
    });
    expect(result.whitelisted).toBe(true);
    expect(result.env.ANTHROPIC_API_KEY).toBe("sk-x");
  });

  it("covers the documented env keys for both providers", () => {
    expect(API_FALLBACK_ENV_KEYS).toContain("ANTHROPIC_API_KEY");
    expect(API_FALLBACK_ENV_KEYS).toContain("OPENAI_API_KEY");
  });
});
