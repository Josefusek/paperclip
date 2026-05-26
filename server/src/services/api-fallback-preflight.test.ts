import { describe, expect, it, vi } from "vitest";
import {
  ApiFallbackBlockedError,
  emitApiFallbackTelemetry,
  evaluateApiFallbackPreflight,
  isSubscriptionDependentAdapter,
} from "./api-fallback-preflight.js";

const WHITELISTED_AGENT = "28429d0d-0000-0000-0000-000000000000";
const OTHER_AGENT = "338ba831-cbc7-4d0f-bc82-55dd444a645f";

describe("evaluateApiFallbackPreflight", () => {
  it("passes whitelisted backup agents through with no scrub and no block", () => {
    const result = evaluateApiFallbackPreflight({
      agentId: WHITELISTED_AGENT,
      adapterId: "claude_local",
      env: { ANTHROPIC_API_KEY: "sk-test" },
      subscriptionTokenAvailableOverride: false,
    });
    expect(result.whitelisted).toBe(true);
    expect(result.scrubbedKeys).toEqual([]);
    expect(result.shouldBlock).toBe(false);
    expect(result.blockReason).toBeNull();
  });

  it("blocks a non-whitelisted agent on claude_local without subscription token", () => {
    const result = evaluateApiFallbackPreflight({
      agentId: OTHER_AGENT,
      adapterId: "claude_local",
      env: { ANTHROPIC_API_KEY: "sk-x", OPENAI_API_KEY: "sk-y" },
      subscriptionTokenAvailableOverride: false,
    });
    expect(result.whitelisted).toBe(false);
    expect(result.scrubbedKeys.sort()).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
    expect(result.hasSubscriptionToken).toBe(false);
    expect(result.requiresSubscription).toBe(true);
    expect(result.shouldBlock).toBe(true);
    expect(result.blockReason).toBe("subscription_token_missing");
  });

  it("scrubs keys but does not block when the subscription token is present", () => {
    const result = evaluateApiFallbackPreflight({
      agentId: OTHER_AGENT,
      adapterId: "codex_local",
      env: { OPENAI_API_KEY: "sk-x" },
      subscriptionTokenAvailableOverride: true,
    });
    expect(result.whitelisted).toBe(false);
    expect(result.scrubbedKeys).toEqual(["OPENAI_API_KEY"]);
    expect(result.shouldBlock).toBe(false);
    expect(result.blockReason).toBeNull();
  });

  it("does not block adapters that do not depend on a subscription token", () => {
    const result = evaluateApiFallbackPreflight({
      agentId: OTHER_AGENT,
      adapterId: "claude_api",
      env: { ANTHROPIC_API_KEY: "sk-x" },
      subscriptionTokenAvailableOverride: false,
    });
    expect(result.requiresSubscription).toBe(false);
    expect(result.shouldBlock).toBe(false);
    expect(result.scrubbedKeys).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it("isSubscriptionDependentAdapter exposes the policy table", () => {
    expect(isSubscriptionDependentAdapter("claude_local")).toBe(true);
    expect(isSubscriptionDependentAdapter("codex_local")).toBe(true);
    expect(isSubscriptionDependentAdapter("claude_api")).toBe(false);
    expect(isSubscriptionDependentAdapter("openai_api")).toBe(false);
  });
});

describe("ApiFallbackBlockedError", () => {
  it("tags the error with a stable code and propagates scrubbed key info", () => {
    const err = new ApiFallbackBlockedError({
      agentId: OTHER_AGENT,
      adapterId: "claude_local",
      scrubbedKeys: ["ANTHROPIC_API_KEY"],
    });
    expect(err.code).toBe("subscription_token_missing");
    expect(err.name).toBe("ApiFallbackBlockedError");
    expect(err.scrubbedKeys).toEqual(["ANTHROPIC_API_KEY"]);
    expect(err.adapterId).toBe("claude_local");
    expect(err.agentId).toBe(OTHER_AGENT);
  });
});

describe("emitApiFallbackTelemetry", () => {
  it("is a no-op when telemetry client is null", () => {
    expect(() =>
      emitApiFallbackTelemetry(null, {
        agentId: OTHER_AGENT,
        adapterId: "claude_local",
        result: { scrubbedKeys: ["ANTHROPIC_API_KEY"], shouldBlock: true, whitelisted: false },
      }),
    ).not.toThrow();
  });

  it("emits the structured event with reason=subscription_token_missing when blocked", () => {
    const track = vi.fn();
    const client = { track, hashPrivateRef: vi.fn() } as unknown as Parameters<typeof emitApiFallbackTelemetry>[0];
    emitApiFallbackTelemetry(client, {
      agentId: OTHER_AGENT,
      adapterId: "claude_local",
      result: { scrubbedKeys: ["ANTHROPIC_API_KEY"], shouldBlock: true, whitelisted: false },
    });
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith("adapter.api_fallback_blocked", expect.objectContaining({
      agent_id: OTHER_AGENT,
      adapter_id: "claude_local",
      scrubbed_keys: "ANTHROPIC_API_KEY",
      scrubbed_key_count: 1,
      reason: "subscription_token_missing",
    }));
  });

  it("emits reason=key_scrubbed when keys were stripped but subscription was available", () => {
    const track = vi.fn();
    const client = { track, hashPrivateRef: vi.fn() } as unknown as Parameters<typeof emitApiFallbackTelemetry>[0];
    emitApiFallbackTelemetry(client, {
      agentId: OTHER_AGENT,
      adapterId: "codex_local",
      result: { scrubbedKeys: ["OPENAI_API_KEY"], shouldBlock: false, whitelisted: false },
    });
    expect(track).toHaveBeenCalledWith("adapter.api_fallback_blocked", expect.objectContaining({
      reason: "key_scrubbed",
    }));
  });

  it("does not emit anything when the agent is whitelisted", () => {
    const track = vi.fn();
    const client = { track, hashPrivateRef: vi.fn() } as unknown as Parameters<typeof emitApiFallbackTelemetry>[0];
    emitApiFallbackTelemetry(client, {
      agentId: WHITELISTED_AGENT,
      adapterId: "claude_local",
      result: { scrubbedKeys: [], shouldBlock: false, whitelisted: true },
    });
    expect(track).not.toHaveBeenCalled();
  });

  it("does not emit when nothing was scrubbed and no block fired", () => {
    const track = vi.fn();
    const client = { track, hashPrivateRef: vi.fn() } as unknown as Parameters<typeof emitApiFallbackTelemetry>[0];
    emitApiFallbackTelemetry(client, {
      agentId: OTHER_AGENT,
      adapterId: "claude_api",
      result: { scrubbedKeys: [], shouldBlock: false, whitelisted: false },
    });
    expect(track).not.toHaveBeenCalled();
  });
});
