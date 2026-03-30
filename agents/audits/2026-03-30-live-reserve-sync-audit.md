# Live Reserve Sync Audit

Date: 2026-03-30

Scope: full review of the live reserve sync subsystem, including the shared contract, cron orchestration, storage/read path, API exposure, every registered adapter, test posture, and near-term coverage opportunities.

## Validation Performed

- Read:
  - `docs/architecture.md`
  - `docs/api-reference.md`
  - `docs/testing.md`
  - `docs/worker-and-api-limits.md`
  - `docs/live-reserves.md`
- Reviewed:
  - `shared/types/live-reserves.ts`
  - `shared/lib/live-reserve-adapters.ts`
  - `worker/src/cron/sync-live-reserves.ts`
  - `worker/src/cron/sync-live-reserves-core.ts`
  - `worker/src/lib/live-reserves-store*.ts`
  - `worker/src/api/stablecoin-reserves.ts`
  - every file under `worker/src/cron/reserve-adapters/`
- Ran:
  - `npm test -- --run worker/src/cron/reserve-adapters/__tests__ worker/src/cron/__tests__/sync-live-reserves.test.ts worker/src/cron/__tests__/reserve-adapter-validate.test.ts worker/src/lib/__tests__/live-reserves-store.test.ts worker/src/api/__tests__/stablecoin-reserves.test.ts`
  - `npm run lint`
  - `cd worker && npx tsc --noEmit`
  - `npm run build`

Results:

- reserve-specific tests: `34` files passed, `216` tests passed
- lint: passed
- worker typecheck: passed
- Next.js build: passed

## Current Surface

- Live-enabled coins: `119`
- Registered adapters: `29`
- Adapter distribution:
  - `single-asset`: `48`
  - `curated-validated`: `24`
  - `accountable`: `7`
  - `m0`: `4`
  - all other adapters: `1-3` each
- Evidence-class distribution:
  - `independent`: `42`
  - `static-validated`: `28`
  - `weak-live-probe`: `49`
- Structurally freshness-unverified independent coins: `17`
  - `eurc-circle`
  - `zchf-frankencoin`
  - `ceur-celo`
  - `deuro-deuro`
  - `gbpm-mento`
  - `usdc-circle`
  - `m-m0`
  - `crvusd-curve`
  - `iusd-infinifi`
  - `musd-metamask`
  - `fxusd-f-x-protocol`
  - `usdn-noble`
  - `usdaf-asymmetry`
  - `cusd-celo`
  - `btcusd-btcfi`
  - `wsrusd-reservoir`
  - `ctusd-citrea`

## Executive Summary

The subsystem is operationally healthy, tested, and materially more structured than the earlier March audit trail. The shared config schema is good, the sequential cron design is coherent, the D1 consistency rules are reasonably defensive, and the reserve-specific test suite now has complete per-adapter presence.

The main remaining issues are not “the sync is broken”. They are:

1. Breadth now materially exceeds depth.
   119 coins are live-enabled, but only 42 currently produce independent evidence. The other 77 are either static-validated or weak live probes. That is acceptable only if planning, ops, and product keep distinguishing “live evidence” from “live liveness check”.
2. A handful of adapters still overstate certainty.
   The largest structural example is `single-asset`, which covers 48 coins but usually proves only “the token exists / the endpoint still answers”, then emits a `100%` reserve slice.
3. Unknown or unmapped exposure handling is inconsistent.
   Some adapters surface unknown exposure as an explicit slice, some silently default it into a known bucket, some hard-fail, and some only emit an info warning. This is the main data-quality inconsistency across the adapter set.
4. HTML scraping and hand-maintained symbol maps are the largest maintainability burden.
   The codebase is coherent enough today, but the biggest future failure mode is silent upstream shape drift or taxonomy drift in hardcoded token/farm maps.
5. The best near-term ROI is quality upgrades, not more one-off adapters.
   The cleanest wins are making existing coverage more truthful and more reusable, especially for weak-live-probe and freshness-unverified adapters.

## Severity-Ordered Findings

### P0. Coverage depth is materially overstated by the weak-live-probe surface

Why this matters:

- `49 / 119` live-enabled coins are `weak-live-probe`.
- `28 / 119` are `static-validated`.
- Only `42 / 119` are independently measured reserve feeds.

Implication:

- The product currently has strong breadth on the detail/status surface, but much of that breadth is not “live reserve measurement”.
- Remediation planning should separate:
  - breadth wins
  - evidence-quality wins
  - scoring-eligible wins

Recommendation:

- make the evidence tier a first-class planning/ops dimension
- prioritize upgrades that move coins from `weak-live-probe` or `static-validated` into `independent`, not just raw live-enabled count

### P0. `single-asset` is the largest structural accuracy weakness in the system

Files:

- `worker/src/cron/reserve-adapters/single-asset.ts:47-61`
- `worker/src/cron/reserve-adapters/single-asset.ts:63-112`

Issue:

- HTTP mode checks only that a configured JSON path returns a positive numeric-like value.
- On-chain mode checks only that `totalSupply()` is positive, with optional redemption-fee probing.
- In both cases, the adapter emits a `100%` slice and almost no quantitative reserve metadata.

Why this matters:

- This is the adapter behind `48` coins.
- For most of those assets, the sync proves liveness, not reserve size, reserve ratio, reserve freshness, or reserve composition.
- As a result, the detail page can look more authoritative than the underlying evidence class really is.

Recommended remediation:

- keep the adapter, but narrow its claim:
  - rename or surface it as proof-of-structure / proof-of-single-asset, not proof-of-reserve quantity
- add optional metadata probes for:
  - reserve amount
  - reserve timestamp / oracle update timestamp
  - supply vs reserve ratio
- promote eligible names out of `single-asset` into stronger adapter families where public proofs already exist

### P1. `tether` is too coarse and overconfident for a top-tier asset

Files:

- `worker/src/cron/reserve-adapters/tether.ts:22-49`

Issue:

- The adapter reduces USDT to one `100%` slice named `U.S. Treasury Bills, repos, cash, and other reserves` with `risk: "very-low"`.
- It does not model any composition buckets inside “other reserves”.

Why this matters:

- USDT is one of the highest-impact reserve consumers in the product.
- A one-bucket `very-low` classification materially understates composition ambiguity and the residual risk of the unmodeled bucket.

Recommended remediation:

- if Tether’s public endpoint exposes a richer split, parse it
- if not, lower confidence in presentation:
  - either downgrade the risk tier
  - or surface an explicit residual / unclassified slice instead of a fully “very-low” bucket

### P1. Unknown-exposure handling is inconsistent across adapters

Representative files:

- `worker/src/cron/reserve-adapters/accountable.ts:106-141`
- `worker/src/cron/reserve-adapters/fx.ts:33-67`
- `worker/src/cron/reserve-adapters/usdd-data-platform.ts:163-196`

Issue:

- `accountable` silently maps unknown buckets to `medium` risk and does not preserve them as explicit unknown exposure.
- `fx` hard-fails on any unmapped positive key.
- `usdd-data-platform` adds an unknown slice, but only emits an `info` warning even when unknown exposure could be material.

Why this matters:

- Unmapped upstream changes are the most likely real-world drift mode.
- The current behavior varies between:
  - hiding the issue
  - failing closed
  - presenting it but not degrading

Recommended remediation:

- standardize a repo-wide unknown-exposure contract:
  - explicit unknown slice when value can be quantified
  - `unknownExposurePct` in metadata
  - degradation threshold at adapter validation level
  - fail closed only when quantification is impossible

### P1. `accountable` can hide schema drift and may over-aggregate nested exposure structures

Files:

- `worker/src/cron/reserve-adapters/accountable.ts:50-66`
- `worker/src/cron/reserve-adapters/accountable.ts:84-86`
- `worker/src/cron/reserve-adapters/accountable.ts:106-120`

Issue:

- `extractNestedNumericValue()` recursively sums nested objects up to depth 4.
- For `exposure_split`, that means any nested numeric leaf is treated as additive exposure.
- Unknown buckets are defaulted to `medium` rather than isolated as unknown.

Why this matters:

- If the upstream payload starts mixing totals and subtotals in the same subtree, the adapter can double-count while still producing valid percentages.
- This affects 7 live-enabled coins.

Recommended remediation:

- replace the recursive numeric flattening with adapter-owned shape decoding per supported bucket family
- preserve unmapped exposure explicitly instead of defaulting to a known risk bucket

### P1. HTML-based adapters remain the main reliability and maintenance hotspot

Representative files:

- `worker/src/cron/reserve-adapters/circle-transparency.ts:35-126`
- `worker/src/cron/reserve-adapters/mento.ts:43-113`
- `worker/src/cron/reserve-adapters/fdusd-transparency.ts`
- `worker/src/cron/reserve-adapters/sgforge-coinvertible.ts`
- `worker/src/cron/reserve-adapters/re-metrics.ts`

Issue:

- Multiple adapters depend on regexes, DOM class names, or substring needles inside HTML.
- `circle-transparency` also contains a heuristic switch between “percentage mode” and “absolute mode”.
- `mento` extracts escaped JSON using exact marker strings.

Why this matters:

- These adapters are correct only while the current page structure holds.
- The current tests are synthetic and inline; they do not use captured upstream fixtures, so parser drift can reach production before test maintenance catches it.

Recommended remediation:

- prefer embedded JSON/script payload extraction over regex-based text extraction where possible
- store representative real upstream payload fixtures for every HTML adapter
- add a small “shape checksum” or selector-presence regression test per HTML source

### P1. `slicesFromValues()` is not fully aligned with the stricter normalization path

Files:

- `worker/src/cron/reserve-adapters/helpers.ts:615-656`
- `worker/src/cron/reserve-adapters/helpers.ts:597-607`

Issue:

- `slicesFromPercentages()` delegates to `normalizeSlices()`.
- `slicesFromValues()` does not.
- That means `slicesFromValues()` does not deduplicate by `(name, risk, coinId, depType)`, does not sort, and relies on a separate rounding path.

Why this matters:

- The helper contract is inconsistent.
- Adapters that evolve from unique bucket names into repeated bucket names can silently diverge from the normalized path.

Recommended remediation:

- make `slicesFromValues()` build raw percentages and then pass through `normalizeSlices()`
- keep a single rounding and dedupe policy for the whole adapter set

### P1. Number conversion strategy is fragile for large on-chain balances

Representative files:

- `worker/src/cron/reserve-adapters/helpers.ts:531-543`
- `worker/src/cron/reserve-adapters/evm-branch-balances.ts:65-77`

Issue:

- On-chain `bigint` balances are converted into JS `number` early.
- For large balances or high-decimal assets, that can lose precision before valuation.

Why this matters:

- Reserve percentages are robust to small error, but the subsystem is explicitly trying to be precise.
- This especially affects `evm-branch-balances` and other adapters that turn large integer balances into floating-point before valuation.

Recommended remediation:

- keep `bigint` or decimal-string arithmetic longer in the pipeline
- move valuation to a shared decimal math helper instead of early `number` conversion

### P2. Manual symbol/farm maps are the main long-term maintenance burden

Representative files:

- `worker/src/cron/reserve-adapters/asymmetry.ts`
- `worker/src/cron/reserve-adapters/btcfi.ts`
- `worker/src/cron/reserve-adapters/collateral-positions-api.ts`
- `worker/src/cron/reserve-adapters/crvusd.ts`
- `worker/src/cron/reserve-adapters/dola-inverse.ts`
- `worker/src/cron/reserve-adapters/ethena.ts`
- `worker/src/cron/reserve-adapters/falcon.ts`
- `worker/src/cron/reserve-adapters/fx.ts`
- `worker/src/cron/reserve-adapters/infinifi.ts`
- `worker/src/cron/reserve-adapters/mento.ts`
- `worker/src/cron/reserve-adapters/reservoir.ts`
- `worker/src/cron/reserve-adapters/sky-makercore.ts`

Issue:

- Hardcoded token/farm sets and risk maps are spread across many files.
- The unknown-exposure logic around them is also duplicated.

Why this matters:

- Coverage expansion mostly adds more names and more mappings, not more orchestration complexity.
- This is where LOC and maintenance cost will keep growing.

Recommended remediation:

- centralize reusable mapping primitives:
  - symbol -> bucket
  - bucket -> label/risk/coinId/depType
  - unknown-handling policy
- keep adapter-specific overrides, but stop re-implementing the same mapping shape file by file

### P2. The main hotspots are still the shared helper layer and `gho`

Current sizes:

- `worker/src/cron/reserve-adapters/helpers.ts`: `674` LOC
- `worker/src/cron/reserve-adapters/gho.ts`: `533` LOC
- `worker/src/lib/live-reserves-store-view.ts`: `421` LOC

Assessment:

- These files are not obviously wrong.
- They are the most likely places for future accidental complexity and regression risk.

Recommended remediation:

- split `helpers.ts` into:
  - fetch/http
  - on-chain reads
  - percentage math
  - freshness/warnings
- split `gho.ts` into:
  - ABI decode helpers
  - facilitator loading
  - tracked-GSM loading
  - final adaptation

### P3. `infinifi` has a concrete metadata bug

File:

- `worker/src/cron/reserve-adapters/infinifi.ts:155-157`

Issue:

- `activeFarmCount` is set to `adapted.slices.length`, not the real number of active farms.

Why this matters:

- The slice count can be materially smaller than active farm count once multiple farms map into the same bucket or once zero-value tails are removed.

Recommended remediation:

- report the actual filtered `activeFarms.length`

## Adapter-by-Adapter Review

| Adapter | Coins | Accuracy Assessment | Maintainability Assessment | Recommended Next Step |
| --- | ---: | --- | --- | --- |
| `accountable` | 7 | Medium risk. Good source family, but unmapped buckets are defaulted into `medium` and `exposure_split` is recursively flattened. | Medium risk. Custom parsing and bucket semantics are still adapter-specific. | Add explicit unknown slice support and replace recursive flattening with shape-specific decoding. |
| `asymmetry` | 1 | Medium risk. Reasonable branch bucketing, but no verified freshness and manual branch taxonomy. | Low-medium. Small file, but taxonomy drift risk remains. | Add a source timestamp if the upstream exposes one; centralize branch metadata. |
| `btcfi` | 1 | Medium risk. Correct fail-closed behavior, but a short wrapper allowlist can drift quickly. | Low-medium. Simple but taxonomy-bound. | Add explicit “other BTC wrappers” metadata and maintain wrapper map centrally. |
| `chainlink-nav` | 3 | Strong. Best-in-class single-asset proof family. Only `getPrice()` mode lacks verified freshness. | Medium. Some manual decode plumbing, but contained. | Keep; prefer `latestRoundData()` paths whenever possible. |
| `chainlink-por` | 1 | Strong. Clear semantics, verified oracle freshness. | Low. Clean and small. | Reuse for more eligible assets. |
| `circle-transparency` | 2 | Medium-high risk. Scrape is workable, but heuristic absolute/percentage detection is brittle. | Medium-high. HTML attribute scraping will drift. | Prefer a machine-readable source if Circle exposes one; otherwise add real fixture tests. |
| `collateral-positions-api` | 2 | Medium risk. Good reconciliation, but missing prices hard-fail and symbol mapping is manual. | Medium. Mapping table will keep growing. | Add price fallback policy and shared bucket metadata. |
| `crvusd` | 1 | Medium risk. Coarse but understandable bucketing; freshness unverified. | Low-medium. Small file, manual mapping. | Keep, but centralize symbol bucket definitions with other crypto-backed adapters. |
| `curated-validated` | 24 | Accurate only for its intended role: proving “tracked and non-zero” while serving curated composition. | Low. Very small and honest. | Keep, but do not treat as coverage-quality parity with independent feeds. |
| `dola-inverse` | 1 | Medium. Good unknown-exposure handling; bucket taxonomy is still hand-curated. | Low-medium. | Keep, centralize bucket map. |
| `erc4626-single-asset` | 2 | Medium. Better than `single-asset`, but still mostly a structural proof plus optional asset-address check. | Medium. Some duplication with `single-asset`. | Consolidate common single-asset proof logic. |
| `ethena` | 1 | Medium. Reconciles totals well; bucketing is intentionally coarse by asset family. | Low-medium. | Keep; consider finer-grained stable/custody breakout only if UI needs it. |
| `evm-branch-balances` | 3 | Strong-medium. Good on-chain structure, but price dependence and float conversion are the main weak spots. | Medium. This is the best reusable family and should stay clean. | Add coinId-aware price fallback and decimal-safe valuation. |
| `falcon` | 1 | Medium. Useful live mix, but summed numeric fields and large allowlists are fragile. | Medium. Large manual asset sets. | Make summed-field decoding explicit and centralize asset taxonomy. |
| `fdusd-transparency` | 1 | Medium. Good parseable timestamp; still HTML-regex based. | Medium. | Add stored fixtures; keep as-is otherwise. |
| `frax` | 2 | Medium. Useful as static-validated coverage, but not true live composition. | Low. Small and honest. | Keep, but look for a stronger independent source before expanding the family. |
| `fx` | 1 | Medium-high risk. The tiny token map means any new upstream key becomes an outage. | Medium. Small file, high drift sensitivity. | Add explicit unknown slice handling or richer source metadata. |
| `gho` | 1 | Strong-medium. Thoughtful adapter, but residual issuance aggregation still limits certainty. | High hotspot risk. Largest and most custom adapter. | Split the file and add stronger tracked-module completeness checks. |
| `infinifi` | 1 | Medium. Useful live mix, but still driven by a large manual farm map. | Medium. Metadata bug and mapping sprawl. | Fix metadata bug, centralize farm classification. |
| `m0` | 4 | Medium. Good reconciliation, but the hardcoded cash scale is brittle if upstream units change. | Low-medium. Shared-source reuse is good. | Add an invariant or explicit upstream unit field check. |
| `mento` | 3 | Medium-high risk. Good signal, but parsing escaped JSON out of HTML is brittle and freshness is unverified. | Medium-high. | Prefer source JSON if available; otherwise add fixture coverage. |
| `openeden-usdo` | 1 | Strong-medium. Good component reconciliation and useful metadata. | Low-medium. | Keep; this is one of the better JSON adapters. |
| `re-metrics` | 1 | Medium-high risk. Valuable feed, but HTML-embedded JSON and symbol mapping are drift-prone. | Medium-high. | Add captured fixtures and consider centralizing symbol config. |
| `reservoir` | 1 | Medium. Label-based bucket matching is easy to drift, and immediate redeemability is simplified to USDC only. | Medium. | Make bucket matching more explicit and review redeemability assumptions. |
| `sgforge-coinvertible` | 1 | Medium. Good simple attestation, but regex parsing and single-bank assumption are brittle. | Medium. | Add a reconciliation check between circulation, cash amount, and bank share. |
| `single-asset` | 48 | High structural weakness. Great for liveness, weak for reserve truth. | Low code complexity, high conceptual debt. | Add richer optional probes and aggressively graduate assets out of this family. |
| `sky-makercore` | 2 | Medium. Good aggregate view, but bucketing is coarse and shared-source assumptions depend on one upstream structure. | Low-medium. | Keep; centralize token taxonomy. |
| `tether` | 1 | High risk of overconfidence. One bucket, too-low risk labeling. | Low code complexity, high semantic weakness. | Replace with richer composition or a more conservative residual model. |
| `usdd-data-platform` | 1 | Medium-high. Good source family, but unknown vaults are only informational. | Low-medium. | Make unknown exposure degrading when material. |

## Code-Quality And Mutualization Opportunities

### 1. Introduce a shared bucket-classification DSL

High value, low-medium effort.

Target shape:

- input symbol / label matcher
- output bucket label
- output risk / coinId / depType / blacklistable
- unknown-handling mode

Primary beneficiaries:

- `asymmetry`
- `btcfi`
- `collateral-positions-api`
- `crvusd`
- `dola-inverse`
- `ethena`
- `falcon`
- `fx`
- `infinifi`
- `mento`
- `reservoir`
- `sky-makercore`

### 2. Unify `slicesFromValues()` and `normalizeSlices()`

High value, small effort.

Result:

- one rounding policy
- one dedupe policy
- one sort order
- less adapter-local cleanup code

### 3. Split `helpers.ts`

Medium value, medium effort.

Suggested modules:

- `http-fetch.ts`
- `onchain-fetch.ts`
- `slice-math.ts`
- `freshness.ts`
- `warnings.ts`

### 4. Add fixture-based parser tests for every HTML adapter

High value, small effort.

Current gap:

- adapter tests exist for all adapters, but the HTML ones rely mostly on inline synthetic snippets

Suggested approach:

- store minimal captured payload fixtures under `worker/src/cron/reserve-adapters/__fixtures__/`
- assert both happy-path parsing and intentional failure on missing selectors

### 5. Separate “coverage count” from “coverage quality” in docs and planning

High value, small effort.

Reason:

- raw live-enabled count is now actively misleading for planning unless it is paired with evidence quality

## Low / Mid-Effort Wins

### Quality wins with the best ROI

1. Add explicit unknown-exposure policy to `accountable`, `fx`, and `usdd-data-platform`.
   Impact:
   data accuracy improves immediately for 9 coins, with no architecture change.

2. Add source-timestamp extraction where the upstream already exposes it.
   Best current targets:
   `circle-transparency`, `mento`, `m0`, `reservoir`, `infinifi`, `crvusd`, `collateral-positions-api`, `fx`, `asymmetry`, `btcfi`.
   Impact:
   improves the trustworthiness of 17 currently freshness-unverified independent coins.

3. Add coinId-aware or fixed-price fallback support to `evm-branch-balances`.
   Impact:
   improves current reliability and preserves the best path for future basket-backed assets without inventing new adapters.

4. Add richer optional probes to `single-asset`.
   Impact:
   upgrades the weakest family in the system without changing the outer sync architecture.

5. Add real upstream fixtures for all HTML adapters.
   Impact:
   cheap reliability hardening, especially for `circle-transparency`, `fdusd-transparency`, `mento`, `re-metrics`, and `sgforge-coinvertible`.

### Breadth wins that still look realistic

The repo’s own research suggests genuinely clean net-new breadth wins are thinner than they were two weeks ago. The best remaining short-term opportunities are:

1. Re-enable `ousd-origin-protocol` once Origin restores a public collateral endpoint or a stable replacement source.
   Status:
   previously disabled in repo notes because the old endpoint returned `404`.
   Effort:
   small once the source exists again.

2. Promote current weak/static names into stronger families where the public proof path already exists.
   Likely candidates:
   issuer-RWA or single-asset names currently on `single-asset` / `curated-validated`, especially where a public NAV oracle, PoR oracle, or ERC-4626 proof exists.
   Effort:
   small to medium, and better ROI than another brand-new one-off scraper.

3. Add fallback inputs to more single-source adapters.
   Current state:
   only `usdd-data-platform` uses `inputs.fallbacks`.
   Effort:
   small, and improves reliability without changing evidence semantics.

### What not to spend the next cycle on

Based on current repo research:

- access-blocked sources such as `ousg-ondo-finance`
- geofenced sources such as `usda-avalon`
- marketing-only or PDF-only surfaces such as `ylds-figure`, `usx-solstice`, `cash-phantom`, `kau-kinesis`

These may become viable later, but they are not current low-effort wins.

## Recommended Remediation Order

1. Quality labeling and evidence-tier planning fix.
   Output:
   separate breadth, independent evidence, and weak/static coverage metrics everywhere live reserve health is discussed.

2. Unknown-exposure normalization pass.
   Target:
   `accountable`, `fx`, `usdd-data-platform`, then any other adapter that still hides unmapped exposure.

3. `single-asset` upgrade pass.
   Target:
   add optional reserve amount / reserve timestamp / ratio probes and review the 48 covered coins for graduation candidates.

4. HTML hardening pass.
   Target:
   all HTML adapters plus fixture capture.

5. Shared-helper / mapping consolidation pass.
   Target:
   split hotspots and centralize classification maps.

6. Opportunistic breadth only after the above.
   Reason:
   the current system’s biggest problem is evidence quality, not missing adapter count.

## Bottom Line

The live reserve sync implementation is stable enough to build on. The next phase should not be another breadth sprint.

The highest-value work now is:

- make weak coverage visibly weak instead of merely “live”
- remove the remaining overconfident adapter behaviors
- standardize unknown-exposure handling
- harden the HTML parsers
- consolidate the duplicated classification logic before adding more long-tail coverage

If that is done first, the next breadth expansion will be cheaper, safer, and much more truthful.
