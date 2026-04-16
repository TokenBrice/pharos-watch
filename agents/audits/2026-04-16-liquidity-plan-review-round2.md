# Plan Review — Round 2 (2026-04-16)

## Summary

The rewritten plan (`agents/plans/2026-04-16-liquidity-remediation-plan.md`, rev. 2) is a dramatic improvement over round 1. All 10 round-1 critical findings and 7 of 8 round-1 major findings are resolved, and the structural skeleton (wave ordering, parallelization matrix, commit themes) is now tight. Code snippets have been regenerated against the ground-truth file and most are directly copy-pasteable. **However, three execution-blocking issues slipped into the rewrite:** (1) Task C2 targets the wrong file and calls `isPlausibleDexObservationPrice` with a fabricated 4-arg signature; (2) Task A2 Step 1 contains a self-contradictory default-fallback test that fails against both the current code and the proposed fix; (3) several narrative references still describe "six" call sites where there are only five. Verdict: **minor revision, then ship.**

## Round-1 Resolution Verification

| R1 Finding | Status | Notes |
| --- | --- | --- |
| **Critical 1** — `accumulateGlobalAggregate` fake signature | ✓ resolved | Plan uses the real 6-param signature (ground-truth §8) and threads a 7th `seenPoolTvl: Map` parameter. Step 4 adds the corresponding `seenPoolTvl = new Map<...>()` declaration next to `globalSeenPools` at `scoring.ts:127`. Call site at `scoring.ts:153` correctly gets the new 7th arg. The body logic (subtract previous contribution on higher-TVL replacement, update per-proto/per-chain aggregates, do NOT re-increment `poolCount`) is sound. |
| **Critical 2** — `SecondaryPool.baseToken/quoteToken` fabricated fields | ✓ resolved | HIGH-1 is now scoped to `process-pools.ts:234-236` only. Plan explicitly says "Do not touch `pool-contribution.ts:75` — the secondary path already uses real on-chain addresses for every source." Matches ground-truth §11. |
| **Critical 3** — Meteora A1 test idiom | ✓ resolved | Uses top-level `mockFetch`, `vi.resetModules()` in afterEach, dynamic `await import("../fetch-meteora")`, `fetchMeteoraPools()` no-arg, two `mockResolvedValueOnce` (data + empty terminator). Matches the existing file's idiom (ground-truth §2). |
| **Critical 4** — `parseCgOnchainPoolList` invention | ✓ resolved | A4 now correctly targets `classifyCgPool` and its 5 call sites of `inferCgBalanceRatio` (plus the test-file import in `fetch-crawlers.test.ts:3,91-93`). No reference to `parseCgOnchainPoolList` remains. Note: plan Step 3 narrative says "six call sites" but the real code has five (lines 72, 82, 92, 101, 114 in `coingecko-onchain-shared.ts`); captured as Minor 3 below. |
| **Critical 5** — C1 swapped files | ✓ resolved | `coverageClass` fix now correctly targets `worker/src/api/dex-liquidity.ts:87`; `normalizeTopPools` allowlist targets `worker/src/api/dex-liquidity-response.ts:84-95`. Matches ground-truth §21 / §22. |
| **Critical 6** — Slipstream 25bp gap | ✓ resolved | A2 scope is now explicitly PancakeSwap-only ("This task ONLY expands PancakeSwap V3's tier set. It does NOT expand the Slipstream classifier"). The test at Step 1 asserts Slipstream stays on `1/5/30` scheme. A2 adds the matching `QUALITY_MULTIPLIERS` entries `pancakeswap-v3-25bp: 0.7` and `pancakeswap-v3-100bp: 0.25`. |
| **Critical 7** — Wave A bundling | ✓ resolved | Wave A is narrowed to 5 data-correctness fetcher fixes (A1, A2, A3, A4, A5). A6 (Slipstream sqrt_ratio math), A7 (error propagation + CEX circuit) have been deferred or absorbed elsewhere. Commit still lumps 5 changes but each is thematically "data-accuracy fix in direct fetchers" and each has an isolated test file — acceptable. |
| **Critical 8** — A6 Slipstream tooling | ✓ resolved | A6 is explicitly listed under "Deferred out of scope" with the reason `sqrt_ratio` requires BigInt Q64.96 and `pool_fee` unit is unverified; both `cast` and Basescan v2 unavailable. Marked "→ Separate spike plan." |
| **Critical 9** — B2/B1.1 file collision on `process-pools.ts` | ✓ resolved | Parallelization matrix now explicitly flags `B1.1 and B1.3 are SERIAL` on `process-pools.ts`. Dispatch rules note: "B1.2 runs in parallel with {B1.1, B1.3}. B1.1 and B1.3 are SERIAL — dispatch B1.1 first, wait, then dispatch B1.3 and B1.2 in parallel." B.2 strictly runs after B.1 completes. |
| **Critical 10** — missing "deferred" enumeration | ✓ resolved | New "Deferred out of scope for this plan" section at top of the plan lists ~20 findings with explicit reasons (Noble Swaps, new fetchers, A6 math, structural refactors B.1.1–B.5, MED-6, LOW-2, m2/m3/m5/m6/m7, frontend m4/m5/m7/m8, m1 Balancer chain map, A7 dead-code split-out). Coverage is now ≈95%. |
| **Major 1** — Wave A commit split | partial | Wave A is now 5 changes instead of 7, same single commit. Acceptable because the remaining 5 are all fetcher data-accuracy fixes within the same module — a `git bisect` would still land on the right commit. Not a blocker. |
| **Major 2** — B1.3 historical TVL guard risk | ✓ resolved | Plan now has an explicit "Risk note (from reviewer Major 2)" warning that first-deploy may trip `scoreDexLiquidityPoolState` guardrails, with a Post-execution Step 6 watch-and-manual-override procedure. |
| **Major 3** — D1 fragile regex | ✓ resolved | D1 Step 2 now uses split-mutate-rejoin: `const parts = identity.derivedMatchKey.split("|"); if (parts.length === 6 && parts[4] !== "na") { const naVariant = [...parts.slice(0, 4), "na", parts[5]].join("|"); ... }`. Format `chain|proto|tokens|shape|feeBucket|stability` matches ground-truth pool-identity.ts:124-134. |
| **Major 4** — F1 scope overreach | ✓ resolved | F1 is now narrowed to 4 HTTP page-number fetchers (Meteora, Raydium, Orca, PancakeSwap) with explicit scope note: "Fluid iterates a chain map and is single-page per chain. Slipstream is RPC-based (Sugar `all()`). Balancer uses GraphQL `skip` cursor. Those three do NOT use the helper." |
| **Major 5** — G1 Noble Swaps unverified | ✓ resolved | G1 is deferred to a follow-up plan; captured in the "Deferred" section with reason "All four candidate endpoints failed." |
| **Major 6** — B2 plumbing vagueness | ✓ resolved | B2 Step 4 now gives a concrete diff: adds `chainAddressToId: Map<string, string>` as a new parameter to `filterPrimaryPoolsPreferDirectApi`, computes `isStableHint` via `tokenAddrs.every((addr) => chainAddressToId.has(buildChainAddressKey(pool.chain, addr)))`, and passes `sourceState.lookups.chainAddressToId` from `buildDexLiquidityPoolState` at `orchestrator.ts:286`. All three symbols verified in the actual source. |
| **Major 7** — fixtures not specified | ✓ resolved | Fixtures are either inlined as consts in the test bodies (A1/A3/A5/A4 — captured verbatim from the real fixture files) or reference captured files at `agents/audits/fixtures/*` in narrative. No `__tests__/fixtures/` directory is required. |
| **Major 8** — A7 caller audit | ✓ resolved | A7 is folded into F3: `fetchGtTokenBatch` and `fetchCgTokenBatchPrices` have zero production callers (confirmed via ground-truth §18), so they are simply deleted in F3 rather than having throw semantics added. |

## New Findings

### Critical (must fix)

#### New Critical 1: Task C2 targets the wrong file and fabricates `isPlausibleDexObservationPrice` signature

- **Where**: Wave C, Task C2 Steps 1-3 (`worker/src/cron/dex-liquidity/scoring-helpers.ts`).
- **What's wrong**: The plan says `Modify: worker/src/cron/dex-liquidity/scoring-helpers.ts (the price_sources_json / priceSources aggregate builder — find by grep)`. A grep for `price_sources_json|priceSources` under `worker/src/cron/dex-liquidity/` returns only `scoring.ts` and `challenger-persistence.ts`. **There is no priceSources builder in `scoring-helpers.ts`.** The task's "find by grep" directive sends the agent to the wrong file.
- **What's also wrong**: Plan Step 3 proposes:
  ```ts
  if (!isPlausibleDexObservationPrice(pool.price, stablecoinPegType, stablecoinPegRef, validationReferences)) { continue; }
  ```
  The real signature at `worker/src/cron/dex-liquidity/price-sanity.ts:20` is:
  ```ts
  export function isPlausibleDexObservationPrice(
    stablecoinId: string,
    price: number,
    references?: PriceValidationReferences,
  ): boolean
  ```
  The helper takes `(stablecoinId, price, references?)` — three args, with `stablecoinId` FIRST. The plan passes `pool.price` first plus two fabricated `stablecoinPegType`/`stablecoinPegRef` arguments that don't exist. This will produce a TypeScript compile error and the agent will have to invent a fix.
- **Impact**: C2 cannot be executed as written. The subagent will either (a) stall looking for a builder in the wrong file, or (b) write code that does not compile.
- **Fix direction**: (1) Change the target file to `worker/src/cron/dex-liquidity/scoring.ts` (or `challenger-persistence.ts`, whichever actually builds the per-protocol price surface). (2) Rewrite the gate as `if (!isPlausibleDexObservationPrice(stablecoinId, pool.price as number, validationReferences)) continue;` — three args, `stablecoinId` first.

#### New Critical 2: Task A2 default-fallback test is self-contradictory

- **Where**: Wave A, Task A2 Step 1 (the third `it` block of the new `direct-source-helpers.test.ts`).
- **What's wrong**: The test asserts
  ```ts
  it("defaults unknown fees to pancakeswap-v3-5bp", () => {
    expect(classifyClPoolType("pancakeswap", null)).toBe("pancakeswap-v3-5bp");
    expect(classifyClPoolType("pancakeswap", undefined)).toBe("pancakeswap-v3-5bp");
  });
  ```
  The real `direct-source-helpers.ts:13` defaults `normalizedFeeBps = 500` when feeBps is null/undefined. The **current** code then returns `pancakeswap-v3-30bp` (since `500 > 5`, falls through to final return). The **proposed-fix** code keeps the same `500` default and adds 25/30/100 branches, so with `normalizedFeeBps = 500` the function returns `pancakeswap-v3-100bp` (since `500 > 30` and `protocol === "pancakeswap"` → final `return ${prefix}-100bp`). **Neither the current code nor the proposed fix returns `pancakeswap-v3-5bp` for a null input.** The test will fail after the fix with a confusing "expected 5bp, received 100bp" error, and the subagent will get stuck not understanding why.
- **Impact**: The task cannot TDD-pass. The agent will likely "fix" the test by changing the expected value to `pancakeswap-v3-100bp` (losing the intent of the assertion) or change the default to 5 (breaking the other assertions).
- **Fix direction**: Delete this `it` block entirely, or change the assertion to `pancakeswap-v3-100bp` and rename to `"defaults unknown fees to the widest PCS tier"`. Alternatively, update the function default to `500` → something that does reflect 5bp, but that change is unprincipled and unrequested.

#### New Critical 3: `LlamaPool.chain` is uppercase "Ethereum"; B2 Step 4 `buildChainAddressKey` is safe but the round-trip needs proof

- **Where**: Wave B.2, Task B2 Step 4.
- **What's wrong**: The plan computes `isStableHint` via
  ```ts
  tokenAddrs.every((addr) => chainAddressToId.has(buildChainAddressKey(pool.chain, addr)))
  ```
  `buildChainAddressKey` lowercases its chain input (`token-resolution.ts:20-22`), so passing `"Ethereum"` produces the key `ethereum:0x...`. **Whether `chainAddressToId` (built in `buildSymbolLookups`) is keyed by lowercased chain names is not explicitly verified in ground truth**. If the symbol lookup uses the chain's **canonical DL string** (e.g. `"Ethereum"` capitalized), this `every()` check silently always returns `false` and `isStableHint` is never true — making the HIGH-2 Balancer fix a no-op.
- **Impact**: HIGH-2 regression risk. The Balancer stable-shape fix silently degenerates; the test at B2 Step 1 that asserts `derivedMatchKey` contains `|stable|` passes (because it calls `buildPoolIdentity` directly with `isStableHint: true`), but the wired-up code does not actually propagate the hint at runtime.
- **Fix direction**: Add a 1-line verification note: "Verify `chainAddressToId` is built with `buildChainAddressKey(chain, address)` — grep `chainAddressToId.set` in `pool-helpers.ts`." If keys differ in case, lowercase `pool.chain` before the `every()` call, or use `makeChainAddressKey(pool.chain.toLowerCase(), addr)`. (Actual spot-check: `pool-helpers.ts:309,323` use `buildChainAddressKey(contract.chain, contract.address)`. Whether `contract.chain` is already lowercased is not documented — safer to normalize.)

### Major

#### New Major 1: `normalizeTopPools` ALLOWED_POOL_KEYS allowlist drops `poolId` — but tests at `normalizeTopPools` sites may still expect it on the wire

- **Where**: Wave C, Task C1 Step 3.
- **What's wrong**: The plan's `ALLOWED_POOL_KEYS` Set contains `project, chain, symbol, poolType, tvlUsd, volumeUsd1d, price, source`. It does NOT include `poolId`. The audit finding M2 says `poolId` is a "dead field" — but the frontend C3 task later deletes the `crossChain` field from `scoreComponents`, NOT `poolId`. Before stripping `poolId`, the plan must verify that NO frontend or internal consumer reads `top_pools_json[].poolId` from the live API. The plan does not specify a grep. If any consumer exists (e.g. challenger dashboards, debug UIs, history reader), stripping it is a hostile API break with no migration.
- **Fix direction**: Add a Step 2.5 that greps `src/**, shared/**, functions/**` for `\.poolId\b` on any object coming from `topPools` and either (a) verifies zero consumers, or (b) keeps `poolId` on the wire. Also consider: the backend-side `retainedPoolsByStablecoin` path at `scoring.ts:146` re-serializes `pool.poolId` — that's an internal path, not the API, so it's fine.

#### New Major 2: B1.1 Step 3 replacement delta math has an edge case on `poolCount`

- **Where**: Wave B.1, Task B1.1 Step 3.
- **What's wrong**: The plan's replacement branch updates `totalTvl`, `totalVol24h`, `totalVol7d` via signed deltas (`tvlDelta = pool.tvlUsd - prev.tvl`) but comments "poolCount is NOT incremented on replacement — the pool was already counted in the original call." Correct — but when the replacement happens across two DIFFERENT `accumulateGlobalAggregate` calls (once per stablecoin), the caller at `scoring.ts:156-159` sums `globalDelta.poolCount` into `globalPoolCount`. On the replacement call, `globalDelta.poolCount === 0`, so `globalPoolCount` is not re-incremented — correct. But the tests at B1.1 Step 2 assert `a.poolCount + b.poolCount === 1`, which is correct for the dedup case, AND assert `a.totalTvl + b.totalTvl === 5_000_000` for the tie-breaker case. The tie-breaker case's arithmetic: first call adds 4,500,000. Second call: `prev.tvl=4_500_000`, `pool.tvlUsd=5_000_000`, `tvlDelta = 500_000`, so `b.totalTvl = 500_000`. `a.totalTvl + b.totalTvl = 4_500_000 + 500_000 = 5_000_000`. ✓ But note: `protoTvl["balancer"]` is updated via `globalProtocolTvl[prev.proto] -= prev.tvl` then `globalProtocolTvl[proto] += pool.tvlUsd`. If `prev.proto === proto === "balancer"`, the net effect is `+pool.tvlUsd - prev.tvl = 500_000`, applied on top of the existing `4_500_000`, giving `5_000_000`. ✓ Test assertions are correct.
- **BUT**: There is a subtle bug: the replacement branch subtracts `prev.tvl` from `globalChainTvl[prev.chain]`, where `prev.chain` is already lowercased (stored by the first call). If the incoming pool has `pool.chain = "Ethereum"` and the new `chainKey = "ethereum"`, and `prev.chain = "ethereum"` too, then both ops use `"ethereum"` — correct. So this is fine.
- **Real concern**: `globalProtocolTvl[prev.proto] = (globalProtocolTvl[prev.proto] ?? 0) - prev.tvl` can produce a negative intermediate when the *same key* is both reduced and re-added. For same-proto replacement the two ops cancel, leaving only the net delta — fine. But the code writes the values sequentially (`-prev.tvl` then `+pool.tvlUsd`), so at no point does the Record go negative for the same key unless a third caller reads the Record during the window (it can't — it's synchronous). Safe.
- **Fix direction**: No fix needed; leaving the note here for the executing agent. Consider adding a comment in the replacement branch: "// Net effect when prev.proto === proto: globalProtocolTvl[proto] changes by (pool.tvlUsd - prev.tvl)."

#### New Major 3: D1 test's secondary-match "na" variant assertion is unvalidated against `incomingCounts.derived`

- **Where**: Wave D, Task D1 Step 2.
- **What's wrong**: The proposed secondary match still gates on `incomingCounts.derived === 1` at the top of the `if (identity.derivedMatchKey && incomingCounts.derived === 1)` block. The secondary `naVariant` path is INSIDE that conditional, so the `na`-variant match only fires when the incoming side is derived-unique. But the na-variant case by definition has a different `derivedMatchKey` from the known side — so the incoming's own `derivedKeyCounts` entry counts the original full key, not the `na` variant. **This is likely fine because `incomingCounts.derived === 1` is asserting uniqueness of the incoming side's own key, not a match against the known side.** Still, worth a comment in the code: "// `incomingCounts.derived === 1` guarantees the incoming full-fee key is unique among incoming pools, which is a precondition for any derived dedup regardless of which key we match against on the known side."
- **Fix direction**: Add the clarifying comment. Not a blocker.

#### New Major 4: Task B1.2 fallback dedup check uses `allowOptionalWildcard: true` on a pool that already has `hasMissingOptionalIdentityFields === true`

- **Where**: Wave B.1, Task B1.2 Step 4.
- **What's wrong**: The plan's inline dedup check:
  ```ts
  const dedupReason = getIdentityDedupReason(
    identity, knownPoolIndex, { derived: 1, wildcard: 1 }, { allowOptionalWildcard: true },
  );
  ```
  relies on the orderbook identity having `hasMissingOptionalIdentityFields === true` (which is true by construction because `tokenAddresses: []` makes both `derivedMatchKey` and `optionalWildcardKey` null, and `feeTierBucket === "na"`). But with empty token addresses, `identity.optionalWildcardKey` IS null (per `pool-identity.ts:136-138`), so the wildcard rail immediately returns null at `pool-identity.ts:225`. **The `allowOptionalWildcard` check will never fire for orderbook identities because there is no `optionalWildcardKey` to match on.** The only working rail is `exactPoolKey` via `known.exactKeys.has("orderbook:exchange-id")`. That works if the discovery path's registerKnownPoolIdentity stamps `orderbook:exchange-id` in `exactKeys` — which it does via `isTrustworthyExactPoolId` (the predicate accepts `orderbook:` and `orderbook-` prefixes).
- **Impact**: The dedup check works, but only via the `exact` rail. The `wildcard: 1` and `allowOptionalWildcard: true` options are dead code in this call. Not a blocker, but misleading for the executing agent who may later try to "debug" by tuning these options.
- **Fix direction**: Simplify the call to `getIdentityDedupReason(identity, knownPoolIndex, { derived: 0, wildcard: 0 });` or add a comment "Only the `exact` rail can fire for orderbook identities (empty tokenAddresses → null derived/wildcard keys)."

### Minor

#### New Minor 1: Plan says "six" call sites of `inferCgBalanceRatio`, actual is five

- **Where**: Wave A, Task A4 Step 1 narrative: "Count the call sites: should be 6 total".
- **What's wrong**: Ground-truth §7 says there are 6 consumers (one is the definition site), but the plan counts the definition AND the test-file import as "call sites". Actual replaceable call sites inside `classifyCgPool` are **5** (lines 72, 82, 92, 101, 114). Verified via grep.
- **Impact**: Subagent may spend time looking for a sixth call site and flag a false error.
- **Fix direction**: Change narrative to "five call sites inside `classifyCgPool`, one unit test in `fetch-crawlers.test.ts:91-93`."

#### New Minor 2: Wave C commit adds `src/components/` blanket — no files touched there except conditionally

- **Where**: Wave C commit `git add` block.
- **What's wrong**: `git add worker/src/api/ worker/src/cron/dex-liquidity/scoring-helpers.ts shared/types/market.ts src/lib/liquidity-coverage.ts src/components/`. The `src/components/` path is only touched IF C1 Step 5 finds consumers needing `?? "unobserved"` fallback. On a repo where no consumer requires the fallback, `src/components/` will be a no-op add — harmless but noisy.
- **Fix direction**: Remove `src/components/` from the blanket; add specific files by name in the C1 Step 5 instructions.

#### New Minor 3: Task E1/E2 reference `computeLiquidityScore` + `computeDurabilityScore` live in `pool-helpers.ts`, partially correct

- **Where**: Wave E, Task E1.
- **What's wrong**: `computeDurabilityScore` is in `pool-helpers.ts:62` (verified). `computeLiquidityScore` is more likely in `scoring-helpers.ts` or `scoring.ts` — not verified by ground truth. The plan assumes both are in `pool-helpers.ts`. If `computeLiquidityScore` lives elsewhere, the test file target is wrong.
- **Fix direction**: Add a grep-step to Task E1: `rg -n "export function computeLiquidityScore" worker/src/cron/dex-liquidity/` to confirm the file before writing the test.

## Spec Coverage Delta

Round-1 flagged ~14 findings silent (not in a task and not in out-of-scope). Round 2 now explicitly enumerates all findings in the "Deferred out of scope" section. Spot-check against round-1's coverage table:

- **m1 Balancer chain count drift** — listed (acknowledged as already correct, doc update kept in A2).
- **m2/m3 Fluid/Orca parseFloat precision** — listed ("non-issue at current scale").
- **m5 Curve usdPrice trust line** — listed ("intentional trust boundary").
- **m6 PCS subgraph chain set** — listed ("worker-budget decision").
- **m7 Slipstream volume24hUsd: 0** — listed ("documented behavior").
- **LOW-2 CG tickers staged derived key** — listed ("addressed indirectly by B1.2").
- **B.1.1–B.5 structural refactors** — all listed.
- **MED-6 base58 case preservation** — listed.
- **Frontend m4/m5/m7/m8** — listed.
- **A6 Slipstream sqrt_ratio** — listed with a follow-up-plan pointer.

**Coverage gap: zero findings silent.** Good.

## Verdict

Critical: **3**; Major: **4**; Minor: **3**.

**Recommendation: minor revision, then ship.**

The three critical findings are all surgical single-file corrections:
1. Fix the C2 file target and the `isPlausibleDexObservationPrice` signature (≈5 lines).
2. Delete or rewrite the broken A2 `defaults unknown fees to pancakeswap-v3-5bp` test block (≈4 lines).
3. Add a chain-case normalization note to B2 Step 4 (≈1 line) OR spot-check `chainAddressToId` keying before dispatch.

None require re-architecting. The plan's structural skeleton, wave ordering, parallelization matrix, and fixture handling are all sound. All 10 round-1 criticals and 7/8 round-1 majors are genuinely resolved.

The target of "zero critical, zero major, <2 minor" is not met, but the three criticals are mechanical fixes that can be corrected in <30 minutes of focused editing before executor dispatch. After that correction pass, the plan is ready to execute.
