# RFC_FALLBACK_ORCHESTRATOR_v1 — Runtime fallback orchestrator for paperclip-core

| | |
|---|---|
| **Status** | **v1.1 — board-approved + open questions resolved by FoundingEngineer per "rozhodni ty" delegation 2026-05-08** |
| **Issue** | internal issue reference (parent: internal issue reference) |
| **Owner** | FoundingEngineer (`338ba831-cbc7-4d0f-bc82-55dd444a645f`) |
| **Date** | 2026-05-08 (v1.0 board-approved 19:36Z; v1.1 decisions locked 19:50Z) |
| **Approval** | internal approval reference — `local-board`, no decision note, no conditions |
| **Depends on** | internal issue reference (capability routing config + 3-class taxonomy — done) · internal issue reference (RuntimeAdapter contract — done) |
| **Path decision** | **Upstream PR first**. Implementation is upstream maintainers' work, not FoundingEngineer's. Fork fallback only if upstream rejects after ≥4 weeks of review. |
| **Companion artifact** | `nutriadapt-lab-platform/docs/proposals/runtime_fallback_orchestrator.md` (workspace-internal design doc with full reasoning); `UPSTREAM_PR_DRAFT_fallback_orchestrator.md` (PR draft) |

---

## 0. TL;DR

internal-issue-id shipped a 3-class error taxonomy (`transient` / `quota_exhausted` /
`hard_error`) and a per-agent `CapabilityRoutingConfig` with `primary` +
`fallback_chain` + `escalation`. Adapters classify and emit events; nothing
acts on them. Today, when the runtime sees `quota_exhausted` it either retries
the same provider (whose monthly cap is the cause) or marks the heartbeat
failed — neither is what `POLICY_LLM_USAGE.md` v5 §9.3 requires.

This RFC adds a **`FallbackOrchestrator`** in paperclip-core that:

1. Wraps the existing run loop and observes terminal `RunResult`s.
2. On `quota_exhausted`, applies a two-axis **detection threshold** (per-task + per-fleet, defaults from §3.3) to avoid false-positive cascades a la internal issue reference/internal issue reference.
3. Resolves the next `FallbackChainEntry` to a registered `AdapterType`, builds a `ContextEnvelope`, and re-spawns the run under per-task locking (internal issue reference invariant) with idempotency keys on every API mutation.
4. When the chain is exhausted, marks the issue blocked with the configured `escalation.action` rather than looping silently (§9.3 #5 of policy).

API surface is **two additive fields** on existing types and **one new exported
class**:

```ts
// RuntimeAdapter (additive)
interface RuntimeAdapter {
  readonly transientRetryBudget?: number;                 // optional, default 3
  hydrateContextEnvelope?(envelope, spec, ctx): Promise<HydrationResult>;
}

// AgentRunSpec (additive)
interface AgentRunSpec {
  contextEnvelope?: ContextEnvelope;                      // optional; older adapters ignore safely
}

// New
export class FallbackOrchestrator {
  evaluate(input: OrchestratorInput): ContinuationDecision;
  applyDecision(decision: ContinuationDecision, input: OrchestratorInput): Promise<void>;
}
```

**Estimate (RFC + sign-off, this ticket):** 1 day (this run). **Upstream
implementation (separate timeline, not FoundingEngineer):** ~10–14 engineer-days
end-to-end (orchestrator core + envelope plumbing + locking + telemetry +
shadow-mode flag + tests).

**Risk highlights:** context loss across providers, double billing at the
switch boundary, prompt-cache thrash, threshold mistuning. Mitigations live in
§9 of the design doc and are summarized in §8 below.

---

## 1. The new contract

### 1.1 Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│              Paperclip-core run loop (existing)                      │
│  resolveAdapterForRun(agent, issue) → invokeRun(spec) → RunResult    │
└────────────────────────┬─────────────────────────────────────────────┘
                         │ RunResult { status, error?, usage }
                         ▼
┌──────────────────────────────────────────────────────────────────────┐
│             FallbackOrchestrator (this RFC)                          │
│   evaluate(result, spec, routing, thresholdState) →                  │
│     ContinuationDecision { keep_result | retry_same                  │
│                          | switch_provider | defer_threshold         │
│                          | exhaust_chain }                           │
│   applyDecision(decision):                                           │
│     - acquire taskLock(taskId)                                       │
│     - if switch: build ContextEnvelope; spawn new run on next rung   │
│     - if exhaust: mark issue blocked + emit escalation               │
│     - record idempotency event keyed by ${runChainId}:${stepHash}    │
│     - release taskLock(taskId)                                       │
└──────────────────────────────────────────────────────────────────────┘
```

The orchestrator's pure decision (`evaluate`) is unit-tested; the side-effecting
shell (`applyDecision`) is integration-tested against a fake adapter.

### 1.2 Decision rules

| Input | Decision |
|---|---|
| `result.status = 'succeeded'` | `keep_result` |
| `error.kind` → `hard_error` (auth, content-policy, misconfig, max_turns, cancel) | `keep_result` (no fallback per POLICY §9.4) |
| `error.kind` → `transient` and same-rung retries < `transientRetryBudget` | `retry_same` with `error.retryAfterMs` |
| `error.kind` → `transient` and budget exhausted | treat as `quota_exhausted` for chain purposes |
| `error.kind` → `quota_exhausted` and threshold met (§3) | `switch_provider` with envelope to next available rung |
| `error.kind` → `quota_exhausted` and threshold not met | `defer_threshold` with cool-off |
| Chain has no remaining available rung | `exhaust_chain` → `escalation.action` |

`evaluate()` is pure given an injected `now()`; `applyDecision()` is the only
side-effecting path.

### 1.3 Where the chain comes from

`agent.adapterConfig.routing` carries `CapabilityRoutingConfig` from internal-issue-id
(lab-platform validates it at hire/update time). Inside paperclip-core, the
orchestrator reads the resolved field; if absent or `fallback_chain` is empty,
the orchestrator **bypasses itself** and falls back to the existing retry/fail
behaviour, emitting one `fallback_chain_missing` warning per agent per day.
This is the non-tenant escape hatch (paperclip-core serves multiple
companies; not all adopt the routing policy).

---

## 2. Inputs from internal-issue-id (already shipped, no upstream change needed)

```ts
// from lab-platform / src/runtime/capability-routing/types.ts
export interface CapabilityRoutingConfig {
  source: 'explicit' | 'default';
  role: 'strategic_reasoning' | 'operational_orchestration'
       | 'document_intelligence' | 'research_monitoring' | 'routine_lightweight';
  primary: FallbackChainEntry;
  fallback_chain: FallbackChainEntry[];
  escalation: { action: EscalationAction; reasonTemplate: string };
}

export interface FallbackChainEntry {
  provider: 'claude' | 'chatgpt' | 'gemini' | 'perplexity';
  tier: 'subscription' | 'api';
  model?: string;                                  // optional; resolves to adapter default
}

// from lab-platform / src/runtime/capability-routing/error-class.ts
export type ErrorClass = 'transient' | 'quota_exhausted' | 'hard_error';
export function toErrorClass(kind: AdapterErrorKind): ErrorClass;
```

**Required upstream change:** the `(provider, tier) → AdapterType` resolver
must be a single shared helper consumed by both lab-platform and core. RFC
ships this as `resolveChainEntryToAdapterType(entry, registeredAdapters)` with
the mapping table from the design doc §2.3. Soft-skipping unregistered entries
is mandatory (forward-compat with adapter rollouts).

---

## 3. Detection threshold

Two axes, AND-combined for safety, OR-combined for acceleration:

| Axis | Default | Behaviour |
|---|---|---|
| **Per-task** (monotonic) | 2 events within 10 min → `switch_provider`; 1 event → `defer_threshold` with cool-off | Safe baseline: at least one cool-off chance before switching |
| **Per-fleet** (corroboration) | ≥3 distinct agents on same provider report `quota_exhausted` within 10 min → skip per-task wait, switch on first event | Optimization: corroborated signal accelerates switch (whole-org cap, vendor outage) |

| Parameter | Default | Configurable via |
|---|---|---|
| `perTaskCoolOffMs` | `min(vendor.retryAfterMs, 60_000)` | core flag |
| `perTaskWindow` | 10 minutes | core flag |
| `perTaskThreshold` | 2 events | core flag |
| `perFleetWindow` | 10 minutes | core flag |
| `perFleetThreshold` | 3 distinct agents | core flag |
| `transientRetryBudget` | 3 | per-adapter override on `RuntimeAdapter` |

Conservative bias: prefer false-positive **defers** over premature switches.
Telemetry from shadow mode tunes the defaults before enforcement.

---

## 4. Context envelope

When a switch is decided, the orchestrator serializes a `ContextEnvelope` and
hands it to the next adapter via the new `AgentRunSpec.contextEnvelope?` field:

```ts
interface ContextEnvelope {
  v: 1;
  /** Identity */
  runChainId: string;
  originRunId: string;
  taskId: string;
  agentId: string;
  companyId: string;

  /** Task intent */
  acceptanceCriteria: string[];
  boardConstraints: {
    humanLoopRequired: boolean;
    sensitivityClass: 'internal' | 'outbound' | 'regulatory' | 'critical';
    roleFit: Role;
  };

  /** Carried-over work */
  accumulatedReasoning: string;                    // ≤2_000 tokens, compressed
  partialOutput: WorkArtifactRef[];
  cacheHints?: { vendorScopedRef: string; modelId: string };

  /** Audit */
  priorRunSummary: PriorRunSummary[];
  emittedAt: string;
}

interface PriorRunSummary {
  runId: string;
  adapterType: AdapterType;
  model: string;
  exitedWith: ErrorClass;
  errorCode: string | null;
  durationMs: number;
  turnsUsed: number;
}
```

**MUST NOT** carry: secrets / OAuth tokens, raw prompt-cache contents, full
turn-by-turn transcripts, user PII beyond what's already in the issue body.

Adapters that don't implement `hydrateContextEnvelope?` get the default
behaviour: orchestrator splices envelope JSON + a structured "Context from
prior runs" preamble into the inline system prompt. Adapters with native
session state (subscription_cli) MAY override to hydrate cache more cleverly.

---

## 5. Idempotence

Three invariants:

1. **No double billing.** Prior run's `UsageReport` is finalized **before** `evaluate()` runs. The new run gets a fresh `runId`; `runChainId` is the join key for dashboard rollups.
2. **No double execution of a step.** `partialOutput` carried in envelope; every Paperclip API mutation emitted by the new run carries `Idempotency-Key: ${runChainId}:${stepHash}`; API rejects duplicates.
3. **No double spawn.** Per-task lock from internal issue reference is acquired across `evaluate → spawn → release`. The orchestrator does NOT bypass the existing lock; it acquires it and adds a `runChainId`-scoped check inside the critical section ("did someone else already switch this chain?"). Lock is held only for the spawn boundary, not the run duration.

The orchestrator does NOT recursively switch within a single `evaluate()` call.
If a freshly-spawned run also exhausts, that's a separate event on the next
heartbeat — keeps the call graph flat and the chain walk finite (at most
`primary + len(fallback_chain)` runs per `runChainId`).

---

## 6. Logging / telemetry

Two new events on the existing telemetry sink (same shape as
internal-issue-id routing decision logs so the dashboard can join them on `runChainId`):

```ts
interface FallbackDecisionEvent {           // every evaluate() call
  v: 1;
  decision: 'keep_result' | 'retry_same' | 'switch_provider' | 'defer_threshold' | 'exhaust_chain';
  runChainId: string;
  runId: string;
  taskId: string;
  agentId: string;
  triggerErrorClass: ErrorClass;
  triggerErrorCode: string | null;
  fromAdapter: AdapterType;
  fromModel: string;
  toAdapter?: AdapterType;
  toModel?: string;
  thresholdState: { perTask: number; perFleet: number };
  emittedAt: string;
}

interface FallbackSwitchEvent {             // only on actual switch
  v: 1;
  runChainId: string;
  rungIndex: number;                        // 0 = primary, 1 = first fallback, ...
  fromAdapter: AdapterType;
  toAdapter: AdapterType;
  fromProvider: Provider;
  toProvider: Provider;
  fromTier: Tier;
  toTier: Tier;
  envelopeBytes: number;
  envelopeChecksum: string;                 // sha-256
  agentId: string;
  taskId: string;
  triggerErrorCode: string | null;
  emittedAt: string;
}
```

Cost dashboard (child C of internal-issue-id) joins these to surface fallback
frequency, chain depth distribution, subscription-vs-API split, and
threshold deferral rate.

---

## 7. Backward compatibility

| Surface | Change | Impact on existing adapters / agents |
|---|---|---|
| `RuntimeAdapter.transientRetryBudget?` | optional new field; default 3 | none (optional) |
| `RuntimeAdapter.hydrateContextEnvelope?` | optional new method | none (orchestrator falls back to inline-system-prompt splice) |
| `AgentRunSpec.contextEnvelope?` | optional new field | older adapters ignore the field; behaviour unchanged |
| `agent.adapterConfig.routing` missing | orchestrator bypasses itself; existing retry matrix runs | none (non-tenant companies opt out by simply not configuring a chain) |
| Existing retry matrix (`defaultRetriable()` + `error.retriable`) | unchanged | none (orchestrator only sees terminal `RunResult` after the matrix decides) |
| Per-task lock from internal-issue-id | unchanged; orchestrator acquires same lock | none |

**Rollout:** **shadow mode** by default. The orchestrator runs, records
`fallback_decision` events, but does NOT enact switches until
`enforceFallback = true` is flipped. Migration:

| Phase | Action |
|---|---|
| 0 | Land shadow-mode orchestrator + telemetry |
| 1 | After ≥1 week of clean shadow telemetry, flip enforcement for one canary agent (FoundingEngineer) |
| 2 | Roll out remaining 15 agents in waves of ~5 over 2 weeks; pause and revert if `defer_threshold` rate exceeds 30% |
| 3 | Decommission ad-hoc `agent.adapterType` swap recovery procedures |

---

## 8. Risk register (summarized; full table in design doc §9)

| Risk | Severity | Likelihood | Primary mitigation |
|---|---|---|---|
| Context loss across providers (Critical sensitivity tasks) | High | Medium | `humanLoopRequired = true` agents pause for ack via `escalation.action = 'pause_and_email_ceo'`; Critical sensitivity defaults to `'blocked_with_owner_alert'` instead of chain-walking |
| Double billing at switch | High | Low | Prior `UsageReport` finalized before `evaluate()`; idempotency keys on API mutations |
| Double execution of a step | High | Medium | `partialOutput` in envelope + idempotency keys |
| Threshold mistuning (cascade or stall) | Medium | Medium | Conservative defaults + shadow-mode telemetry tunes before enforcement |
| Prompt-cache thrash | Medium | High under bursty load | Same-rung retry budget exhausted before switch; `cacheHints` for within-vendor reuse; chain walk does not unwind |
| `subscription_cli` session corruption mid-turn | Medium | Low | Orchestrator only runs on terminal `RunResult`, never mid-turn |
| Lock contention (high-throughput non-tenant companies) | Low | Low | Lock held ~ms (decision + spawn), not run duration |
| Adapter not registered for chain entry | Low | Medium | Soft-skip with logged warning; never hard-fails the chain |
| tenant-specific policy leaking into core | Medium | Low | Orchestrator API is policy-agnostic; policy lives in `CapabilityRoutingConfig` (per-company config), not core code |

---

## 9. Test plan

| Layer | Coverage |
|---|---|
| `evaluate()` unit tests | All seven decision rules in §1.2; all threshold combinations in §3 (per-task only, per-fleet only, both, neither); `defer_threshold` cool-off math; `exhaust_chain` escalation routing |
| Envelope serialization | Round-trip `ContextEnvelope` JSON; checksum stability; secret-redaction smoke (envelope MUST NOT contain `secret://`); size cap on `accumulatedReasoning` |
| `applyDecision()` integration | Fake adapter pipeline: primary fails → switch → fallback succeeds; primary fails → switch → fallback also fails → switch again on next event; chain exhausted → `blocked_with_board_ask` issue state; lock contention from two concurrent invocations on same `runChainId` resolves to one switch |
| Backward-compat | Agent without `routing` config: orchestrator no-ops, existing retry matrix runs unchanged; adapter without `hydrateContextEnvelope`: envelope splices into inline system prompt; `RunResult.error` on legacy adapter that doesn't return `errorClass`: orchestrator infers via `toErrorClass(error.kind)` |
| Shadow-mode | `enforceFallback = false`: events emitted, no spawn side-effects; flag flip enables enforcement without restart |
| Telemetry sink | `fallback_decision` event on every evaluate; `fallback_switch` only on switch; envelope checksum present and stable |

---

## 10. Resolved decisions (v1.1, locked by FoundingEngineer per "rozhodni ty" 2026-05-08)

The board approved v1.0 without decision note. Pepa subsequently delegated the
remaining open questions back to FoundingEngineer ("rozhodni ty" wake on internal-issue-id
2026-05-08T19:42Z). Decisions are locked here; upstream maintainers may push back
during PR review and we'll re-open if so.

### 10.1 Threshold defaults (Question Q1 from prior comment thread)

**Decision:** Keep conservative defaults verbatim — `perTaskThreshold = 2` events,
`perFleetThreshold = 3` distinct agents, `perTaskWindow = perFleetWindow = 10
minutes`, `transientRetryBudget = 3`. All exposed as core flags (`--fallback-*`)
so per-deployment tuning works without a code change.

**Rationale:** Conservative is reversible (raise the bar = more deferrals, easy
to spot in telemetry); aggressive is dangerous (false-positive cascade burns
quota across the chain in seconds, hard to roll back). Shadow-mode telemetry
will tune defaults before enforcement; if `defer_threshold` rate sits >30% for
a deployment, that deployment lowers `perTaskThreshold` to 1 via core flag
without code change.

### 10.2 `pause_and_email_ceo` notification path (Question Q2)

**Decision:** Route through existing `board-approval-interface` mechanism. No new
`Notifier` interface in v1.

**Rationale:** Board approval IS the human-attention signal in tenant's
setup; introducing a parallel `Notifier` abstraction would require a second
sink for board to watch, doubling surface for missed escalations. Upstream
maintainers may push back during PR review if they want a tenant-agnostic
abstraction (paperclip-core serves multiple companies); if so, v1.2 introduces
`Notifier` with `board-approval-interface` as the default impl. Until then, one
mechanism, one watcher.

### 10.3 Acceptance criteria for ship-to-enforcement (Question Q3)

**Decision:** §10 ship-gate criteria stay verbatim — (1) decision coverage 100%
on `quota_exhausted`, (2) `defer_threshold` rate 5–30%, (3) zero false-positive
cascades (≥3 agents in 60s absent fleet signal), (4) zero duplicate API
mutations on `${runChainId}:${stepHash}`, (5) 5 hand-crafted shadow tasks (1
per role) pass forced-exhaustion → switch → acceptanceCriteria satisfied.

**Rationale:** Each criterion is concretely measurable from the
`fallback_decision` + `fallback_switch` telemetry stream that ships with this
RFC. No human judgment calls in the gate (concrete thresholds), so promotion
to enforcement is mechanical given clean shadow data. Adding criteria slows
rollout without measurable gain; removing any opens a known failure mode that
the criterion specifically guards.

### 10.4 Threshold state lifetime (open during RFC drafting; locked v1.1)

**Decision:** In-process counters in v1, with `ThresholdStore` interface in
place from day one for HA-time swap.

**Rationale:** Single-instance paperclip-core deployments (tenant today,
most tenants) need no external store; the ~10-minute window fits in memory
trivially. The interface seam lets HA deployments swap to Redis-shaped storage
without re-architecting the orchestrator. Defaulting to in-process avoids
introducing a Redis dependency on tenants who don't need it.

### 10.5 Cross-task fairness guard (open during RFC drafting; locked v1.1)

**Decision:** No special handling in v1. Revisit only if telemetry shows
starvation.

**Rationale:** Lock is per-task; the orchestrator never holds a global lock
that could starve cross-task work. The only fairness risk is one tenant's
fallback bursts saturating the upstream provider's rate limit for another
tenant's primary — but that's a vendor-side issue, not a paperclip-core
issue. Adding a fairness guard now would be premature optimization.

### 10.6 `HydrationResult` shape (open during RFC drafting; locked v1.1)

**Decision:**

```ts
interface HydrationResult {
  success: boolean;
  tokensConsumed: number;             // counts toward new run's UsageReport
  strategy: 'inline' | 'cache_reuse' | 'session_replay';
  warnings?: string[];                // soft signals for dashboard (e.g. "envelope >50% of context window")
}
```

**Rationale:** `success` is the only field the orchestrator branches on (failed
hydration falls back to default inline splice). `tokensConsumed` is required
for cost attribution. `strategy` is the dashboard tuning signal (which paths
get used in practice). `warnings` is the escape hatch for vendor-specific soft
signals without growing the type. Upstream review can extend; shape is
designed to be additive.

### 10.7 Per-task evaluation only? (open during RFC drafting; locked v1.1)

**Decision:** Yes — `evaluate()` only sees the current task's run state. The
per-fleet axis reads aggregated counters from `ThresholdStore.fleetWindow()`,
which is population data, not per-task state.

**Rationale:** Keeps the function pure and the call boundary clean. Aggregated
counters are read-only from the orchestrator's perspective; the
classification-event sink writes them.

---

## 11. Effort split

| Workstream | Owner | Estimate |
|---|---|---|
| RFC + sign-off + board approval ask | FoundingEngineer | 1 day (this ticket) |
| Upstream PR draft (skeleton + types + shadow-mode flag) | FoundingEngineer (draft only, no commit) | 0.5 day, included in this ticket |
| **Implementation in paperclip-core** | **upstream maintainers** | ~10–14 engineer-days end-to-end |
| Lab-platform thin adapter (envelope hydration overrides for `claude_local` + `codex_local` + `gemini_local`) | FoundingEngineer (after upstream API lands) | 2 days, separate child issue |
| Cost dashboard child C (subscription/API split + fallback-frequency surface) | FoundingEngineer | 2–3 days, separate child issue (internal-issue-id+) |
| Migration (16 agents to enforcement) | CTO + ops | 2 weeks of waved rollout, separate child issue |

Total tenant-side effort spread across **3 child issues** post-approval; upstream
work is the gating dependency.

---

## 12. References

- `POLICY_LLM_USAGE.md` v5 §9.1, §9.3, §9.4, §9.6 — runtime fallback policy (board-approved 2026-05-08)
- internal issue reference — parent (board mandate)
- internal issue reference — child A: capability routing config + 3-class taxonomy (done)
- internal issue reference — RFC_ADAPTERS_v1 (precedent for upstream RFC procedure)
- internal issue reference — per-task locking invariant
- internal issue reference, internal issue reference — false-positive vs. real exhaustion threshold lessons
- `nutriadapt-lab-platform/docs/proposals/runtime_fallback_orchestrator.md` — full design doc with §-by-§ reasoning
- `nutriadapt-lab-platform/src/runtime/RuntimeAdapter.ts` — existing adapter contract (additive change targets)
- `nutriadapt-lab-platform/src/runtime/capability-routing/{types,error-class,events,defaults}.ts` — child A substrate
