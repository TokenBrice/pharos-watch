# Orca / Orca-Dex Dedup Fix, Corrected Safe Design

**Date:** 2026-03-24
**Status:** Proposed
**Supersedes:** `agents/specs/2026-03-24-orca-dedup-fee-tier-wildcard-design.md`

## Goal

Deduplicate the same physical Orca Whirlpool when it appears once from DeFiLlama (`project: "orca-dex"`) and once from the direct Orca API (`source: "orca"`), without broadening pool-identity matching enough to collapse legitimate same-pair parallel pools elsewhere in the pipeline.

This design also fixes the display inconsistency where the same protocol can render as both `orca-dex` and `orca` in top-pool rows.

## Problem Summary

The current duplicate survives for two independent reasons:

1. **Project normalization mismatch**
   - The DeFiLlama path stores `pool.project` verbatim in `topPools`.
   - The secondary/direct path stores `normalizeProtocol(pool.dexId)`.
   - For the same physical Orca pool this yields `orca-dex` vs `orca`.

2. **Derived identity is too strict when one side lacks optional metadata**
   - `buildPoolIdentity()` includes:
     - chain
     - normalized protocol
     - sorted token addresses
     - pool shape family
     - fee-tier bucket
     - stable/volatile flag
   - The DeFiLlama Orca row has no fee tier, so it gets `feeTierBucket = "na"`.
   - The direct Orca row has a real fee tier, so it gets a concrete bucket.
   - Exact match does not help because the DeFiLlama pool id is an opaque UUID that is intentionally rejected by `isTrustworthyExactPoolId()`.

The original wildcard plan was directionally right but too broad and incomplete:

- it claimed no orchestrator changes were needed, which is false because dedup callers only skip on `"exact"` and `"derived_unique"`
- it proposed a relaxed key that also dropped pool shape, which is wider than required for the Orca bug
- it did not carry relaxed incoming-count logic through every dedup call site
- applying a broad relaxed key to staged and fallback merges would materially increase false-positive risk under partial source coverage

## Corrected Design

### 1. Keep the existing exact and full-derived identity paths

Do not weaken the current `exactPoolKey` or `derivedMatchKey` behavior.

Existing precedence remains:

1. exact pool id match
2. full derived match when unique on both sides

These paths are already correct and should remain the default for all source families.

### 2. Add a narrowly scoped optional-metadata wildcard key

Add a second derived key to `PoolIdentity` for one specific case: two sources agree on the physical pool identity except that one side is missing optional discriminator metadata.

Suggested shape:

```ts
interface PoolIdentity {
  exactPoolKey: string | null;
  derivedMatchKey: string | null;
  optionalWildcardKey: string | null;
  hasMissingOptionalIdentityFields: boolean;
  identitySource: PoolIdentitySource;
}
```

Build `optionalWildcardKey` as:

- chain
- normalized protocol
- sorted token addresses
- pool shape family

Deliberately **do not** drop:

- chain
- normalized protocol
- token addresses
- pool shape family

Deliberately **do** drop only:

- fee-tier bucket
- stable/volatile flag

Rationale:

- Pool shape is not the source of the Orca bug and still helps keep CLMM / stable / generic families distinct.
- The problematic fields here are the optional enrichments that can be absent upstream (`feeTierBps`, `isStable`).

Add:

```ts
hasMissingOptionalIdentityFields =
  resolveFeeTierBucket(input.feeTierBps) === "na" ||
  input.isStable == null;
```

This keeps the wildcard path tied to missing metadata, not to any arbitrary same-pair collision.

### 3. Make wildcard dedup opt-in and use it only for direct-API vs DeFiLlama overlap

Do **not** enable wildcard dedup globally in `getIdentityDedupReason()` with no guardrails.

Instead, extend the dedup API so callers explicitly choose whether wildcard matching is allowed:

```ts
function getIdentityDedupReason(
  identity: PoolIdentity,
  known: KnownPoolIdentityIndex,
  counts: {
    derived: number;
    wildcard: number;
  },
  options?: {
    allowOptionalWildcard?: boolean;
  },
): "exact" | "derived_unique" | "derived_optional_wildcard" | null
```

Enable `allowOptionalWildcard: true` only in the two direct-API-vs-primary merge sites:

- `filterPrimaryPoolsPreferDirectApi()` in `worker/src/cron/dex-liquidity/orchestrator.ts`
- the later direct-API retention loop in `syncDexLiquidity()` in `worker/src/cron/dex-liquidity/orchestrator.ts`

Leave it **disabled** for:

- staged-pool merge
- DexScreener fallback merge
- any future fallback/discovery source merge

Rationale:

- The Orca duplication is a DL vs direct-API primary overlap problem.
- Staged and fallback sources are more vulnerable to partial-coverage uniqueness illusions.
- The safer fix is to narrow wildcard dedup to the source boundary that actually needs it.

### 4. Extend the known-index structure and incoming counts for wildcard matching

The wildcard path is only safe if uniqueness is checked on both sides, just like the full-derived path.

Add parallel wildcard maps:

```ts
interface KnownPoolIdentityIndex {
  exactKeys: Set<string>;
  derivedKeyCounts: Map<string, number>;
  derivedToExactKeys: Map<string, Set<string>>;
  wildcardKeyCounts: Map<string, number>;
  wildcardToExactKeys: Map<string, Set<string>>;
}
```

Add a generic helper or a second count helper so callers can compute both:

- incoming full-derived count
- incoming wildcard-key count

Every dedup call site must pass both counts, even if wildcard matching is disabled there.

Affected call sites:

- `worker/src/cron/dex-liquidity/orchestrator.ts`
- `worker/src/cron/dex-liquidity/staging-merge.ts`
- `worker/src/cron/dex-liquidity/fetch-fallbacks.ts`

### 5. Wildcard dedup conditions

`derived_optional_wildcard` may fire only when all of the following are true:

1. `allowOptionalWildcard === true`
2. `identity.optionalWildcardKey` exists
3. `identity.hasMissingOptionalIdentityFields === true`
4. incoming wildcard count is exactly `1`
5. known wildcard count is exactly `1`
6. exact match did not already fire
7. full derived match did not already fire
8. if both sides have trustworthy exact keys, do not wildcard-match them

Suggested exact-key guard:

- if `identity.exactPoolKey` exists and the matched known wildcard bucket contains any exact key, return `null`

This preserves the existing logic that two pools with distinct trustworthy exact ids should not be collapsed by a weaker heuristic.

Note the asymmetry here is intentional:

- the wildcard path exists to help the identity-poor side
- the side missing optional metadata must be the side requesting wildcard dedup

That requirement prevents the richer side from using a coarse key to erase a second distinct pool that happens to be absent from the observed subset.

### 6. Update all skip sites to recognize the new dedup reason

Where wildcard matching is enabled, callers must treat `"derived_optional_wildcard"` the same way they currently treat `"derived_unique"` for skip accounting.

In `orchestrator.ts`, add:

- a counter for wildcard skips in the primary-preference phase
- a counter for wildcard skips in the later direct-API merge phase
- logging that distinguishes exact, full-derived, and wildcard-derived skips

If metadata/status reporting is extended later, the wildcard count can be surfaced separately. That is optional for the first patch.

### 7. Normalize protocol display in `processPoolMetrics`

In `worker/src/cron/dex-liquidity/process-pools.ts`, change:

```ts
project: pool.project,
```

to:

```ts
project: protocol,
```

where `protocol` is already computed as `normalizeProtocol(pool.project)`.

This is low-risk and aligns the DeFiLlama path with:

- direct API pools in `pool-contribution.ts`
- protocol TVL grouping in the same function
- frontend top-pool rendering in `src/components/dex-liquidity-card.tsx`

This display change is independent of dedup correctness and should ship with the dedup fix.

## Why This Is Safer Than the Original Plan

### Safer than a fully relaxed key

The original plan dropped fee tier, stable flag, and pool shape from the relaxed key. This version keeps pool shape and only wildcards the dimensions that are known to be optional enrichments.

### Safer than global wildcard dedup

The original plan would have applied the relaxed path to the same generic dedup helper used by staged and fallback merges. This version only enables wildcard dedup where the Orca bug actually occurs: direct-API vs DeFiLlama precedence.

### Safer under partial coverage

Wildcard dedup still has some residual risk because uniqueness is observed, not absolute. Restricting it to:

- identity-poor incoming pools only
- direct-API vs primary overlap only
- exact same protocol normalization
- exact same chain
- exact same token set
- exact same pool-shape family

keeps the blast radius much smaller than a pipeline-wide relaxed-key policy.

## Files To Change

| File | Change |
|------|--------|
| `worker/src/cron/dex-liquidity/pool-identity.ts` | Add `optionalWildcardKey`, `hasMissingOptionalIdentityFields`, wildcard count maps, wildcard dedup logic, updated return union |
| `worker/src/cron/dex-liquidity/orchestrator.ts` | Compute wildcard incoming counts, enable wildcard dedup only for direct-API vs primary paths, handle new skip reason, update logging |
| `worker/src/cron/dex-liquidity/staging-merge.ts` | Pass wildcard incoming counts but keep wildcard dedup disabled |
| `worker/src/cron/dex-liquidity/fetch-fallbacks.ts` | Pass wildcard incoming counts but keep wildcard dedup disabled |
| `worker/src/cron/dex-liquidity/process-pools.ts` | Normalize `topPools.project` via `normalizeProtocol()` |
| `worker/src/cron/dex-liquidity/__tests__/...` | Add identity tests and orchestrator-level dedup tests |

## Testing

### Identity tests

Add focused tests around `pool-identity.ts`:

1. Exact match still wins when trustworthy pool ids match.
2. Full derived match still deduplicates when fee tier and stable flag agree.
3. Wildcard dedup fires for Orca-style overlap:
   - same chain
   - same normalized protocol (`orca-dex` vs `orca`)
   - same token addresses
   - same pool shape family
   - incoming side missing fee tier
   - wildcard counts unique on both sides
4. Wildcard dedup does not fire when the incoming side has complete optional identity fields.
5. Wildcard dedup does not fire when wildcard key count is greater than `1` on either side.
6. Wildcard dedup does not fire when both sides have distinct trustworthy exact keys.
7. Wildcard dedup does not fire when pool shape differs.

### Merge-path tests

Add higher-level tests for `filterPrimaryPoolsPreferDirectApi()` or the surrounding orchestrator helpers:

1. DeFiLlama Orca duplicate is removed when direct API has the same physical pool with a real fee tier.
2. A same-token-pair multi-pool scenario does not collapse when the wildcard bucket is ambiguous.
3. Staged/fallback merges still require exact or full-derived identity and do not start using the wildcard path accidentally.

### Process-pool display test

Add or update a `processPoolMetrics()` test verifying that a DeFiLlama Orca pool now serializes `project: "orca"` into `topPools`.

### Validation

Before implementation is declared complete:

1. `npm test`
2. `npm run lint`
3. `npm run build`
4. `cd worker && npx tsc --noEmit`

If the implementation changes persisted methodology semantics or documentation wording around dedup behavior, update:

- `docs/dex-liquidity.md`
- `docs/liquidity-score-timeline.md`

## Non-Goals

- Do not change `isTrustworthyExactPoolId()`. Rejecting opaque DeFiLlama UUIDs is still correct.
- Do not introduce a global same-pair relaxed fingerprint for all source families.
- Do not broaden wildcard dedup to staged, DexScreener, GeckoTerminal, or CoinGecko fallback merges in this patch.
- Do not change score weights, protocol multipliers, or balance logic.

## Expected Outcome

After this change:

- the duplicated SOL/USDC Orca Whirlpool is counted once
- the retained pool uses the stronger direct-API row when appropriate
- `topPools.project` renders consistently as `orca`
- the broader dedup model remains conservative for staged and fallback sources
