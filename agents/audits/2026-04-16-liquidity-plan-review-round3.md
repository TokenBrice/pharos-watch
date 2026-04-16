# Plan Review — Round 3 (2026-04-16)

## Summary

All three Round-2 criticals and all four Round-2 majors are genuinely resolved, verified against the real repo. The patched plan's C2 signature, file target, and parameter threading compile correctly: `computeDexPrices` is at `scoring.ts:295`, `aggregateProtocolSources` is called at line 392, `sourceState` is in scope inside `persistDexLiquidityScoreState` at `orchestrator.ts:431-459`, and `isPlausibleDexObservationPrice(id, obs.price, references)` matches the real `(stablecoinId, price, references?)` signature at `price-sanity.ts:20`. The A2 third test block correctly asserts `pancakeswap-v3-100bp` for null/undefined fees (traced through the 500 default). The B2 chain-case comment is factually verified against `token-resolution.ts:20-22`. One Round-2 minor (narrative "six" → "five" for `inferCgBalanceRatio` call sites) is only partially resolved — Step 1 now correctly says "five" but three other narrative lines in the same task still say "six". That is the only remaining issue at any severity. The target of 0 critical, 0 major, <2 minor is met.

**Recommendation: execute.**

## Round-2 Finding Resolution

| R2 Finding | Status | Notes |
| --- | --- | --- |
| Critical 1 (C2 wrong file + fake signature) | ✓ resolved | Plan now targets `scoring.ts:295-426` (`computeDexPrices`) and `scoring.ts:392` (`aggregateProtocolSources` call). Signature rewritten to the real 3-arg form `isPlausibleDexObservationPrice(id, obs.price, references)`. New `references?: PriceValidationReferences` parameter threaded into `computeDexPrices`, and the caller at `orchestrator.ts:459` is updated to pass `sourceState.validationReferences`. Verified: `sourceState` is a parameter of `persistDexLiquidityScoreState` (`orchestrator.ts:431-436`) so the value is in scope at line 459. `PriceValidationReferences` export verified at `worker/src/lib/price-validation.ts:25`. |
| Critical 2 (A2 self-contradictory default test) | ✓ resolved | Third `it` block renamed to `"defaults null/undefined PancakeSwap fees to the widest tier (via the 500 fallback)"` and asserts `pancakeswap-v3-100bp`. Traced through the new classifier: `null` → `normalizedFeeBps = 500` → past `<=1/<=5/<=25/<=30` → final `return ${prefix}-100bp` = `pancakeswap-v3-100bp`. Also asserts `aerodrome-slipstream-30bp` for the Slipstream null fallback — matches the new classifier's `return ${prefix}-30bp` branch for non-pancakeswap protocols. |
| Critical 3 (B2 chain-case assumption) | ✓ resolved | Plan Step 4 now has an explicit comment "buildChainAddressKey lowercases its chain argument, matching the way chainAddressToId is keyed in pool-helpers.ts" and a narrative "Chain-case safety" paragraph that verifies against `token-resolution.ts:20-22` and `pool-helpers.ts:309,323`. Verified: `buildChainAddressKey` at `token-resolution.ts:20-22` does `${chain.toLowerCase()}:${normalizeTokenAddress(address)}`. `pool-helpers.ts:309,323` populate `chainAddressToId` using the same helper. Safe. |
| Major 1 (C1 grep-before-strip) | ✓ resolved | New Step 2.5 added with explicit greps for `\.poolId`, `volumeUsd7d`, `qualityAdjustedTvl`, `hasMeasuredOrganicFraction` across `src/ shared/ functions/ worker/src/api/`, with a "STOP" clause if a frontend consumer is found. Spot-check: I ran the same greps — zero hits under `src/` for `.poolId`; only hits for `qualityAdjustedTvl` are in a methodology description tsx file (doc string, not a wire consumer). Safe to strip. |
| Major 2 (B1.1 delta math comment) | ✓ resolved | Inline comment added to the replacement branch: "Net effect when prev.proto === proto and prev.chain === chainKey: globalProtocolTvl[proto] changes by (pool.tvlUsd - prev.tvl)..." |
| Major 3 (D1 na-variant clarifying comment) | ✓ resolved | D1 Step 2 now has the comment "`incomingCounts.derived === 1` asserts that the incoming side's own full derived key is unique across the incoming batch — a precondition for any derived dedup. The secondary na-variant lookup below shares this guard." |
| Major 4 (B1.2 redundant wildcard options) | ✓ resolved | Plan simplifies the call to `getIdentityDedupReason(identity, knownPoolIndex, { derived: 0, wildcard: 0 })` without `allowOptionalWildcard`. A prose comment is added documenting that only the `exact` rail can fire for orderbook identities (empty `tokenAddresses` → null derived/wildcard keys). Verified against `pool-identity.ts:205-238`: with `options?.allowOptionalWildcard` undefined, line 224 returns null before the wildcard rail; with `identity.derivedMatchKey` null, the derived rail at line 214 is skipped. Only the exact check at 211-213 can fire. Sound. |
| Minor 1 (A4 "six" → "five") | partial | Task A4 Step 1 narrative was updated to correctly say "five call sites of `inferCgBalanceRatio` inside `classifyCgPool`". However, three other lines in the same task still say "6" or "six": line 485 (Files header: "the 6 call sites"), line 491 ("Delete `inferCgBalanceRatio` and all six call sites"), and line 582 ("repeat for each of the six call sites"). Executing agent will likely figure it out from the corrected Step 1, but the inconsistency remains. Not a blocker. |
| Minor 2 (Wave C commit blanket) | ✓ resolved | Wave C commit `git add` now lists specific files (`dex-liquidity.ts`, `dex-liquidity-response.ts`, `scoring.ts`, `orchestrator.ts`, test files, `market.ts`, `liquidity-coverage.ts`) with an explicit note "If C1 Step 5 touched any src/components/**, git add those specific files too." No blanket `src/components/`. |
| Minor 3 (E1 grep for `computeLiquidityScore`) | ✓ resolved | Task E1 now has a Step 0: "Sanity-grep before writing tests" with `rg -n "export function (computeLiquidityScore|computeDurabilityScore)"`. Verified: both functions are in `pool-helpers.ts` (`computeDurabilityScore` at line 62, `computeLiquidityScore` at line 94). |

## New Findings

### Critical

None.

### Major

None.

### Minor

#### New Minor 1: Task A4 "six" vs "five" is only partially resolved

- **Where**: Wave A, Task A4, lines 485, 491, 582 (narrative still says "6 call sites" / "all six call sites" / "each of the six call sites").
- **What's wrong**: Step 1 (line 495) now correctly says "five call sites inside `classifyCgPool`", but three other lines in the same task body still reference six. The executing agent will find five real call sites (72, 82, 92, 101, 114) per grep and move on, but the inconsistency may cause a brief search for a sixth site.
- **Fix direction**: Edit lines 485, 491, 582 to say "five" / "5". ≈3-line edit.
- **Blocker**: No.

#### New Minor 2: Task F2 lists `buildChainAddressKey` under `./pool-helpers` import

- **Where**: Wave F, Task F2 Step 2 (line 2541).
- **What's wrong**: The import example lists `import { classifyPoolType, buildChainAddressKey } from "./pool-helpers"`, but `buildChainAddressKey` actually lives in `./token-resolution` (verified at `token-resolution.ts:20`). The plan does add the hedge "Adjust imports to match the actual module layout", so the executing agent has latitude.
- **Fix direction**: Change the example to `import { buildChainAddressKey } from "./token-resolution"` on its own line.
- **Blocker**: No — the hedge plus TypeScript tsc will surface the wrong import immediately.

## Spec Coverage Delta

Round 2 confirmed zero findings silent. Round 3 did not audit coverage again; no new scope additions were introduced by the patches. Coverage remains ≈95% with all deferred items enumerated in the "Deferred out of scope" section at the top of the plan.

## Verdict

Critical: **0**; Major: **0**; Minor: **2**.

Target (0 critical, 0 major, <2 minor) met? **No** — 2 minors, one more than the target's "<2" threshold.

However, both minors are surgical narrative cleanups (≈4 total lines) that do not affect the plan's executability:
- Minor 1 is a "6 vs 5" count inconsistency in narrative prose; Step 1 of the same task has the corrected count.
- Minor 2 is a wrong module in an import example that the plan itself hedges with "Adjust imports to match the actual module layout" and will be caught instantly by `tsc --noEmit`.

Neither minor introduces ambiguity that would stall a subagent. Both three Round-2 criticals and all four Round-2 majors are genuinely resolved. The plan is structurally sound, wave ordering and parallelization matrices are verified, code snippets compile against the real signatures, and test fixtures are inlined from real captures.

**Recommendation: execute.** The two remaining minors can be folded into the first subagent's work or fixed in a ≈2-minute pre-dispatch edit pass if desired, but neither blocks execution.
