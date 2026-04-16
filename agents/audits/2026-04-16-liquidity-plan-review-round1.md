# Plan Review — Round 1 (2026-04-16)

Plan: `agents/plans/2026-04-16-liquidity-remediation-plan.md`
Reviewer mode: adversarial — verify all claims against current code.

## Summary

The plan has solid coverage of the four audits at the structural level (every named finding is either mapped to a task or explicitly deferred), and the wave/commit ordering is reasonable. **However, the plan cannot be executed as written.** Multiple "concrete" code snippets do not match the actual function signatures, type shapes, and file structures in the repository. A subagent dispatched against the plan in good faith will hit TypeScript compile errors on Wave A (Task A1, A4, A2 to a lesser degree), Wave B (Task B1.1 — wrong `accumulateGlobalAggregate` signature, wrong `SecondaryPool` member references), and Wave C (Task C1 — wrong file path for the fix). The TDD steps that explicitly say "expected: FAIL" will fail in the wrong way (compile error vs assertion miss). **Verdict: major revision required before dispatch.**

## Critical Issues (must fix before execution)

### Critical 1: B1.1 references `accumulateGlobalAggregate` with the wrong signature

- **What's wrong**: The plan's failing tests in Task B1.1 Step 1 call `accumulateGlobalAggregate(agg, metricsA)` and reference `initGlobalAggregate()`. The actual function in `worker/src/cron/dex-liquidity/scoring-helpers.ts:239-268` has signature `accumulateGlobalAggregate(pools, globalSeenPools, globalProtocolTvl, globalChainTvl, globalProtoChainTvl, globalChains)` and returns `{ totalTvl, totalVol24h, totalVol7d, poolCount }`. There is no `initGlobalAggregate` export. There is no `agg` accumulator object — the function returns deltas that the caller threads back. The plan's test will not compile.
- **Where in the plan**: Wave B Sub-wave B.1, Task B1.1 Step 1 (the entire failing-test block) and Step 4 (the proposed `poolTvlByKey` rewrite that assumes an `agg.totalTvl += …` mutation pattern).
- **Impact if executed as written**: Subagent will write a test that does not compile, will not produce a meaningful FAIL, will then write a "fix" that does not match the actual control flow of `accumulateGlobalAggregate` (which is called once per stablecoin from `scoring.ts` and returns deltas that the caller adds to the global). The MED-4 (higher-TVL preference) and HIGH-1 (canonical fingerprint) fixes both depend on understanding how the function is actually structured.
- **Fix direction**: Rewrite the test against the real signature. Make B1.1 Step 4 explicit about plumbing a per-poolId TVL map either inside `accumulateGlobalAggregate` (so it has memory across calls) OR at the call site in `scoring.ts` where it is invoked. The plan must also identify that `globalSeenPools` is the existing dedup vehicle and decide whether to (a) make it a Map<poolId, tvl> and back out smaller writes, or (b) collect contributions in a side-buffer first and resolve duplicates before merging.

### Critical 2: B1.1 references `SecondaryPool.baseToken` / `quoteToken` / `dexId` that do not exist on the type union

- **What's wrong**: Task B1.1 Step 3 proposes:
  ```ts
  poolId: buildCanonicalPoolId({
    chain: pool.chain,
    rawPoolId: pool.address,
    protocol: pool.dexId,
    tokenAddresses: [pool.baseToken, pool.quoteToken].filter(Boolean) as string[],
  }),
  ```
  This is in `pool-contribution.ts`, where `pool: SecondaryPool = GtNewPool | CgNewPool`. `GtNewPool` (`worker/src/cron/dex-liquidity/types.ts:259-298`) has `address`, `chain`, `dexId`, `name`, `tvlUsd`, `volume24hUsd`, `qualityMultiplier`, `maturityDays`, `price`, `symbol`, `poolType`, `sourceFamily`, optional `volume7dUsd`, `balanceRatio`, `feeTierBps`, `balanceDetails`, `pairQualityOverride`. **It has no `baseToken` and no `quoteToken` field.** `CgNewPool extends GtNewPool` with four extra fields (`balanceRatio`, `lockedLiquidityPct`, `feePercentage`) and likewise no token-address fields. The plan even handwaves this with "(Check `SecondaryPool` type — if it doesn't carry token addresses, fall back to the existing stamp.)" which is exactly the wrong instruction: the fingerprint dedup is the entire point of the task, and the secondary path is one of the two paths that need it.
- **Where in the plan**: Task B1.1 Step 3, the `pool-contribution.ts:75` rewrite.
- **Impact if executed as written**: TypeScript compile error on every secondary-source path. The fingerprint canonicalization for HIGH-1 silently degrades to "EVM addresses only" (which is actually fine for direct-API rows, since they all use real addresses) — but the audit's HIGH-1 trace was about DL UUID rows in `process-pools.ts:235`, NOT about `pool-contribution.ts:75`. The plan conflates the two stamping sites.
- **Fix direction**: Either (a) add token-address fields to `GtNewPool`/`CgNewPool` types and propagate them at all push sites (`fetch-fallbacks.ts`, `staging-merge.ts`, `fetch-crawlers.ts`), OR (b) decide that `pool-contribution.ts:75` does not need the fingerprint path because its incoming addresses are always trustworthy EVM/base58 addresses (in which case state explicitly that only `process-pools.ts:235` needs the new helper). The audit text supports (b): HIGH-1's trigger is DL's UUID at `process-pools.ts:235`, not the secondary stamper.

### Critical 3: A1's failing test is incompatible with the actual `fetchMeteoraPools` signature and existing test plumbing

- **What's wrong**: Task A1 Step 1's test snippet calls `fetchMeteoraPools({ /* existing opts in test file */ })`. The actual signature is `fetchMeteoraPools(signal?: AbortSignal): Promise<DexApiFetchResult>` (verified at `worker/src/cron/dex-liquidity/fetch-meteora.ts:58`). The existing tests (`__tests__/fetch-meteora.test.ts`) use a top-level `mockFetch = vi.fn(); vi.stubGlobal("fetch", mockFetch);` pattern and call `fetchMeteoraPools()` with no arguments. The plan's per-call `vi.stubGlobal("fetch", fetchMock)` collides with the file-level stub and may or may not produce the intended FAIL depending on test isolation.
- **Where in the plan**: Task A1 Step 1.
- **Impact if executed as written**: Either the test will not compile (passing an object where `AbortSignal` is expected — TS error), OR if the agent guesses around it, the test will use a different mock pattern from the rest of the file. The "expected: FAIL" assertion may fail for the wrong reason (mock setup) instead of the bug (`derivedPrice` precedence).
- **Fix direction**: Match the existing file's idiom. Set up the row via `mockFetch.mockResolvedValueOnce(jsonResponse({ data: [meteoraRow] }))` followed by `mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }))` (the loop break needs an empty page), then `await fetchMeteoraPools()` with no args. Also fix the test for the bug being verified: the existing test at line 20-53 already uses `current_price=90` and balanced reserves (100, 9000 → ratio 90) and asserts via `toMatchObject` without checking `pools[0].price`. The new test must use **imbalanced** reserves AND assert on `result.pools[0].price`.

### Critical 4: A4's `parseCgOnchainPoolList` does not exist as named

- **What's wrong**: Task A4 Step 4 imports `parseCgOnchainPoolList` from `coingecko-onchain-shared.ts`. Verified: that file exports `inferCgBalanceRatio`, `parseCgPool`, `classifyCgPool`, `CgPoolClassification`. There is no `parseCgOnchainPoolList`. Additionally, the plan's instruction "in the CG pool constructor (same file)" implies a constructor for the emitted pool object that the agent has to find. The actual file emits `ParsedPool` from `parseCgPool` — that's just the parser, not the structure that gets `measurement.balanceMeasured`. The `measurement` flag is set somewhere downstream when the parsed pool is converted into a `GtNewPool`/`CgNewPool` and pushed via `addSecondaryPoolContribution`.
- **Where in the plan**: Task A4 Step 3 ("In the CG pool constructor (same file)") and Step 4 (test imports).
- **Impact if executed as written**: Subagent has to do its own grep to find where CG rows actually receive `measurement.balanceMeasured = true`. The plan's instructions point at the wrong file. The fix is non-trivial: the user memory rule says "real-fixture tests, not hand-crafted mocks" — the plan does not specify a fixture path or a real CG response shape.
- **Fix direction**: Trace `inferCgBalanceRatio` consumer → most likely `staging-merge.ts` or `fetch-fallbacks.ts` (the two CG entry points). Identify the actual site that sets `balanceMeasured`. Update Task A4 to point at that file with the correct line range. Specify a real fixture path under `__tests__/fixtures/`.

### Critical 5: C1 modifies the wrong files

- **What's wrong**: Task C1 says "Modify: `worker/src/api/dex-liquidity-response.ts` (add a passthrough rule that null-overrides `coverageClass` for the `__global__` row)" and "Modify: `worker/src/api/dex-liquidity.ts` (strip `poolId`, `volumeUsd7d`, `extra.qualityAdjustedTvl`, `extra.hasMeasuredOrganicFraction` from `topPools[]` in the API mapper)". Verified: the `coverageClass` assignment that the audit's M1 flags is in `worker/src/api/dex-liquidity.ts:87,123`, not in `dex-liquidity-response.ts`. Conversely, `topPools[]` parsing/normalization happens in `normalizeTopPools()` at `dex-liquidity-response.ts:84-95`, which is called from `dex-liquidity.ts:105`. The plan has the two file responsibilities **swapped**.
- **Where in the plan**: Task C1 Steps 1-3.
- **Impact if executed as written**: A subagent following the file list will not find the assignment site for `coverageClass` in `dex-liquidity-response.ts` (because it's in `dex-liquidity.ts`) and will not find the topPools mapping in `dex-liquidity.ts` (because it's in `dex-liquidity-response.ts`). They may add a new field unnecessarily or fix the wrong thing.
- **Fix direction**: Swap the file targets. Specify line numbers: `dex-liquidity.ts:87` (coverageClass fallthrough) and `dex-liquidity-response.ts:84-95` (`normalizeTopPools` body) or its underlying `DexLiquidityPoolResponse` mapping.

### Critical 6: A2's `classifyClPoolType` test assertion is incorrect for one branch

- **What's wrong**: Task A2 Step 1's test asserts `expect(classifyClPoolType("aerodrome-slipstream", 30)).toBe("aerodrome-slipstream-30bp")`, AND in Step 2 the proposed function body has a 30bp branch (`if (normalizedFeeBps <= 30) return ${prefix}-30bp`). But Slipstream's actual fee tiers per audit M6 are 1, 4, 30, 100 — there's no 30bp tier on Slipstream natively. The 30 case needs a real fixture or it may never fire. More importantly, the plan never adds a `25bp` slot for Slipstream in `QUALITY_MULTIPLIERS` — only PancakeSwap. If Slipstream pools are emitted at exactly 25 they will be sent to a non-existent bucket key (`aerodrome-slipstream-25bp`) and `getQualityMultiplier` will fall back to `generic` (0.3). This is worse than the current bug.
- **Where in the plan**: Task A2 Steps 1-3.
- **Impact if executed as written**: Possibly silently downgrades Slipstream pools that happen to land on 25bp to `generic`. No test will catch this because the plan only checks Pancake 25bp + Slipstream 100bp.
- **Fix direction**: Either skip the 25bp branch for Slipstream (Pancake-only) OR add the matching multiplier entries. Also, the proposed function ordering `<= 25 → 25bp; <= 30 → 30bp; else → 100bp` collapses the >100bp case into 100bp silently — fine for known protocols but worth a comment.

### Critical 7: Incremental deployment rule is technically honored for fetchers but not for waves

- **What's wrong**: The user memory rule says "deploy one fetcher at a time, monitor for a day, fix issues, then add the rest". The plan honors this for new fetchers (Wave G ships only Noble Swaps). But Wave A simultaneously modifies seven existing fetchers (Meteora, Pancake/classifier, Fluid, CG-onchain, Balancer, Slipstream, plus error-propagation in fetch-primary.ts). Each modification has the potential to break a fetcher. There is no monitoring gate between waves. A regression in the Slipstream fix (e.g. wrong sqrt-ratio decoding) lands at the same time as the Meteora and Balancer fixes, and a single deploy carries all seven.
- **Where in the plan**: Wave A composition.
- **Impact if executed as written**: A bad sqrt-ratio computation in Slipstream (Critical 9 below) deploys alongside six other changes; rollback throws the baby out with the bathwater.
- **Fix direction**: This is debatable — the user's rule is about NEW fetchers, not existing-fetcher fixes. But the spirit of the rule (incremental, monitorable) is being violated. Either (a) split Wave A into multiple commits and explicitly serialize them with monitoring gates, OR (b) document explicitly in the plan that Wave A bundles seven existing-fetcher fixes and accept the risk. Currently the plan does neither.

### Critical 8: A6 Slipstream `cast` command requires a tool not guaranteed to exist + `sqrt_ratio` math is incomplete

- **What's wrong**: Task A6 Step 1 instructs the agent to run `cast call ... --rpc-url https://base.publicnode.com`, then says "If `cast` is unavailable, inline a Node.js fetch + ABI decode script". `cast` is part of Foundry; it is not in the project's dependency graph and there's no guarantee it's on the PATH for an Opus subagent's bash environment. The fallback "inline a Node.js script" needs a working ABI decoder reference (no examples in the plan), and a known Sugar contract `all(uint256, uint256)` selector. The plan doesn't even tell the agent which Sugar deployment ABI to use — there are multiple Sugar revisions across Aerodrome and Velodrome.

  Additionally, the proposed `sqrtRatioToSpotPrice` helper:
  ```ts
  const sqrt = Number(sqrtRatio) / Number(Q96);
  const raw = sqrt * sqrt;
  return raw * Math.pow(10, token0Decimals - token1Decimals);
  ```
  loses precision for 96-bit inputs (Number can only safely represent ~2^53). For a sqrtPriceX96 like `~7.92e28` (typical for a USDC/ETH pool), `Number(sqrtRatio)` is well outside `MAX_SAFE_INTEGER` and `/ Number(Q96)` gives garbage low-order bits. Real implementations divide BigInt-by-BigInt in fixed point, or use the Q64.96 → mantissa pattern.
- **Where in the plan**: Task A6 Steps 1, 3.
- **Impact if executed as written**: Subagent may not be able to obtain a real fixture (no `cast`, no script template). If they push past it, the math helper is numerically incorrect for typical pool values. The audit explicitly notes "Live `eth_call` against the public Tenderly RPC reverted in this audit so the assumption could not be verified end-to-end here" — even the auditor couldn't verify it. The plan inherits this open question without resolving it.
- **Fix direction**: Drop A6 from this plan (defer to a follow-up plan) OR replace the math helper with a BigInt-correct version, e.g.
  ```ts
  // sqrtPriceX96 squared: returns raw price in fixed-point; scale at the end.
  const numerator = sqrtRatio * sqrtRatio;
  const Q192 = 1n << 192n;
  // Express price in float by chunking: (num / Q192) is the price ratio.
  ```
  AND give the agent a working Node-only fetch+decode template that does not depend on `cast`. AND give explicit fixtures (the audit already mentions the deployed Sugar address `0x27fc745390d1f4BaF8D184FBd97748340f786634`). If none of that is feasible, defer to a separate plan with proper research.

### Critical 9: B2 modifies the same file (`pool-helpers.ts`) that B1.1 touches without proper serialization

- **What's wrong**: The parallelization matrix says B1.1 is "partial (shares pool-helpers)" and B1.3 is "SERIAL with B1.1". B2 (sub-wave B.2) is then SERIAL after B1.1+B1.3. So far so good. **But B1.2 modifies `staging-merge.ts:330`, B2 also instructs (Step 4) to update `staging-merge.ts` callers of `buildPoolIdentity` to add `isStableHint`.** If B1.2 lands first (as intended in B.1) it modifies `staging-merge.ts`, then B2 (B.2) modifies the same file — fine in serial. **But B1.1 also adds `buildCanonicalPoolId` to `pool-helpers.ts` and B2 modifies `normalizeProtocol` and `classifyPoolType` in the same file. Both are in the B-wave that's intended to ship as a single commit.** The plan says B1 is parallel, but B1.1 alone touches `pool-helpers.ts` and B2 also touches it — which contradicts the matrix's "yes" parallel-safe annotation for B1.1 (it says "partial (shares pool-helpers)"). This is acknowledged but not actionable.
- **Where in the plan**: Parallelization matrix + B1.1 + B2 file lists.
- **Impact if executed as written**: If B1.1 and B2 are dispatched as parallel subagents (matrix says B1 is in parallel), they will both edit `pool-helpers.ts` simultaneously and produce merge conflicts. The plan tries to handle this by making B2 SERIAL after B1, but the Sub-wave A1.1's "partial (shares pool-helpers)" annotation is ambiguous about WHICH other task it shares with.
- **Fix direction**: Make the matrix unambiguous: B1.1, B1.2, B1.3 are all dispatched in parallel and they must touch disjoint files. Move `buildCanonicalPoolId` (B1.1) into a NEW file (e.g. `pool-fingerprint.ts`) so it does not collide with B2's edits to `pool-helpers.ts`, OR explicitly serialize B1.1 → B2 with no parallelism and rename Sub-wave B.2 accordingly.

### Critical 10: Out-of-scope / spec-coverage gaps that are NOT documented in "Out of scope"

- **What's wrong**: Several findings from the source audits are not addressed AND not listed in the "Out of scope" section:
  - **m1** (Balancer chain map drift, 16 vs 14 chains in docs) — the post-execution Step 6 mentions it indirectly ("update at the same time as A6's doc touch") but no task touches `docs/dex-liquidity.md` chain count.
  - **m4** (Meteora derivedPrice from already-normalized amounts) — superseded by C1, but not noted.
  - **m5** (Curve API per-coin `usdPrice` trust line) — not addressed. Likely intentional but not stated.
  - **m6** (PancakeSwap subgraph chain set) — not addressed. Maybe intentional.
  - **m7** (Slipstream `volume24hUsd: 0` always cedes precedence) — not addressed.
  - **m8** (Orca cursor pagination guard) — not addressed (correctly noted as "no bug").
  - **m9** (GeckoTerminal numeric type check) — not addressed (correctly noted as lowest severity).
  - **m10** (PancakeSwap subgraph feeRate) — confirmed correct by audit, no fix needed.
  - **MED-6** (base58 case preservation) — listed as out of scope ✓.
  - **B.2.2 / B.2.3 / B.2.4 / B.2.5** (file split refactors) — listed as out of scope ✓.
  - **B.3.2-B.3.6** (polish items) — not addressed and not listed.
  - **B.5** (type system gaps) — not addressed and not listed.
  - **HIGH-3 scenario A** ("staged Kinesis dedupes correctly but loses TVL info for losing stablecoin") — partially addressed by B1.2 but the `first-wins → arbitrary` semantics fix is not explicitly called out.
- **Where in the plan**: "Out of scope" section is incomplete.
- **Impact if executed as written**: Reviewers reading the plan after execution will not be able to tell if a missing finding was deferred or forgotten. The user's "real-fixture tests, not hand-crafted mocks" rule is violated for at least A4, A3, and A5 (none specify a real fixture path).
- **Fix direction**: Add an explicit "Findings not addressed in this plan" subsection that lists every audit finding with one of three statuses: addressed, deferred-to-followup, or no-fix-needed. The plan currently lists ~12 deferred items in "Out of scope" but the audit has ~50+ findings. Coverage is closer to 60% than 95%.

## Major Issues

### Major 1: Wave A commit lumps fetcher fixes with two unrelated changes (test discipline)

The Wave A commit message describes 8 unrelated changes ("Meteora, classifier, Fluid, CG, Balancer, Slipstream, error-propagation, CEX circuit"). Per the user's "commit in logical/thematic batches" instruction, this is borderline. A reviewer doing `git bisect` to track down a Slipstream regression cannot isolate it from the Meteora fix in the same commit. Suggest: split Wave A into A.1 (data correctness fixes: Meteora, Fluid, classifier, CG, Balancer, Slipstream — six fetcher fixes) and A.2 (failure propagation: error throw + CEX circuit), commits separately.

### Major 2: B1.3 (Curve metapool raw-TVL fix) silently changes per-stablecoin metric semantics

Task B1.3 changes `m.totalTvlUsd += effectiveRawTvl` (where `effectiveRawTvl = curveData.metapoolAdjustedTvl` for address-matched Curve). The audit MED-3 confirms this is correct, but the plan does not warn that:
1. Existing `dex_liquidity` rows in D1 will see step-changes in `total_tvl_usd` for any stablecoin paired through a Curve metapool. The historical comparison guards in `scoreDexLiquidityPoolState` (`orchestrator.ts:402-418`) do a `previous vs current` check on global TVL; a step-change of $1.5B (the Curve global TVL share) could trip the value guard.
2. The `protocolTvl["curve"]` and `chainTvl[...]` rebuild paths flow back into the API and into the historical snapshot. There may be a one-snapshot discontinuity that confuses the `dex_liquidity_history` consumers.

The plan doesn't have a "back out the historical guards on first deploy" instruction or a manual override step.

### Major 3: D1 wildcard widening uses a regex on a structured key

Task D1 Step 2 proposes:
```ts
const naVariant = identity.derivedMatchKey.replace(/\|([0-9]+|wide)\|/, "|na|");
```
This replaces the FIRST occurrence of a `|<digits-or-wide>|` substring. The actual `derivedMatchKey` format is `chain|protocol|tokens|shape|feeBucket|stability` (verified at `pool-identity.ts:124-134`). The `tokens` segment is `addr1:addr2` joined by `:`, but `chain` could conceivably be numeric (`"1"` for ETH if anyone abbreviated), and the fee bucket comes 5th. The regex is positionally fragile. Safer to split on `|`, swap `parts[4]`, and re-join.

### Major 4: F1 paginated helper does not match all 8 fetchers

The audit's B.2.1 says "extract the direct-fetcher pagination scaffold". Task F1 lists 8 fetchers. But:
- `fetch-fluid.ts` is NOT paginated — it iterates over a fixed chain list and fetches each chain's full ticker list in one request. It cannot use a `runPaginatedDirectApiFetch` helper without a major restructure.
- `fetch-slipstream.ts` is RPC-based (Sugar `all()`), not HTTP-paginated.
- `fetch-balancer.ts` is GraphQL with `skip` cursor, not page-number.

So the helper realistically applies to ~4-5 fetchers (Meteora, Raydium, Orca, Pancake, possibly Balancer-with-adapter). The plan's "migrate 8 direct fetchers" target is wrong. Either narrow the scope or split into "HTTP page-number" and "GraphQL skip cursor" helpers.

### Major 5: G1 Noble Swaps endpoint is unverified

Task G1 Step 1 says the agent should curl two indicative endpoints and "choose the endpoint that returns pool-level TVL, 24h volume, and token balances". Both URLs are flagged as "indicative — verify". The plan does not actually know which API works. There is a real risk that neither does (Noble Swaps is a relatively new module) and the agent stalls. Per the user's "include real data samples in subagent prompts" memory rule, this task should have a saved curl response in the plan or in the audits before dispatch.

### Major 6: B2 plumbing is underspecified

Task B2 Step 4 says "This requires threading `chainAddressToId` into `filterPrimaryPoolsPreferDirectApi` from the orchestrator. Add it as a parameter." But after F2 (Wave F), `filterPrimaryPoolsPreferDirectApi` moves from `orchestrator.ts` to `pool-identity.ts`. If B2 ships before F2, the plumbing has to be added in `orchestrator.ts`. If F2 ships first, the plumbing has to live in `pool-identity.ts`. The plan's wave ordering says B → F, so B2 first. But B2 also touches `staging-merge.ts` and `orchestrator-phases.ts` "if they build Balancer identities — grep for `buildPoolIdentity` and add the hint at call sites where the pair is tracked-stablecoin pure" — which is a vague directive that an agent will get wrong.

### Major 7: Test fixtures are referenced but never specified

A4 references "sample payload with stable-stable and stable-volatile pairs", A5 references "fantomDeiFixture" and "cleanFixture", G1 references `worker/src/cron/dex-liquidity/__tests__/fixtures/noble-swaps-sample.json` (which doesn't exist), B1.2 references "a staged row for KAU with `orderbook:kinesis`" without specifying how to construct it. The fixtures-folder convention is not currently used by the test suite (there's no `fixtures/` directory under `__tests__`). Either:
1. Pre-create the fixture files in the plan setup step (curl, save, commit),
2. Or specify the fixture inline in each test as a `const = {...}`.

### Major 8: A7 (`fetchGtTokenBatch` throw) may break parent flows

The plan says "The caller (`subgraph-family-runner.ts` or wherever these batches run) already catches exceptions — by throwing, the failure surfaces to the circuit breaker and the telemetry records a proper `ok: false`." The plan does not actually verify this. If the parent does NOT catch, throwing will break the whole orchestrator phase. Need a grep + read of all callers before changing the contract.

## Minor Issues

### Minor 1: A2 `feeRate` for Pancake `feeBps=10` is unspecified

PancakeSwap V3 has tiers 1, 5, 25, 100. The plan handles 1, 5, 25, 100 correctly. But pools with intermediate values (e.g. some forks use 10bps) will fall into the new `25bp` bucket with `0.7x` quality. Possibly fine, but unspecified.

### Minor 2: `coverageClass` nullable migration may break frontend consumers

C3 Step 3 makes `coverageClass: z.string()` → `z.string().nullable()`. The audit's frontend table (m1-m6) shows `coverageClass` is read in many places (`getLiquidityCoverageBadge`, history empty-state guard, table rendering, badge map). The plan says "add a `?? undefined` or `?? "unobserved"` fallback as appropriate" but does not enumerate the consumers. A grep shows several usage sites. Without an explicit enumeration the agent may miss one.

### Minor 3: B1.1's `buildCanonicalPoolId` predicate `isTrustworthyExactPoolIdForStamping` does not exist

The plan introduces a new export `isTrustworthyExactPoolIdForStamping` and says it's "the same predicate already used in `pool-identity.ts:isTrustworthyExactPoolId`. Export it from `pool-identity.ts` (or duplicate)". The actual symbol in `pool-identity.ts:41` is `isTrustworthyExactPoolId` (no "ForStamping" suffix), and it's currently unexported. The plan should specify which one to export and rename references consistently.

### Minor 4: Wave C task C2 "rg" uses interactive grep, plan should use Grep tool

Task C2 Step 2 says `cd worker && rg -n "USDC.e|priceSources|price_sources_json|alias" src/cron/dex-liquidity/`. Subagents in this environment use the Grep tool, not raw `rg`. The plan uses `rg` consistently in many bash blocks; agents should use the Grep tool but the plan never says so. Minor stylistic issue but it adds friction.

### Minor 5: The "Step 5 in X" cross-reference pattern is missing

The user asked: "Any task that says 'Step 5 in X' should match the actual step numbering in X." The plan has no such cross-references — all references are by task name (B1.1, A2, etc.), which is fine.

### Minor 6: Task labels collide with audit findings labels

`A1` in the plan refers to Meteora; `A1` in the audits could refer to "section A.1 (Coverage / Current State)". Same for A4, A5. Confusing but not breaking. Suggest renaming plan tasks to `T-A1`, `T-A2`, etc. Optional polish.

### Minor 7: Wave G commit references F1 helper conditionally

Wave G's commit message says "runPaginatedDirectApiFetch helper (if Wave F landed) or hand-rolled loop". A commit message with "if X" is a smell — either F landed or it didn't, decide before committing.

### Minor 8: Plan does not specify a feature branch

The plan implies all 7 commits land directly on `main`. For a 7-commit bulk change with potential regressions in the Wave A fetcher batch, a feature branch + merge gate would be much safer. Per user CLAUDE.md, `npm run test:merge-gate` is the standard pre-push gate; the plan only runs it once at the very end (post-execution Step 3). A subagent dispatched on Wave G has no way to know whether Waves A-F passed the merge gate.

## Spec Coverage Audit

| Finding | In plan? | Location / Status |
| --- | --- | --- |
| **Audit 1: Data accuracy** | | |
| C1 Meteora derivedPrice | yes | Task A1 (test fixture issues — Critical 3) |
| C2 Pancake 25bp/100bp classifier | yes | Task A2 (Slipstream 25bp gap — Critical 6) |
| M1 Fluid raw-volume fallback | yes | Task A3 (test fixture path missing) |
| M2 CG balance ratio | yes | Task A4 (file targets wrong — Critical 4) |
| M3 Balancer per-pool sanity | yes | Task A5 (fixture missing) |
| M4 Balancer pool.price footgun | yes | Task A5 Step 3 |
| M5 Slipstream sqrt_ratio | yes | Task A6 (math + tooling broken — Critical 8) |
| M6 Slipstream pool_fee units | yes | Task A6 (same risks) |
| M7 Pancake 100bp lost | yes | Task A2 |
| m1 Balancer chain count drift | partial | post-exec Step 6 only, no task |
| m2 Fluid parseFloat precision | no | not addressed, not listed out-of-scope |
| m3 Orca parseFloat precision | no | not addressed, not listed |
| m4 Meteora derivedPrice on normalized amounts | implicit | superseded by C1 |
| m5 Curve `usdPrice` trust line | no | not addressed, not listed |
| m6 Pancake subgraph chain set | no | not addressed, not listed |
| m7 Slipstream volume=0 cedes precedence | no | not addressed, not listed |
| m8 Orca cursor guard | no | confirmed clean by audit |
| m9 GT numeric type check | no | confirmed clean by audit |
| m10 PCS subgraph feeRate | no | confirmed clean |
| m11 Silent return-empty in token batches | yes | Task A7 |
| m12 CEX orderbook circuit | yes | Task A7 |
| **Audit 2: Dedup** | | |
| HIGH-1 `__global__` poolId DL vs direct | yes | Task B1.1 (signature broken — Critical 1, 2) |
| HIGH-2 Balancer shape mismatch | yes | Task B2 |
| HIGH-3 CG tickers two conventions | yes | Task B1.2 |
| HIGH-4 normalizeProtocol hyphens | yes | Task B2 |
| MED-1 fee-bucket asymmetry | yes | Task D1 (fragile regex — Major 3) |
| MED-2 wildcard rail blocked on parallel | yes | Task D1 |
| MED-3 Curve metapool raw TVL | yes | Task B1.3 (historical guard risk — Major 2) |
| MED-4 first-wins on poolId collision | yes | Task B1.1 (folded in) |
| MED-5 known Curve/UniV3/Aerodrome tokens | yes | Task D2 |
| MED-6 base58 case preservation | yes | Out of scope ✓ |
| LOW-1 challenger intra-coin dedup | yes | Task D3 |
| LOW-2 CG tickers staged tokens | no | not addressed, not listed |
| LOW-3 aerodrome-slipstream branch order | yes | Task B2 |
| LOW-4 mergeSecondaryPools defensive guard | yes | Task D3 |
| **Audit 3: Coverage / quality** | | |
| A.2 unobserved RWAs | n/a | impossible by design, doc-only |
| A.3 chain registry gaps | yes | Out of scope (deferred) |
| A.4 #1 Noble + Osmosis | partial | G1 ships Noble only, defers Osmosis ✓ |
| A.4 #2-#17 follow-ups | yes | Out of scope ✓ |
| B.1.1 DexLiquidityPoolState extends | no | not addressed, not listed |
| B.1.2 Awaited<ReturnType> phase types | no | not addressed, not listed |
| B.1.3 filterPrimaryPoolsPreferDirectApi location | yes | Task F2 |
| B.1.4 scoring rebuild double-call | no | not addressed, not listed |
| B.2.1 paginated helper | yes | Task F1 (scope inflated — Major 4) |
| B.2.2 fetch-primary.ts split | yes | Out of scope ✓ |
| B.2.3 challenger-persistence.ts split | yes | Out of scope ✓ |
| B.2.4 orchestrator-phases.ts split | yes | Out of scope ✓ |
| B.2.5 score-weights.ts shim | no | not addressed, not listed |
| B.3.1 dead-code knip | yes | Task F3 |
| B.3.2 scoring fragmentation | no | not addressed, not listed |
| B.3.3 magic numbers in classifier | no | not addressed, not listed |
| B.3.4 stale TODO/M3/H2 markers | no | not addressed, not listed |
| B.3.5 `as Record<string, unknown>` cast | no | not addressed, not listed |
| B.3.6 console logging density | no | not addressed (acceptable) |
| B.4 testing gaps | yes | Wave E (partial — only 4 functions of ~28 untested files) |
| B.5 ScoreResult vs FullScoreResult | no | not addressed, not listed |
| B.6 error handling | no | confirmed clean |
| **Audit 4: Frontend / API** | | |
| M1 __global__ coverageClass | yes | Task C1 (wrong file — Critical 5) |
| M2 dead per-pool fields | yes | Task C1 |
| M3 priceSources contamination | yes | Task C2 |
| m1 dead row fields | partial | Task C3 (kept on wire — defensible) |
| m2 dead crossChain | yes | Task C3 |
| m3 missing direct_api label | yes | Task C3 |
| m4 legacy badge defensive | no | acknowledged in audit, no fix needed |
| m5 unobserved row badge redundancy | no | not addressed, cosmetic |
| m6 top-pool row key collision | yes | Task C3 (deferred re-key — partial) |
| m7-m8 hook timing | no | confirmed correct by audit |

**Summary**: 9 critical-or-major findings missing entirely from the plan AND from "Out of scope". 5 minor findings missing without acknowledgement. Overall ~75% spec coverage, but several missed items would be one-line additions.

## Parallelization Safety Matrix

| Wave | Task | Touched files | Conflicts? |
| --- | --- | --- | --- |
| A | A1 | `fetch-meteora.ts`, `__tests__/fetch-meteora.test.ts` | none |
| A | A2 | `direct-source-helpers.ts`, `lib/dex-constants.ts`, `__tests__/fetch-pancakeswap.test.ts`, `__tests__/direct-source-helpers.test.ts`, `docs/dex-liquidity.md` | `dex-constants.ts` shared with G1; serial OK |
| A | A3 | `fetch-fluid.ts`, `__tests__/fetch-fluid.test.ts` | none |
| A | A4 | `coingecko-onchain-shared.ts`, callers (grep TBD), `__tests__/coingecko-onchain-shared.test.ts`, `docs/dex-liquidity.md` | **`docs/dex-liquidity.md` shared with A2** |
| A | A5 | `fetch-balancer.ts`, `__tests__/fetch-balancer.test.ts` | none |
| A | A6 | `fetch-slipstream.ts`, `__tests__/fetch-slipstream.test.ts` | none |
| A | A7 | `fetch-primary.ts`, `orchestrator-phases.ts`, `lib/circuit-breaker.ts` | **`orchestrator-phases.ts` shared with G1** (acceptable, G1 is later wave); **`fetch-primary.ts` shared with D2** (acceptable serial) |
| B.1 | B1.1 | `process-pools.ts`, `pool-contribution.ts`, `scoring-helpers.ts`, `pool-helpers.ts` | **`pool-helpers.ts` shared with B2** (matrix says serial); **`process-pools.ts` shared with B1.3 in same sub-wave** (matrix says serial) |
| B.1 | B1.2 | `crawl-sources.ts`, `staging-merge.ts`, `fetch-fallbacks.ts`, `__tests__/staging-merge.test.ts` | **`staging-merge.ts` shared with B2** (matrix doesn't flag) |
| B.1 | B1.3 | `process-pools.ts`, `__tests__/process-pools.test.ts (new)` | **shared with B1.1** (matrix says serial) |
| B.2 | B2 | `pool-helpers.ts`, `pool-identity.ts`, `orchestrator.ts`, `staging-merge.ts`, `orchestrator-phases.ts`, `__tests__/pool-identity.test.ts`, `__tests__/pool-helpers.test.ts (new)` | shared with **B1.1** (`pool-helpers.ts`), **B1.2** (`staging-merge.ts`), **A7** (`orchestrator-phases.ts`) — all earlier in time, OK |
| C | C1 | `worker/src/api/dex-liquidity-response.ts`, `worker/src/api/dex-liquidity.ts`, `__tests__/dex-liquidity.test.ts` | none |
| C | C2 | `scoring-helpers.ts`, `token-resolution.ts` | shared with **B1.1** (matrix says serial) |
| C | C3 | `shared/types/market.ts`, `src/lib/liquidity-coverage.ts`, `src/components/dex-liquidity-card.tsx` | none |
| D | D1 | `pool-identity.ts`, `__tests__/pool-identity.test.ts` | shared with **B2** (B2 lands first) |
| D | D2 | `fetch-primary.ts`, `__tests__/fetch-primary.test.ts` | shared with **A7** (A7 lands first) |
| D | D3 | `challenger-persistence.ts`, `fetch-crawlers.ts`, `pool-contribution.ts`, tests | shared with **B1.1** (`pool-contribution.ts`) |
| E | E1 | `__tests__/pool-helpers.test.ts` | shared with **B2** (test file) |
| E | E2 | `__tests__/scoring-helpers.test.ts` | shared with **B1.1** (test file) |
| F | F1 | `direct-api-paginated.ts (new)`, all 8 fetcher files | shared with **A1, A3, A5, A6** (Wave A landed) |
| F | F2 | `pool-identity.ts`, `orchestrator.ts` | shared with **B2** and **D1** (both earlier) |
| F | F3 | multiple cleanup files | TBD per knip output |
| G | G1 | `fetch-noble-swaps.ts (new)`, `orchestrator-phases.ts`, `pool-identity.ts`, `lib/dex-constants.ts`, `lib/circuit-breaker.ts`, `__tests__/...`, `docs/dex-liquidity.md` | shared with **A2, A7, B2, F2** (all earlier waves landed); `docs/dex-liquidity.md` shared with **A2, A4** |

**Net flagged conflicts** (after considering wave ordering):
1. Within Wave A: **A2 and A4 both edit `docs/dex-liquidity.md` in parallel** — will conflict on git add/commit. Plan's parallelization matrix marks both as parallel-safe but doesn't flag this. **Fix: serialize the doc edit, or merge into a single A8 doc-update task at the end of Wave A.**
2. Within Sub-wave B.1: **B1.1 and B1.3 both edit `process-pools.ts`** — matrix says SERIAL. OK if respected.
3. **B1.1 and B2 both edit `pool-helpers.ts`** — matrix says SERIAL via B1 → B2 ordering. OK if respected.
4. **B1.2 and B2 both edit `staging-merge.ts`** — matrix DOES NOT flag this. Both are serial via wave ordering, so OK in practice, but matrix is incomplete.
5. **D3 and B1.1 both edit `pool-contribution.ts`** — D is after B, OK.

## Gotchas for Executing Agents

A subagent dispatched against this plan should be aware of:

### Task A1 gotchas
- The existing test file uses a top-level `mockFetch = vi.fn()` — do NOT call `vi.stubGlobal` per test.
- `fetchMeteoraPools` takes `signal?: AbortSignal`, not options. Call it with no args.
- The fetcher's pagination loop requires an empty page to terminate — set up TWO `mockResolvedValueOnce` calls (data page + empty page).
- The price assignment is `pool-meteora.ts:143-145`, NOT line 118 alone. The whole assignment is a ternary that prefers `derivedPrice`.
- Asserting `not.toBeCloseTo` with precision 1 still allows ±0.05 tolerance — pick a precision that distinguishes 79.18 from 84.99.
- Existing tests already assert `balances: [100, 9000]` — preserve that contract.

### Task B1.1 gotchas
- `accumulateGlobalAggregate` is called once per stablecoin from inside `scoring.ts`, NOT once with an aggregate. The "agg" object the plan invents does not exist.
- `globalSeenPools` is a `Set<string>` shared across calls in `scoring.ts` (find the call site before designing the fix).
- `pool-contribution.ts` `SecondaryPool = GtNewPool | CgNewPool` has NO `baseToken`/`quoteToken` fields. Either thread token addresses through `addSecondaryPoolContribution` (huge change) OR accept that the secondary stamping path uses the existing address-only stamp (which is fine because all secondary sources use real addresses).
- `buildPoolFingerprint` from `pool-helpers.ts:196-204` already exists — use it directly. Don't define a wrapper unless you need the trust-prefix logic, which the existing helper does NOT have.
- `isTrustworthyExactPoolId` in `pool-identity.ts:41` is currently `function` (not exported). Add `export` before importing it elsewhere.

### Task G1 gotchas
- Run the curl commands from Step 1 BEFORE writing any code. If both 404, escalate.
- `runPaginatedDirectApiFetch` (from F1) may not exist when G is dispatched. Check; if absent, hand-roll using the Raydium pattern (`worker/src/cron/dex-liquidity/fetch-raydium.ts:49-120`).
- `CIRCUIT_SOURCE` is a const-as-enum object, not a TypeScript enum. Adding an entry needs adding the literal AND grepping for switch statements that need a new branch.
- The "noble:" trustworthy prefix change in `pool-identity.ts:41` will cause every existing pool with a `noble:`-prefixed id to suddenly be treated as exact. Verify nothing else uses that prefix today.
- Before adding `noble-swaps-stable` to `QUALITY_MULTIPLIERS`, decide whether `noble-swaps-stable` ever flows through `classifyPoolType` → `getQualityMultiplier`. The classifier is project-string-based, not poolType-based, so the multiplier is keyed by what the fetcher hardcodes in `pool.poolType`.

### General gotchas
- Wave A and Wave C tests are in a `__tests__/` directory that uses Vitest's `vi.stubGlobal` for `fetch`. Use `vi.fn()` + `vi.stubGlobal` consistently with the pattern already in `__tests__/fetch-meteora.test.ts`.
- `cd worker && npx vitest --run` is the only test runner that picks up worker tests. Repo root `npm test` does not run worker tests.
- Worker code excludes the root `tsconfig.json` (`worker/` is in `exclude`). All worker imports must use relative paths. Cross-folder imports use `../../lib/...`, NOT `@/...`.
- Do NOT use `@shared/*` from worker code — but the existing worker files DO use it (e.g. `pool-helpers.ts:1` uses `@shared/lib/stablecoins`). There's a separate worker tsconfig that maps it. Verify before rejecting.
- `dex_liquidity` D1 schema columns are snake_case; API mappers transform to camelCase. Don't confuse the two.

## Verdict

Critical: **10**; Major: **8**; Minor: **8**.

**Recommendation: rewrite the plan before dispatch.**

The structural skeleton (waves, parallelization matrix, commit themes) is sound. The wave ordering is reasonable. The deferral of follow-up coverage fetchers is correct. But the per-task code snippets are hand-written rather than verified against the actual codebase, and at least 5 tasks (A1, A4, A6, B1.1, C1) will produce TypeScript compile errors as written. A second pass should:

1. **Read every file the plan claims to modify** and replace each "concrete" code snippet with one that the agent can copy-paste without modification.
2. **Verify every type signature** referenced (especially `accumulateGlobalAggregate`, `SecondaryPool`, `fetchMeteoraPools`, `inferCgBalanceRatio`'s actual consumers).
3. **Pre-create test fixtures** by curling the live APIs and committing them to `__tests__/fixtures/` — Noble Swaps, Meteora imbalanced pool, Balancer Fantom DEI pool, Slipstream Sugar struct.
4. **Resolve A6 Slipstream's open math/tooling questions** out-of-band (e.g. by spike) or defer the entire task to a follow-up plan.
5. **Add the missing audit findings** to either an addressed task or the "Out of scope" list (~14 findings currently silent).
6. **Fix the parallelization matrix** to flag the A2+A4 doc collision and the B1.2+B2 staging-merge collision.
7. **Decide whether Wave A is one commit or several** — at minimum, separate the existing-fetcher fixes from the failure-propagation changes, because git-bisect-by-fetcher is a near-certain need.

After the rewrite, dispatch a second review pass before executing.
