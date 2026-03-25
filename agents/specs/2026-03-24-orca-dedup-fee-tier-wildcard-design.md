# Orca Dedup Fix: Fee-Tier Wildcard & Project Name Normalization

**Date:** 2026-03-24
**Status:** Approved

## Problem

The same physical Orca Whirlpool (e.g., SOL/USDC on Solana, ~$29M TVL) appears twice in liquidity results — once from DeFiLlama (`project: "orca-dex"`) and once from the direct Orca API (`project: "orca"`). This double-counts ~$29M of TVL per duplicated pool and inflates liquidity scores.

### Root Causes

**Bug 1 — Dedup gap in derived match key:**
`buildPoolIdentity()` includes `feeTierBucket` and `isStable` in the derived match key. DeFiLlama pools never provide fee tier → bucket `"na"`. Direct API pools provide a real fee rate → bucket `"1"`. The keys differ, so `getIdentityDedupReason()` finds no match. Exact match also fails because DeFiLlama uses UUID pool IDs (e.g., `a5c85bc8-eb41-...`) which `isTrustworthyExactPoolId()` rejects.

**Bug 2 — Inconsistent project name:**
`processPoolMetrics` (DeFiLlama path) stores the raw `pool.project` field (`"orca-dex"`), while `addSecondaryPoolContribution` (direct API path) stores `normalizeProtocol(pool.dexId)` (`"orca"`). The same protocol gets two display names.

## Design

### Fix 1: Relaxed derived match key

When a source doesn't know the fee tier (bucket = `"na"`) or isStable (value = `null`), these components add no discriminating value — they can only cause false negatives. The fix:

`buildPoolIdentity()` **always** emits a `relaxedDerivedMatchKey` alongside the full `derivedMatchKey`. The relaxed key omits fee tier, isStable, and pool shape family — keeping only chain + normalized protocol + sorted token addresses. This makes it a pure "same tokens, same protocol, same chain" fingerprint.

```typescript
interface PoolIdentity {
  exactPoolKey: string | null;
  derivedMatchKey: string | null;
  relaxedDerivedMatchKey: string | null;  // new: chain + protocol + tokens only
  identitySource: PoolIdentitySource;
}
```

`getIdentityDedupReason()` is extended with a third check after exact and full-derived:
1. Exact pool key match → `"exact"`
2. Full derived key match (1:1 uniqueness) → `"derived_unique"`
3. **Relaxed derived key match (1:1 uniqueness + exactPoolKey guard)** → `"relaxed_unique"` (new)

The relaxed check inherits the same guards as the full derived check:
- Both incoming and known counts must be exactly 1 (ambiguity prevention)
- The `exactPoolKey` guard from existing lines 160-163 also applies: if the incoming pool has an exact key AND the known relaxed-match pool also has an exact key, skip the relaxed match (they should have matched on exact if they were truly the same pool)

The `KnownPoolIdentityIndex` gains parallel `relaxedDerivedKeyCounts` and `relaxedDerivedToExactKeys` maps, populated by `registerKnownPoolIdentity()`.

**Cross-source safety:** The relaxed key is always generated but is intentionally coarse. The 1:1 uniqueness constraint prevents false positives: if two Uni V3 pools exist with 1bp and 5bp fee tiers on the same token pair, their relaxed keys collide → count=2 → no relaxed dedup fires. The relaxed path only activates when there is exactly one pool on each side, making it safe for the second dedup site in orchestrator (lines 416-443) as well.

**Verified:** `resolvePoolShapeFamily("orca-whirlpool")` returns `"concentrated"` for both DeFiLlama and direct API paths, so pool shape is not the issue here — but omitting it from the relaxed key future-proofs against similar mismatches.

### Fix 2: Normalize project name in processPoolMetrics

In `processPoolMetrics`, change:

```typescript
// Before
project: pool.project,

// After
project: normalizeProtocol(pool.project),
```

This aligns DeFiLlama pool display names with direct API pool display names, and with the protocol grouping already used for `protocolTvl`. No frontend component links to DeFiLlama by raw slug — the `pool.project` field is only used for display labels (confirmed at `dex-liquidity-card.tsx:216`).

## Scope

### Files changed

| File | Change |
|------|--------|
| `worker/src/cron/dex-liquidity/pool-identity.ts` | Add `relaxedDerivedMatchKey` to `PoolIdentity`, extend `KnownPoolIdentityIndex`, update `buildPoolIdentity`, `registerKnownPoolIdentity`, `getIdentityDedupReason` |
| `worker/src/cron/dex-liquidity/process-pools.ts` | Normalize `pool.project` via `normalizeProtocol()` |
| `worker/src/cron/__tests__/dex-liquidity-pool-helpers.test.ts` | Add test for relaxed dedup matching |

### Files NOT changed

- `orchestrator.ts` — no changes needed; it already passes identities through `getIdentityDedupReason()`
- `pool-contribution.ts` — already uses `normalizeProtocol()`
- Frontend — no changes; it displays `pool.project` which will now be consistent

## Testing

1. Unit test: two pool identities with matching chain/protocol/tokens but different fee tiers (`"na"` vs `"1"`) should dedup via relaxed key.
2. Unit test: two pool identities with matching chain/protocol/tokens and matching fee tiers should still dedup via full derived key (no regression).
3. Unit test: relaxed key dedup should NOT fire when there are multiple pools with the same relaxed key (ambiguity guard).
4. Unit test: relaxed key dedup should NOT fire when both incoming and known pools have distinct exact keys (exactPoolKey guard).
5. Build + typecheck pass.
6. Existing tests pass.
