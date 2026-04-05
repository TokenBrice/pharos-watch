# Redemption Backstop Comprehensive Audit

Date: 2026-03-30

## Scope

This audit covers the full redemption backstop module:

- Registry and route-family configs
  - `shared/lib/redemption-backstops.ts`
  - `shared/lib/redemption-backstop-configs/*`
  - `shared/lib/redemption-backstop-confidence.ts`
  - `shared/lib/redemption-backstop-scoring.ts`
  - `shared/types/redemption.ts`
- Worker runtime and persistence
  - `worker/src/cron/sync-redemption-backstops.ts`
  - `worker/src/lib/redemption-backstop-sources.ts`
  - `worker/src/lib/redemption-backstop-live-metadata.ts`
  - `worker/src/lib/redemption-backstops-store.ts`
  - `worker/src/api/redemption-backstops.ts`
- Live-reserve bridge used by dynamic redemption routes
  - `worker/src/lib/live-reserves-store-view.ts`
  - `shared/lib/live-reserve-adapters.ts`
  - reserve adapters currently feeding `reserve-sync-metadata`
- Downstream consumers
  - `worker/src/lib/report-cards-snapshot.ts`
  - `src/components/stablecoin-detail/redemption-backstop-card.tsx`
  - `src/lib/coverage.ts`
- Guardrails and docs
  - `scripts/check-redemption-backstops.ts`
  - `docs/redemption-backstops.md`
  - `docs/api-reference.md`

## Current Snapshot

As of the current codebase:

- Configured routes: `144`
- Route families:
  - `79` `offchain-issuer`
  - `20` `stablecoin-redeem`
  - `20` `collateral-redeem`
  - `14` `queue-redeem`
  - `8` `psm-swap`
  - `3` `basket-redeem`
- Capacity models:
  - `119` `supply-full`
  - `16` `supply-ratio`
  - `9` `reserve-sync-metadata`
- Capacity confidence at config level:
  - `123` `documented-bound`
  - `12` `heuristic`
  - `9` implicit `dynamic`
- Fee models:
  - `103` `dynamic-or-unclear`
  - `41` `fee-bps`
- Review/evidence coverage:
  - `132` routes with `reviewedAt`
  - `96` routes with explicit `docs[]`
  - `36` `documented-bound` routes still rely on fallback links instead of explicit route docs
  - `12` routes still have no `reviewedAt`

## Executive Summary

The module is useful and reasonably well isolated, but it still has two major integrity problems:

1. The runtime treats live reserve metadata as more trustworthy than the code or docs can justify.
2. The public methodology/docs now overstate capabilities that the current code does not actually implement.

The result is a system that often looks stricter and more evidence-backed than it really is. Accuracy is decent for many documented issuer-style routes and a few onchain direct routes, but the dynamic path is still too optimistic, too loosely typed, and not cleanly separated from proxy estimates.

The maintainability story is mixed:

- The registry split by family was the right move.
- The runtime resolver is still a large mixed-responsibility file.
- The config surface is still boilerplate-heavy, especially `offchain-issuer.ts`.
- There is clear evidence of an unfinished or partially reverted remediation pass: docs and historical plans describe behavior that current code does not implement.

## Findings

### 1. Critical: live reserve metadata trust is still weaker than the docs claim

Evidence:

- `worker/src/lib/live-reserves-store-view.ts:243-280` returns snapshot metadata for any consistent stored snapshot.
- `worker/src/lib/redemption-backstop-live-metadata.ts:19-34` decides freshness from `fetchedAt` alone.
- `worker/src/lib/redemption-backstop-sources.ts:168-198` and `worker/src/lib/redemption-backstop-sources.ts:281-307` consume live fee/capacity whenever `isFresh` and the metadata fields exist.
- `docs/redemption-backstops.md:143-149` claims reserve-sync capacity ignores degraded snapshots, weak adapters, and non-scoring-grade freshness evidence.

What is actually missing at runtime:

- no `syncStatus === "ok"` gate
- no `warningCount === 0` / no degrading-warning gate
- no `evidenceClass` gate
- no `hasScoringEligibleLiveReserveFreshness(...)` gate
- no use of adapter capability metadata to distinguish direct capacity vs proxy capacity vs fee-only telemetry

Impact:

- A recent but degraded reserve snapshot can still feed redemption scoring.
- A recent local fetch can mask stale upstream data when the payload lacks a trustworthy source timestamp.
- Dynamic redemption rows can overstate accuracy and confidence relative to the live-reserve subsystem’s own stricter scoring boundary.

Planning recommendation:

- Add a dedicated `isReserveMetadataEligibleForRedemption()` gate and use it in both fee and capacity paths.
- Require, at minimum: `syncStatus === "ok"`, no degrading warnings, allowed evidence class, and scoring-eligible freshness when source freshness is supposed to matter.

### 2. Critical: the docs/API contract are materially out of sync with the code

Evidence:

- `shared/types/redemption.ts:65-69` only allows `capacityConfidence = dynamic | documented-bound | heuristic`.
- `docs/redemption-backstops.md:143-149` and `docs/api-reference.md:1479` document `live-direct` and `live-proxy`.
- `worker/src/lib/redemption-backstop-confidence.ts:12-16` still collapses every reserve-sync route to `dynamic`.
- `worker/src/lib/redemption-backstops-store.ts:188-200` only stores a small subset of details in `details_json`.
- `docs/redemption-backstops.md:225` claims `details_json` stores route attributes, subscores, provider/source provenance, and immediate-capacity fields, which it does not.

Impact:

- The public methodology is not a faithful description of runtime behavior.
- Reviewers and future implementers can make decisions based on non-existent capabilities.
- This weakens trust in the module’s own explainability surface.

Planning recommendation:

- Treat doc/code parity as a first-class remediation item, not cleanup.
- Either implement the documented model, or reduce the docs to the actual current contract before more coverage work lands.

### 3. Critical: `pusd-plume` is still configured as dynamic even though its adapter cannot emit capacity

Evidence:

- `shared/lib/redemption-backstop-configs/offchain-issuer.ts:328-339` configures `pusd-plume` as `reserve-sync-metadata` with `fallbackRatio: 1`.
- `worker/src/cron/reserve-adapters/single-asset.ts:38-113` only emits a 100% reserve slice plus optional `redemptionFeeBps`; it never emits `immediateRedeemableUsd` or `immediateRedeemableRatio`.
- `worker/src/lib/redemption-backstop-sources.ts:281-307` requires one of those immediate-capacity fields for dynamic resolution.

Impact:

- `pusd-plume` can never truly resolve dynamically.
- The config note overstates implementation reality.
- The route silently degrades to a 100% fallback ratio and still looks more sophisticated than it is.

Planning recommendation:

- Reclassify `pusd-plume` to a reviewed documented-bound route now, unless a real redeemable-capacity metric is added to the adapter.

### 4. High: all reserve-sync routes are still collapsed into one `dynamic` bucket

Evidence:

- `shared/lib/redemption-backstop-confidence.ts:12-16` maps every `reserve-sync-metadata` model to `dynamic`.
- `shared/lib/redemption-backstop-confidence.ts:72-82` allows `dynamic + non-undisclosed fee` to resolve `high`.
- `worker/src/lib/redemption-backstop-sources.ts:270-305` gives the same `capacityConfidence = "dynamic"` to every successful reserve-sync route.

This is too coarse. The current dynamic routes are not equivalent:

| Route | Adapter | Current signal | Audit view |
| --- | --- | --- | --- |
| `usdo-openeden` | `openeden-usdo` | `immediateRedeemableUsd = usdcAmount` with verified timestamp | strongest current live route; close to direct buffer telemetry |
| `dai-makerdao`, `usds-sky` | `sky-makercore` | PSM `USDC` balance from DefiLlama protocol holdings | usable but still a proxy derived from reserve composition, not a dedicated redemption-limit feed |
| `gho-aave` | `gho` | onchain swappable GSM backing + live fee range | strongest fully onchain direct-ish route, but residual warnings are still ignored by redemption |
| `iusd-infinifi` | `infinifi` | `totalLiquidAssetNormalized` | potentially useful, but freshness is unverified and farm classification drift can degrade quality |
| `usdf-falcon` | `falcon` | stable bucket from transparency payload | proxy buffer, not explicit queue-executable capacity |
| `usde-ethena` | `ethena` | `Liquid Cash` bucket | proxy buffer; docs themselves distinguish smaller on-demand hot liquidity from total liquid cash |
| `wsrusd-reservoir` | `reservoir` | all `USDC` positions | proxy buffer and likely optimistic for instant executable capacity |
| `pusd-plume` | `single-asset` | no capacity fields | not actually dynamic |

Impact:

- The confidence model cannot tell direct redeemable liquidity from proxy reserve buckets.
- Some proxy routes can be promoted more aggressively than they deserve.

Planning recommendation:

- Introduce a typed live-capacity fidelity model:
  - `live-direct`
  - `live-proxy`
  - `fee-only` or `none`
- Make `high` confidence require `live-direct`, not just any reserve-sync route.

### 5. High: the sync still does per-coin reserve-metadata reads and contains an unfinished preload refactor

Evidence:

- `worker/src/cron/sync-redemption-backstops.ts:61-80` calls `resolveRedemptionBackstopEntry()` / `buildRedemptionBackstopEntry()` per coin without preloaded reserve metadata.
- `worker/src/lib/redemption-backstop-sources.ts:276-279` and `worker/src/lib/redemption-backstop-sources.ts:455-458` fetch metadata on demand.
- `worker/src/lib/live-reserves-store-view.ts:243-280` contains `loadReserveSnapshotMetadataMap(...)`, but it is only used inside `getLatestSuccessfulReserveSnapshotMetadata(...)` for a single ID.

Impact:

- Avoidable D1 reads remain in the hourly backstop job.
- There is dead or unfinished abstraction surface in the live-reserve view layer.
- This is a maintainability smell: the code suggests a batch-loading plan that never actually landed.

Planning recommendation:

- Either finish the preload path and pass a metadata map through the sync, or delete the unused batch helper and keep the simpler model.

### 6. High: docs provenance is still visually flattened in the detail UI

Evidence:

- `worker/src/lib/redemption-backstop-sources.ts:67-142` can build docs from reviewed config docs, live-reserve display links, proof-of-reserves links, or generic preferred links.
- `worker/src/lib/redemption-backstop-sources.ts:77-83` always carries `reviewedAt` when the config has it, even if the displayed link is a fallback.
- `src/components/stablecoin-detail/redemption-backstop-card.tsx:324-327` renders `Reviewed <date>` instead of provenance when `reviewedAt` exists.

Impact:

- A fallback link can still read like the reviewed primary source.
- This is especially misleading because `36` documented-bound routes currently lack explicit `docs[]` and therefore rely on fallback evidence.

Planning recommendation:

- Always render both `Reviewed <date>` and the provenance label.
- Add a guardrail: `documented-bound` routes should require explicit `docs[]`.

### 7. Medium: the config guardrails are too weak for the current evidence model

Evidence:

- `scripts/check-redemption-backstops.ts:98-110` only validates `feeDescription`, non-negative `feeBps`, and `supply-ratio` bounds.

Missing checks that now matter:

- `documented-bound` requires `reviewedAt`
- `documented-bound` requires explicit `docs[]`
- `reserve-sync-metadata` routes must point to adapters that can emit capacity
- docs/API enum parity
- reserve-sync routes cannot rely on weak or degraded metadata

Planning recommendation:

- Expand the script from “registry sanity” into an actual evidence-contract gate.

### 8. Medium: the config surface is still too repetitive and review-heavy

Evidence:

- `shared/lib/redemption-backstop-configs/offchain-issuer.ts` is `851` LOC.
- `shared/lib/redemption-backstop-configs/stablecoin-redeem.ts` is `336` LOC.
- The same patterns repeat across dozens of issuer-style routes:
  - `...issuerBase`
  - reviewed supply-full
  - one fee override
  - optional settlement override
  - a few docs
  - one note

Impact:

- The module is harder to review than it needs to be.
- Evidence updates and mechanical refactors create large noisy diffs.
- Consistency bugs are more likely because patterns are encoded as ad hoc object literals.

Planning recommendation:

- Introduce small factories for common route classes:
  - reviewed issuer 1:1
  - reviewed issuer delayed settlement
  - reviewed queue route
  - reviewed supply-ratio bound with docs
- Keep evidence data in the family files, but move pattern mechanics into helpers.

### 9. Medium: ratio/full-supply semantics are still under-typed

Examples:

- `supply-ratio` can mean a documented daily redemption cap, a hot wallet buffer, a PSM share, or a conservative strategy buffer.
- `supply-full` can mean “fully redeemable in issuer terms” or “fully redeemable in immutable onchain system terms.”

Today those distinctions mostly live in notes, not in typed fields.

Impact:

- The model is hard to query programmatically.
- Similar-looking routes can carry very different operational meaning.
- Planning future scoring changes will keep requiring manual note review.

Planning recommendation:

- Add an evidence-subtype or capacity-basis field for bounded models:
  - `hot-buffer`
  - `psm-balance-share`
  - `daily-limit`
  - `full-system-eventual`
  - `issuer-term-redemption`

## Adapter Audit

### `openeden-usdo`

- Assessment: best current live-capacity adapter.
- Strengths:
  - verified source timestamp (`worker/src/cron/reserve-adapters/openeden.ts:27-28`, `worker/src/cron/reserve-adapters/openeden.ts:95-109`)
  - immediate buffer tied to explicit `USDC` amount
  - internal consistency checks on totals and reserve ratio
- Weakness:
  - still relies on redemption runtime that ignores `syncStatus`, warnings, and scoring-grade freshness policy
- Recommendation:
  - keep as the reference implementation for direct live capacity

### `sky-makercore`

- Assessment: useful but still proxy-like.
- Strengths:
  - verified snapshot date
  - explicit extraction of PSM `USDC` balance (`worker/src/cron/reserve-adapters/sky-makercore.ts:40-44`)
- Weaknesses:
  - relies on DefiLlama protocol holdings rather than a Maker-native redemption-limit feed
  - the routes themselves still have no explicit reviewed docs/config evidence (`dai-makerdao`, `usds-sky`)
- Recommendation:
  - add explicit reviewed docs for DAI/USDS
  - keep this out of the strongest live-confidence tier unless a more protocol-native feed is available

### `gho`

- Assessment: strongest fully onchain redemption adapter in the module.
- Strengths:
  - live onchain backing from tracked GSM modules
  - frozen/seized modules excluded from immediate capacity
  - live fee range available (`worker/src/cron/reserve-adapters/gho.ts:407-460`)
- Weakness:
  - residual issuance and degraded warnings are surfaced, but redemption runtime does not gate on them
- Recommendation:
  - preserve as the benchmark for direct onchain live capacity
  - wire warning/status gating through redemption

### `infinifi`

- Assessment: promising but not strong enough for current dynamic treatment.
- Strengths:
  - explicit `totalLiquidAssetNormalized` metric
  - pending redemptions and illiquid reserve metadata are exposed
- Weaknesses:
  - no trustworthy source timestamp (`worker/src/cron/reserve-adapters/infinifi.ts:154-172`)
  - unknown farm mapping degrades confidence
  - route still has no `reviewedAt` / explicit docs in the backstop config
- Recommendation:
  - either add verified freshness + route review, or stop treating the route as strong live telemetry

### `ethena`

- Assessment: proxy-only dynamic route today.
- Strengths:
  - verified timestamps from collateral rows
  - total-vs-component reconciliation
- Weaknesses:
  - `immediateRedeemableUsd = Liquid Cash` (`worker/src/cron/reserve-adapters/ethena.ts:81-131`) is a reserve proxy, not obviously the same as executable redemption buffer
  - config note itself distinguishes smaller on-demand hot liquidity from the larger liquid-cash bucket (`shared/lib/redemption-backstop-configs/stablecoin-redeem.ts:57-88`)
- Recommendation:
  - split current “capacity” into proxy vs direct
  - if possible, ingest the smaller documented hot-redemption buffer directly

### `falcon`

- Assessment: proxy-only dynamic route for a queued rail.
- Strengths:
  - verified snapshot timestamp
  - unknown-asset warnings
- Weaknesses:
  - `immediateRedeemableUsd = stableBucketUsd` (`worker/src/cron/reserve-adapters/falcon.ts:137-192`) is a reserve-composition proxy
  - route settlement is still a documented 7-day cooldown
- Recommendation:
  - downgrade from the strongest live-confidence semantics
  - prefer explicit queue-capacity telemetry if Falcon exposes it

### `reservoir`

- Assessment: likely optimistic proxy.
- Strengths:
  - explicit liabilities/supply basis
  - unmapped positions are surfaced as warnings
- Weaknesses:
  - no trustworthy source timestamp (`worker/src/cron/reserve-adapters/reservoir.ts:181-210`)
  - `immediateRedeemableUsd` is just all `USDC` positions (`worker/src/cron/reserve-adapters/reservoir.ts:141-148`)
  - unwrap-to-rUSD plus PSM exit semantics are not the same thing as instantly executable `USDC`
- Recommendation:
  - keep as proxy at best
  - do not let it resolve `high`

### `single-asset`

- Assessment: reserve presence probe, not a redemption-capacity adapter.
- Strengths:
  - simple and reusable for live reserve composition
  - optional fee probe support
- Weakness:
  - no capacity emission at all
- Recommendation:
  - ban it from `reserve-sync-metadata` backstop configs unless capacity fields are added

## Maintainability Review

### What is working

- Family-based config split is good.
- Shared scoring/confidence/types are still reasonably local.
- API/store path is straightforward.
- Coverage and report-card consumers already respect `modelConfidence === "low"` and unresolved routes.

### Main maintainability risks

- `worker/src/lib/redemption-backstop-sources.ts` is doing too much: docs resolution, fee resolution, capacity resolution, scoring, confidence, entry assembly, and fallback notes.
- Config files encode evidence semantics mostly in prose notes instead of typed fields.
- Historical plan/docs and actual runtime behavior have diverged.
- The live-reserve bridge layer exposes richer concepts than the redemption module actually uses.

## Low / Mid Effort Wins

### Low effort

1. Fix doc/code drift immediately.
   - Align `docs/redemption-backstops.md` and `docs/api-reference.md` with current runtime, or implement the documented enums and gates.

2. Reclassify `pusd-plume`.
   - Remove the fake dynamic route.

3. Strengthen registry guardrails.
   - Enforce `documented-bound => reviewedAt + docs[]`.
   - Enforce `reserve-sync-metadata => adapter emits capacity`.

4. Route-review the `12` remaining unreviewed configs.
   - `zarp-zarp`
   - `cetes-etherfuse`
   - `cgo-comtech`
   - `dgld-gold-token-sa`
   - `dai-makerdao`
   - `usds-sky`
   - `dusd-alto`
   - `ussd-sonic-labs`
   - `usdp-parallel`
   - `iusd-infinifi`
   - `dusd-dtrinity`
   - `yousd-yield-optimizer`

5. Show provenance and review date together in the detail card.

### Mid effort

1. Add a real redemption metadata eligibility gate.
   - This is the highest-value correctness fix.

2. Split live capacity into direct vs proxy.
   - Needed for honest confidence and better planning.

3. Finish the metadata preload refactor or delete it.

4. Replace the most important heuristic/proxy routes with better evidence:
   - `USDD`: existing reserve adapter + PSM semantics make this the clearest large-cap accuracy win.
   - `USDe`: refine live capacity semantics and/or live fee telemetry.
   - `wsrUSD`: better fee-confidence source and stricter capacity semantics.
   - `DOLA`, `reUSD`, `LISUSD`: current configs are close enough that better bounded evidence or telemetry could materially improve fidelity.

## Recommended Planning Order

### Phase 1: Truth boundary hardening

- Fix doc/code mismatch
- Add redemption eligibility gate for live metadata
- Reclassify `pusd-plume`
- Strengthen guardrails/tests

### Phase 2: Confidence honesty

- Introduce `live-direct` vs `live-proxy`
- Prevent proxy routes from resolving `high`
- Update detail UI to show provenance honestly

### Phase 3: Config-surface cleanup

- Extract config factories
- Refactor `redemption-backstop-sources.ts` into smaller resolvers
- Finish or remove reserve metadata preload abstraction

### Phase 4: Coverage expansion after correctness

- `USDD`
- `USDe`
- `wsrUSD`
- `DOLA`
- `reUSD`
- `LISUSD`

## Acceptance Criteria For The Next Implementation Plan

- No reserve-sync route can score from degraded or weak metadata.
- No fee-only adapter can pretend to provide live capacity.
- Proxy live liquidity and direct redeemable liquidity are visibly distinct in API, docs, and UI.
- `documented-bound` routes always carry explicit reviewed source links.
- The runtime types, API docs, and methodology doc describe the same model.
- The sync path has no dead preload abstraction and no avoidable per-coin reserve metadata reads.
