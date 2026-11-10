# Redemption Backstops: Technical Reference

> **Agent navigation** — Start with the [public scoring contract](../redemption-backstops.md). Use [Cron Schedule](#cron-schedule), [Config Registry](#config-registry), [Docs / Notes](#docs--notes), [Cost Modeling](#cost-modeling), [Provider / Source Definitions](#provider--source-definitions), or [Database Schema](#database-schema) for bounded implementation reads.

The [public methodology](../redemption-backstops.md) owns the scoring contract. This appendix retains implementation and storage history; runtime code, config registries and migrations remain authoritative for current values and behavior.

## Cron Schedule

- **Pattern:** `11 */4 * * *`
- **Function:** `syncRedemptionBackstops(db, signal)`
- **File:** `worker/src/cron/sync-redemption-backstops.ts`
- **Trigger order:** runs after `sync-live-reserves` in the 4-hourly reserve lane (`worker/src/handlers/scheduled/four-hourly-reserves.ts`)

The cron reads:

1. The strict `stablecoins` cache via `loadStablecoinsCache(...)`, including its generation timestamp, underlying price-observation timestamps and provenance, FX references, and same-generation prices used to derive current signed deviations
2. Published DEX liquidity scores and their latest admitted timestamp via `loadDexLiquidityScores(db)`: 64-row pages preserve the full snapshot's coverage and exit-route quarantine rules while discarding unused route graphs and omitting deployment census reads. Row update/publication identities are fenced before, during and after pagination; concurrent publication drift fails closed through the existing preload-warning path.
3. One validated sealed reserve envelope from `cache['live-reserves:accepted-generation:v2']`, reassessed against current configuration and consumer time; no mutable reserve-row fallback is permitted

Live reserve telemetry is reused from the accepted D1 envelope without refetching reserve adapters. Registry-declared direct executable observers instead perform bounded same-run RPC reads using the scheduled runtime transport; they do not fabricate reserve consumption.
The four-hour source cadence and consumer lease are unchanged. Scheduled redemption is a cohort tail on a fresh five-minute recovery invocation after the full reserve frontier exhausts; incomplete/error/locked heads no longer launch repeated redemption passes against previous acceptance. A consumer-only continuation retries only unfinished consumers and retains all producer/domain mutation fences. Missing, malformed or unreadable acceptance returns `accepted-reserve-view-unavailable` or `accepted-reserve-view-invalid` without writing a run. Per-asset rejected evidence retains existing missing/static-fallback semantics.

Independent asset resolvers use the existing `mapWithConcurrency` worker pool with `REDEMPTION_BACKSTOP_RESOLVE_CONCURRENCY = 3` from `shared/lib/cron-jobs.ts`; that same constant owns the natural redemption and recovery connection reservations. Each observer retains its sequential, body-draining RPC/proof steps. Five-minute recovery keeps its phases and Kinesis serialized; the per-slot arithmetic is owned by [Cron Slot Capacity and Connection Pool Budget](worker-infrastructure-appendix.md#cron-slot-capacity-and-connection-pool-budget), under the [connection-budget operating assumption](../worker-and-api-limits.md#connection-budget-operating-assumption). The resolver pool changes neither freshness/admission nor the 300-second child timeout.

Results and failed-row placeholders are collected by input index and published in configured order only after every resolver settles; one asset failure remains isolated. Cancellation stops admission of new assets, drains already-started resolvers and prevents partial publication. Resolution progress counts completed resolvers (including failed rows), coalesced after ten completions or fifteen seconds and on completion, with serialized reporting to prevent stale progress overwrites.

Final row and selected-detail schema admission happens inside each asset's failure boundary, then again after the output-dependency join. A malformed member becomes an explicit failed placeholder with unavailable capacity; `sourceFailureReasons[id]` records `redemption-snapshot-schema-invalid`, `schemaPath`, and the schema's machine-readable `schemaReason`. If a post-join member fails, disclosures are rebuilt against that placeholder and revalidated before opening the immutable manifest. Healthy rows and placeholders retain the complete configured census; storage validation remains defense in depth. Global reserve/stablecoins admission holds and cancellation before publication still write no snapshot rows.

Only selected capacity, fee, route-status/output or specialized-route evidence carries `reserveInput` in immutable `details_json`: generation/digest, asset, successful attempt, configuration fingerprint and the consumed `ReserveFreshnessView`. Direct RPC, unused and purely static evidence remain unbound. Accepted reserve envelopes and consumed manifests use schema v2: original `freshnessMode` (including absent/null) and `sourceFreshnessInvalid` are captured, never reconstructed as not-applicable from a null timestamp. Mode-less v1 bound input is unavailable to current capture health until new full-cohort reserve and redemption runs; no immutable backfill or old-envelope reinterpretation is allowed.

When timestamp-less composition carries independently admitted same-run on-chain redemption capacity, the consumed binding additionally seals `redemptionCapacityEvidence: { sourceTimestamp, blockNumber, outputAssetKeys }`. The producer emits it only after the existing exact-route capacity, status, eligibility, warning and identity gates pass. Capture checks the immutable row/census match, original fetch/config identity, original on-chain timestamp and configured output keys; the source age remains capped by the tighter adapter/coin allowance and 48-hour same-run ceiling. The composition's original unverified freshness stays unchanged and grants no Backing credit. Old composition-only bindings remain quarantined until a newly produced redemption run; no evidence is backfilled into historical rows.

Before building rows, the strict stablecoins cache must have a positive safe-integer generation timestamp no later than the run clock and age within `STABLECOINS_GENERATION_CONSUMER_MAX_AGE_SEC` (twice the producer interval, currently 1,800 seconds). This producer-to-producer admission window is distinct from the 600-second public endpoint advisory and pinned executable-state freshness budgets. Failure returns `stablecoins-cache:invalid-supply-generation` and holds prior output. Run metadata records `stablecoinsInput: { updatedAt, assessedAt, maxAgeSec }`, the actual source timestamp and assessment clock, independently of depeg's evidence budget. Metadata also binds reserve generation/digest, `runClockSec` and the consumed-input census to immutable rows. A missing per-asset supply bucket remains null, not global cache failure or observed zero.

Status semantics:

- `ok` when routes publish without blocking failures and the reused DEX diagnostic input is fresh. Diagnostic `missing-capacity`, market-impaired and `missing-cache` rows do not by themselves degrade the cron. The capacity tolerance budget (`max(1, ceil(runtime-configured * 1%))` over active configured routes excluding capability-structural ones) grades **runtime** missing capacity only. Structural rows are missing-capacity by construction and never count toward the floor, classified without stablecoin-ID special cases from published row facts plus config/registry capability: authored `unquantified` models (`unquantified-model` provider), `capacityUse: "diagnostic-only"` observer lanes, reserve-sync routes whose adapter declares no (or params-gated and unconfigured) route-capacity telemetry, and the deterministic evidence-model rejection reasons `settlement-bound-unproven`, `all-in-cost-unobserved`, `route-output-identity-unobserved` and `unsupported-capacity-kind`. Everything a capable source could have emitted this run (degraded/stale/missing snapshot, malformed or stale/future telemetry, failed observer reads, freshness evidence missing) stays runtime. The census stays fully published (`unresolvedMissingCapacity` total, `structuralMissingCapacity` plus `structuralMissingCapacityBy`, and the per-family/per-provider breakdowns). A breach is recorded as `metadata.quality.reason = capacity-coverage-floor`; it does not change successful publication into an operational failure. The same published generation surfaces as the `/status` `redemption_capacity_coverage_floor` data-quality cause, so failed placeholder rows cannot hide behind a renewed endpoint freshness clock. The DEX score remains backward-compatible context only; it never computes a combined exit score.
- `degraded` when at least one row is written but an active configured route fails or hits a non-`missing-capacity`/non-`impaired`/non-`missing-cache` unresolved state, the reused DEX liquidity snapshot is stale, future-dated or missing, the runtime cache has no active configured route at all, a DEX-liquidity preload step failed, or the D1 write/retention step returned warnings
- `error` when no row reaches `resolutionState: "resolved"` and route failures, blocking unresolved states, all active configured routes missing capacity, or an empty active configured cohort prevent resolution; an eventual-only resolved row need not have a numeric headline score

Cron metadata includes `synced`, `resolved`, `unresolved`, `unresolvedMissingCapacity` (total, including structural rows), `structuralMissingCapacity` with its `structuralMissingCapacityBy` kind breakdown when nonzero (`unquantified-model`, `diagnostic-only-observer`, `adapter-without-capacity-telemetry`, or a structural rejection reason; `unresolvedMissingCapacity - structuralMissingCapacity` is the runtime count the threshold grades), plus per-family/per-provider `familyMissingCapacityBy` / `providerMissingCapacityBy` breakdowns when any capacity is missing, so a single failing adapter family cannot hide inside the aggregate tolerance), `unresolvedCritical`, `availabilityDegraded`, `marketImpliedDegraded`, `marketEvidenceUncertain`, `missingCapacityOkThreshold`, `coverageRatio`, `failed`, `configured`, `activeConfigured`, `cacheAbsentConfigured`, `dynamic`, `estimated`, `static`, `liquidityStale`, `severeActiveDepegThresholdBps`, registry/run manifest fields (`registryHash`, `familyCounts`, `strongProxyCount`, `heuristicCount`, `validatorVersion`, `configMethodologyVersion`, `v4ScoringParametersHash`), and route-status producer fields (`routeStatusProducer`, `routeStatusProducerFetches`), plus capped matching ID lists or `missingFromCache` when relevant. Intentional confirmed impairment and current-evidence uncertainty do not by themselves degrade the cron run.

The producer label includes executable observers as well as reused reserve adapters and static policy. `routeStatusProducerFetches` is derived from actual direct-observer attempts, not configured capability. `directObserverAttemptedCount` counts routes whose direct observer was invoked, including unavailable reads; `directObserverConsumedCount` counts admitted rows that actually selected its live route status. `directObserverUnavailableCount` counts attempted routes whose status was not consumed, including failed, output-rejected, overridden, or schema-quarantined evidence. Static-only runs report false and zero counts. These diagnostics do not change scheduler connection accounting or claim that reused reserve evidence was fetched again.

Route exceptions also persist `sourceFailureReasons`, keyed by stablecoin ID, in both the immutable run manifest and cron metadata. Each entry contains a machine-readable `code` and a sanitized error `message` (at most 240 characters); the first 25 failed routes in configured order are retained, with `sourceFailureReasonsTruncated` marking any remainder. Executable identity checks preserve `code-unavailable`, `implementation-unavailable`, `code-drift`, or `implementation-drift`: unavailable reads are not observed mismatches. Their messages name the checked address, identity kind and exact observation block, without provider response text. Other exceptions use `route-resolution-failed`. Every identity rejection remains fail-closed with unknown route status and unavailable capacity; proxy bytecode, implementation storage/code and route state retain the same concrete block and caller-supplied RPC routing options, never re-pinning or changing expected identities to clear a failure. This compaction-protected metadata key preserves the actual observer/decode failure instead of only a `sync-error` placeholder or an array count. Full stacks remain in Worker logs; URLs, credentials and SQL are removed from persisted messages.

`registryHash` is a diagnostic digest of complete configs in canonical ID order; authoring order cannot rotate it. It is not a cache key, snapshot generation ID or Safety Score capture/publication fingerprint.

`coverageRatio` is `activeResolved / activeConfigured` over cache-present configured IDs (zero when that cohort is empty); `resolved` still counts all resolved rows. Cache-absent rows with measured absolute capacity remain published but cannot inflate active-cache coverage.

---

## Route Modeling

### Config Registry

Each configured coin declares:

- `routeFamily`
- `accessModel`
- `settlementModel`
- `executionModel`
- `outputAssetType` (`nav` displays as "NAV-priced output"; NAV-priced off-chain issuer routes can pay fiat cash, so this classification does not itself mean non-cash payout)
- `capacityModel`
- `costModel`
- optional `costModel.feeDescription`
- optional `holderEligibility`
- optional `routeStatus` (`open`, `unknown`, or reviewed `suspended`)
- required `routeSuspension` when suspended: exact `routeId`, named `channel`, `suspendedAt`, reason, `reviewer`, `reviewedAt`, and primary-source URL/quote pairs
- optional `routeExitCorrelation`
- optional `totalScoreCap`
- optional `outputAssets`
- optional `unresolvedOutputAssetKeys` and `unresolvedOutputDisposition`
- optional `docs` and `reviewedAt`
- optional `notes`
- optional reviewed overlays `v9RouteCostTerms`, `v9RouteReviewTerms`, and `v9ComposedDexExit`. A `v9RouteReviewTerms.settlementModel` is the canonical reviewed settlement fact for both the standalone producer and V9: conservative corrections remain admissible, while a favorable correction requires its cited review to remain inside the 365-day evidence window. The remaining V9 projections stay consumer-specific.

Scalar `v9RouteReviewTerms.settlementDelaySec` is admitted only with dated, current source support explicitly including `settlement` for the **completed configured endpoint**, with chronology and payout-identity gates for favorable corrections. A route-only citation, processing target, cooldown or claim-eligibility minimum does not prove final receipt. Scalar and business-day representations are mutually exclusive; only unconditional binding calendar terms with admitted cutoff/timezone/coverage can yield a completion ceiling. Rejected scalar/calendar reviews cannot revive a persisted generated SLA. A route whose own review withholds `settlement` and would otherwise inherit the `issuerBase` same-day default publishes the conservative `days` lane instead.

`scoringDisposition: "bounded-terms-gap"` plus `missingScoringFields` retains the asset's primary capacity/cost/settlement review across every redemption-lane route ID, including noncanonical FPI controller, sfrxUSD cross-chain and `execution:<digest>` observations, even when captured numbers or known statuses exist. Canonical ID formatting is not an exemption. Only the separately reviewed `physical-to-usd:<asset-id>` rail with its own `physicalToUsd` trace opts out; a matching name alone cannot. Strictly newer admitted exact execution evidence for the same asset/rail/model/request can supersede the review. The explicit missing factors remain causal diagnostics, not proof of measured total-exit failure.

Config cloning uses native `structuredClone` on data-only configs at registry initialization, isolating the complete nested authored shape, including fee tiers, physical fees/stages/evidence, suspension sources, docs and calendar terms. Keep functions and other non-cloneable values out of configs. Each family authors one final row per ID with its source path; registry and family factories reject every duplicate before map conversion and enforce family ownership. Reviewed docs are finalized without replaying historical default overrides. Midas, Spiko, Ondo and Nest use the same collision-safe construction without new semantic defaults or evidence credit.

`RedemptionBackstopConfigSchema` owns scalar bounds; the registry audit renders each canonical issue as `schema-validation` with its field path, without a second scalar diagnostic. Contextual adapter/observer identity, numeric daily-limit prose, documentation-support ratchets, source-AST overwrite detection and manifest completeness remain separate checks. Unused-live-telemetry policy rows remain exported and audited; only consumed runtime policy kinds need private indexes.

The public registry import lives in `shared/lib/redemption-backstops.ts`. The actual config inventory is split by route family under `shared/lib/redemption-backstop-configs/` to keep review and change scopes small. The live producer cohort is the configured routes of active stablecoins; frozen, pre-launch, quarantined and delisted configs remain archive history and are excluded from the sync and live rows.

Family ownership follows the modeled holder endpoint, not issuer branding: opaque asynchronous burn/attest/release belongs to `queue-redeem`, and inventory-dependent on-chain swaps to `psm-swap`, including whitelisted cohorts. Preserve the reviewed access, execution, payout and gap facts when correcting family ownership; do not falsify them to satisfy a family constraint. Such corrections can change route diagnostics and require replay.

`outputAssets` records concrete holder-route outputs, not every reserve asset. Stable outputs use tracked stablecoin IDs; collateral outputs use canonical `asset:<symbol>` keys. Configured baskets are limited to 16 members, matching the `ExitRouteOutput.assetKeys` bound. Leave the field unset when the published route is incomplete or when its tracked and untracked members cannot all be represented: an incomplete subset must not turn an unresolved basket into a resolved one. When a complete reviewed route contains untracked assets, `unresolvedOutputAssetKeys` may preserve the exact identities for diagnostics; those keys do not resolve or score the output.

Explicit stable `outputAssets` take precedence over offchain issuers' legacy fiat default; payouts are not input NAV or reserve holdings. Physical delivery and unresolved commodity collateral retain precedence. The output schema requires currency for fiat, and commodity identity plus `sameNotionalEligible: false` for physical delivery; it rejects fiat/tracked fields on physical outputs and requires source-timed USD evidence for any valuation. Issuer rails never infer payouts from `variantOf`; the legacy fiat projection is not evidence of bank settlement.

Some issuer routes pay a tracked stablecoin rather than fiat; the family configs own each exact reviewed payout endpoint. A separately mediated market swap is not a direct bridge-redemption output, and a wrapper unwrap is not a partner fiat ramp. Every route retains its reviewed access, cost, capacity and settlement constraints.

Config modules own per-asset payout evidence and gaps. A single tracked payout scores output quality **100** at par only with captured valuation; a multi-output route retains conservative `stable-basket` quality **80** and weakest-price semantics, not invented equal weights or holder-choice branches. Known physical delivery remains non-comparable unless its separately reviewed metal-sale path is admitted.

A holder route must bind the exact tracked asset and deployment, not a same-symbol token, legacy/replacement mint or unrelated wrapper. Administrative burns, borrower repayment, reserve management and secondary-market cash-out do not by themselves establish holder redemption.

For example, [PYUSDx terms](https://www.moonpay.com/legal/pyusdx_terms) give onboarded eligible counterparties PYUSD, not a universal fiat claim; [Ondo's guide](https://docs.ondo.finance/ondo-stocks/investing-and-redeeming.md) separates instant USDon from inventory-conditioned USDC. Full-supply issuer/fund entitlements are eventual-only unless a funded buffer is independently established. Bank rights, subscription minima, NAV, daily thresholds and gate percentages supply neither current capacity nor completed receipt.

Opaque composite/migration paths cannot be relabeled deterministic `stablecoin-redeem`/`psm-swap` merely to register documentary access. Solomon replacement USDv, Initia iUSD and legacy ICON bnUSD retain sourced unconfigured dispositions; known balances, 1:1 displays and institutional issuer terms do not establish exact end-to-end payout/execution. A configured institutional route likewise does not admit an unrelated native/wrapper rail.

### Docs / Notes

- `docs` prefers explicit config-reviewed sources first (`docs[]` + `reviewedAt`), then live-reserve display links for reserve-sync routes, then the coin metadata's `proofOfReserves.url`, then preferred public links (`Docs`, `Proof of Reserve`, `Transparency`, `Website`)
- `docs.provenance` distinguishes reviewed route docs from fallback live-reserve, proof-of-reserves, or generic project-link sources so detail pages do not overstate evidence quality
- `docs.reviewedAt` is the route-review date, not a claim that the rendered fallback link itself was the reviewed source; the detail card now shows review date and provenance together
- `docs.sources[]` records structured provenance for what the linked source supports (`route`, `capacity`, `fees`, `access`, `settlement`)
- The registry check ratchets aggregate source-support coverage and emits per-config warnings when a `documented-bound` capacity route lacks explicit `route` or `capacity` support. These warnings are backlog controls, not hard CI errors, until the remaining documented-bound source-support gaps are cleaned up.
- Audited source-role corrections may update the ratchet only with exact asset/source attribution; backing or another token's terms must never be tagged as executable-capacity evidence merely to preserve a count.
- `feeDescription` carries docs-backed fee text when the route fee is fixed, conditional, dynamic, flat-fee-based, or publicly undisclosed
- `notes` merges config notes plus runtime notes such as stale reserve metadata expiry, conservative fallback use, or live fee fallback
- `capsApplied` records any score caps triggered during scoring

### Cost Modeling

- `feeBps` is still used only when the route has a bounded fixed basis-point fee that can be represented cleanly in the score model
- Explicit issuer statements that redemption charges no fee are modeled as a fixed `0` bps schedule rather than as an opaque or variable fee. This applies to the reviewed Spiko funds, Midas mF-ONE, JTRSY, YLDS, EUROP, EUSD, and USD3 routes; the registry validates the complete reviewed ID tables so additions and removals cannot silently drift.
- An owner-settable on-chain fee that read zero at review is a `formula` cost with no fixed bound, so a current read owns the fee (USSD and USDso BrandedCustodian `redeemFee()`).
- HBD conversion has no extra conversion fee, but the debt-ratio haircut and 3.5-day median-price window leave all-in USD payout cost unquantified. Its reviewed formula disposition therefore carries no numeric zero-cost bound until current payout valuation accounts for those effects.
- Formula-based routes can also populate `feeBps` from fresh latest-success live reserve snapshot metadata when the protocol exposes a current on-chain redemption rate; the route still remains labeled as `feeModelKind = formula`
- Admitted live fees retain fractional basis points in publication, scenario costs and exact threshold comparisons; rounding belongs only to presentation, never fee statistics.
- Every on-chain rate probe must explicitly pin the return-value decimal scale; missing scale fails configuration validation rather than silently publishing an unknown fee
- Reviewed fixed-fee routes may also consume fresh authoritative live fee telemetry when the protocol exposes the current active redemption fee and the static config is only a safe fallback bound
- `feeModelKind` distinguishes fixed-fee routes from documented formulas, documented variable schedules, and reviewed-but-undisclosed fee rails
- `feeDescription` is used to surface:
  - dynamic formulas such as Liquity-style `min 50 bps + baseRate`
  - conditional fee schedules such as borrower-vs-non-borrower redemptions
  - flat minimums or bank/network charges that do not map cleanly to one global bps number
  - cases where public docs were reviewed but no numeric redemption-fee schedule is published
- If live formula telemetry is missing, the route falls back to the reviewed-formula bucket rather than pretending a fixed fee is known
- `costScore` uses the active-user scenario by default when v4 fee-shape inputs are present; optional `costScenarioScores` exposes retail, active-user, and institutional route-size scores

`resolveRedemptionCostBpsAtNotional` requires an observed exact fee quote, real authored maximum or fixed percentage basis. For notional N it uses `10_000 × (max(N × bps / 10_000, minFeeUsd) + gasOrBridgeCostUsd) / N`; `minFeeUsd` is a minimum charge, **not** additive flat cost, and a fee floor alone never establishes a complete ceiling. Above-budget costs retain the exact trace but do not establish raw zero inventory.

Issuer/fund fee zero is scoped, never an all-in promise or universal holder entitlement. Different bank/network/partner deductions, investor cohorts, original-currency quota accounting and instant-versus-queued branches retain separate terms. “No spread”, an observed variable fee, a cooldown or claim availability cannot substitute for complete cost and final-receipt bounds.

Private tariffs, holder-specific quotes, conditional bank receipt, calendar gates and unfunded queue completion remain explicit reviewed gaps. Never guess elapsed seconds from a conditional following-month-end promise or renew evidence after failed retrieval. Closing a fee field does not clear the independent DEX portfolio-coverage obligation.

---

## Provider / Source Definitions

Provider identifiers, default source mode, default confidence and default semantics are owned by `REDEMPTION_BACKSTOP_PROVIDER_DEFINITIONS` in `shared/lib/redemption-backstop-providers.ts`; do not copy them here. The durable severe-depeg rule is: only `reserve-sync-metadata` with a strong live-direct route, or `executable-observer` with separately admitted strong live-direct evidence, can survive the severe active-depeg gate; every other provider is not scoreable.

| Provider | Capacity source | Severe-depeg scoreability |
| --- | --- | --- |
| `supply-full-model` | Full supply model | Not scoreable |
| `supply-ratio-model` | Configured supply ratio | Not scoreable |
| `fixed-usd-model` | Fixed reviewed USD buffer | Not scoreable |
| `unquantified-model` | No quantified capacity | Not scoreable |
| `reserve-sync-metadata` | Live reserve metadata | Requires strong live-direct route |
| `reserve-sync-fallback` | Reviewed fallback ratio | Not scoreable |
| `executable-observer` | Direct executable reader | Requires separately admitted strong live-direct evidence |
| `sync-error` | Failure sentinel | Not scoreable |

`reserve-sync-metadata` readback can refine confidence to `live-direct` or `live-proxy` when the configured adapter declares direct or proxy redemption-capacity telemetry. Proxy and queue telemetry can provide context or lower-bound capacity, but they cannot qualify as severe active-depeg live-direct evidence.

Each row also carries:

- `resolutionState`:
  - `resolved` when a numeric standalone score is available or admitted eventual capacity yields a numeric `eventualRedeemabilityScore`; the latter can have null aggregate `score`. Missing executable evidence cannot bypass materiality, and every non-resolved state has null aggregate `score`
  - `missing-cache` when the stablecoins snapshot did not contain the asset or its current supply
  - `missing-capacity` when the route is configured but current runtime inputs could not produce usable capacity
  - `failed` when a route-specific resolver failed
  - `impaired` when the route shape is known but current market or route-availability evidence either contradicts broad par redemption or cannot establish whether an open downside incident is still severe; impaired rows have `score = null` and `modelConfidence = low`
- `routeStatus`:
  - `open` for normal resolved routes without current impairment evidence
  - `degraded` when fresh authoritative current evidence confirms severe market-implied impairment
  - `unknown` with `routeStatusSource: market-implied` when an open downside incident lacks current authoritative evidence; this withholds the score rather than restoring the static route claim
  - `paused`, `cohort-limited`, and other `unknown` combinations remain available to explicit route-availability sources and backward-compatible legacy rows
  - whitelist or approved-holder gates should normally be modeled through `accessModel` / `holderEligibility`; use `cohort-limited` only when current route evidence shows impairment beyond that reviewed eligible cohort
  - unknown route status remains a low-confidence signal unless the capacity evidence is direct live telemetry or a source-reviewed documented bound
- `routeStatusSource`:
  - `static-config` for normal config-derived status
  - `market-implied` for both confirmed severe current-depeg impairment and unresolved current-evidence currency on an open downside incident
  - reviewed adapters may emit `protocol-api` or `onchain` only when the current run evaluated a route-specific executable predicate; capacity, balance, collateral, TVL, backing, or configuration evidence alone does not qualify
  - `operator-notice` is emitted for a capture-time-admitted, exact-channel authored `routeSuspension`; there is no independent operator-status feed
  - a reviewed suspension wins over live and market evidence; otherwise live adapter evidence wins over static config, with the market-implied overlay applied last unless a strong live-direct route is explicitly open. Output impairment or uncertainty cannot use that exception
- `holderEligibility`:
  - derived from the route access model by default: permissionless onchain routes are `any-holder`, whitelist routes are `whitelisted-primary`, issuer API routes are `verified-customer`, and manual routes are `issuer-discretionary`
- `capacityConfidence`:
  - `live-direct` for live reserve-sync capacity sourced from direct current redemption telemetry
  - `live-proxy` for live reserve-sync capacity inferred from a live proxy liquidity bucket rather than a protocol-native redemption-limit feed
  - `dynamic` only as a legacy / unresolved reserve-sync bucket when older stored rows lack the richer live-capacity classification
  - `documented-bound` when a bounded model is explicitly configured that way after source review, including reviewed full-supply redeemability where official issuer or protocol terms establish eventual redemption of outstanding supply
  - `heuristic` by default for `supply-full`, `supply-ratio`, and inferred legacy rows without stronger evidence
- Reserve-sync capacity now ignores degraded snapshots, weak fee-only adapters, and snapshots that do not carry scoring-grade freshness evidence by default. The only exceptions are route-specific lower-bound warning classes that explicitly preserve a trustworthy redeemable-capacity floor while keeping reserve sync itself degraded for completeness review.
- Immutable fully on-chain systems and reviewed direct issuer / direct redeem routes can use `documented-bound` with `eventual-only` semantics when protocol mechanics or issuer terms establish full-system redeemability directly, even if no separate immediate buffer is measured
- `capacitySemantics`:
  - `immediate-bounded` when the model is intended to represent a current redeemable buffer
  - `eventual-only` when the route is scored as eventual redeemability rather than immediate same-size liquidity. Current V9 applies the unified Exit route ladder: reliable reviewed non-atomic issuer/protocol/eventual routes require output, evidence, failure-domain, and capacity gates and receive the applicable delay/confidence discounts. The DEX-gated primary-market bonus was historical V7.05 behavior, not a current scoring path.
- `capacityBasis` (orthogonal to `capacityConfidence`: basis describes the model shape, confidence the evidence strength — consumers must read both; a `psm-balance-share` basis can be live-measured or a heuristic guess):
  - typed evidence basis such as `issuer-term-redemption`, `full-system-eventual`, `psm-balance-share`, `strategy-buffer`, `hot-buffer`, `daily-limit`, `fixed-buffer`, `live-direct-telemetry`, or `live-proxy-buffer`
  - `fixed-buffer` identifies a reviewed fixed USD buffer (`capacityModel.kind === "fixed-usd"`), distinct from live-direct or live-proxy telemetry
  - reserve-sync fallback ratios use the configured `basis` when present, otherwise route-family defaults such as `psm-balance-share`, `strategy-buffer`, or `hot-buffer`; they are not labeled `live-proxy-buffer` unless live proxy telemetry produced the capacity
- Live reserve telemetry fields are additive display/provenance context, not Safety Score eligibility by themselves:
  - `capacityKind` describes the adapter-declared evidence shape, such as `live-direct-bounded`, `live-queue`, `live-proxy-validated`, `documented-bound`, `documented-eventual`, or `heuristic`
  - `freshnessKind` describes the adapter-declared redemption freshness evidence, such as `verified-source-timestamp`, `same-run-onchain`, `same-run-api`, `reviewed-static`, or `unverified`
  - `sourceTimestamp`, `sourceUrls`, `settlementDelaySec`, `queueDepthUsd`, `dailyLimitUsd`, `minRedeemUsd`, and `liveHolderEligibility` are carried through the API/UI when emitted by live reserve adapters
  - `settlementDelaySec` is raw nonnegative telemetry: a measured `0` is an atomic route, not a missing value. The projected exit-route observation window (`settlementHorizonSec`) is a separate strictly positive integer, so a live positive integer delay becomes the horizon and a zero or absent delay takes the reviewed `settlementModel` ceiling instead of publishing an invalid zero-second horizon.
- `feeConfidence`:
  - `fixed` for bounded bps schedules
  - `formula` for disclosed formulas such as Liquity-style base-rate fees
  - `undisclosed-reviewed` when docs were reviewed but only descriptive fee information is available. It asserts that no bounded number is published — never that the fee is zero
- `feeModelKind`:
  - `fixed-bps`, `formula`, `documented-variable`, or `undisclosed-reviewed`
- `modelConfidence`:
  - `high`, `medium`, or `low` rollups used by the API and detail page to communicate fidelity
  - `low` for heuristic-capacity routes, unresolved rows, impaired rows, unclear holder eligibility, stale docs without current route-status evidence, or unknown route status without direct live telemetry or source-reviewed documented-bound capacity
  - `confidenceDetails` can expose the component evidence scores and rollup reasons
  - the route-status freshness component reaches 100 only for `open` current `onchain` / `protocol-api` evidence with positive executable capacity; an open route with zero or missing capacity is capped at 70
- `routeExitCorrelation`:
  - `independent-issuer-rail`, `same-stablecoin-pool-backing`, `same-protocol-liquidity`, `wrapper-to-parent-dependency`, or `unknown`
  - retained as legacy diagnostic/display metadata; it has no current scoring effect
  - V9 Exit derives route independence from disjoint failure domains and physical-resource keys instead of this tag

**Documented zero versus undisclosed fees.** A quoted zero issuer charge is fixed `0` bps, not undisclosed-reviewed; numeric restatement remains per-entry source curation. Descriptive/formula fees without a genuine maximum remain unquantified. Neither a fee label nor a historic cohort count grants model confidence, all-in proceeds or positive same-notional credit.

## Database Schema

Schema: `worker/migrations/0000_baseline.sql` owns all redemption tables in the current post-squash tree. The former `0094` completed-run manifest and `0120` manifest-scoped row-store migrations are absorbed into that baseline; historical lineage is recorded in `worker/migrations/MANIFEST.md`.

### `redemption_backstop`

Retired mutable current-mirror table, frozen pending cleanup. Active current snapshots are read from immutable `redemption_backstop_run_rows`, keyed by `(snapshot_run_id, stablecoin_id)` and selected through completed `redemption_backstop_runs` manifests.

Key columns:

- `stablecoin_id` — PK
- `score`
- `effective_exit_score`
- `dex_liquidity_score`
- `access_score`
- `settlement_score`
- `execution_certainty_score`
- `capacity_score`
- `output_asset_quality_score`
- `cost_score`
- `route_family`
- `access_model`
- `settlement_model`
- `execution_model`
- `output_asset_type`
- `provider`
- `source_mode`
- `immediate_capacity_usd`
- `immediate_capacity_ratio`
- `fee_bps`
- `queue_enabled`
- `updated_at`
- `methodology_version`
- `details_json`
- `snapshot_run_id`

`details_json` now also stores `routeFamily`, provider/source provenance, immediate-capacity fields, optional live telemetry fields, fee fields, `resolutionState`, `routeStatus`, `routeStatusSource`, `routeStatusReason`, `routeStatusReviewedAt`, `holderEligibility`, `capacityConfidence`, `capacityBasis`, `capacitySemantics`, `feeConfidence`, `feeModelKind`, `modelConfidence`, and `feeDescription` alongside `docs`, `notes`, and free-form `capsApplied` markers such as `market-implied-depeg-evidence-uncertain`. The v4.42 uncertainty state therefore uses existing JSON fields and requires no typed column or D1 migration.

`snapshot_run_id` links immutable `redemption_backstop_run_rows` to a completed `redemption_backstop_runs` manifest. API and report-card readers prefer the latest valid completed run. If the newest completed manifest is incomplete or its rows are unreadable, readers try recent earlier completed runs before returning `503`.


`parseDetails` in `worker/src/lib/redemption-backstops-store.ts` requires a successfully decoded object with explicit valid `resolutionState`. Missing details, malformed JSON, null/scalars/arrays, missing current core status/confidence/eligibility fields or invalid `reserveInput` reject the row and its complete run. A scalar score cannot reconstruct resolved state. Historical versions below v4 may salvage only independently valid diagnostic docs/notes/caps/confidence/scenario fields; salvage never fabricates state or provenance. Earlier-run fallback is atomic, retaining its run ID, clock, methodology and metadata, not mixing good rows from a rejected generation.

Bulk, per-coin and depeg-resolver live-signal readers share one completed-run admission boundary. It validates the full immutable row census, unique identities, details and entries in bounded pages before selecting a generation; a malformed unrequested sibling rejects that run even when the requested coin is absent. Narrow readers discard unrelated decoded graphs and then query only their selected-row or four-column signal projection under the admitted run ID, without constructing or serializing the full feed or keeping an isolate object cache.

Each dropped row logs `redemption-backstop-row-rejected` with run ID, stablecoin ID, stored methodology version and a named reason: `missing-details`, `json-parse-failed`, `invalid-payload`, `unrecognized-methodology-version`, or `invalid-entry`. Rejected-run diagnostics retain the per-row codes. Only positively identified numeric versions greater than zero and below four use historical decoding; an unrecognized version must satisfy current detail requirements and is not rejected solely for its version text.

### `redemption_backstop_history`

Daily history table keyed by `(stablecoin_id, snapshot_date)`. No runtime reader consumes it today; rows are retained for 90 days for future track-record use and pruned in bounded batches by the same retention pass that prunes run manifests.

Stored fields:

- `score`
- `effective_exit_score`
- `dex_liquidity_score`
- `updated_at`
- `methodology_version`
- `details_json`
- `snapshot_run_id`

The cron writes immutable `redemption_backstop_run_rows` first and validates the row count and bounds. One D1 batch then copies that run's rows into daily history with a run-scoped `INSERT ... SELECT` and completes its manifest. Both statements require the manifest to remain `running`; completion is confirmed from the affected-row count. A history or completion failure rolls back both statements, preserving the prior daily closes and keeping the rejected run unreadable. Failed-run accounting cannot downgrade a completed manifest. The legacy current-mirror refresh is retired: readers (including the depeg-resolver context, which uses a narrow store reader over the latest valid completed run) consume immutable run rows exclusively.

### `redemption_backstop_runs`

Completed-run manifest table used to prevent mixed-generation current snapshots from being treated as fresh.

Stored fields:

- `run_id` — unique generated run identifier
- `started_at`
- `completed_at`
- `status` (`running`, `completed`, or `failed`)
- `expected_count`
- `written_count`
- `methodology_version`
- `min_updated_at`
- `max_updated_at`
- `metadata_json`

The sync inserts a `running` row before writing immutable run rows, marks the manifest `completed` only after the immutable row count and update bounds are valid, and then writes the day's history. If immutable row, completion, or history writes fail after the manifest is started, the writer best-effort removes the run's history rows and marks the manifest `failed` with phase-specific failure metadata before rethrowing. Readers prefer the latest valid completed run, use its `max_updated_at` for response freshness, and use its `methodology_version` for API methodology attribution.

Run manifests and immutable run rows are pruned after successful writes with a 14-day retention window. The prune keeps the just-written run and the latest completed run even when either is older than the cutoff, so current API reads stay intact. Retention failures are recorded as completed-run warnings instead of failing the already-written snapshot.

The orphan run-row pass (rows whose manifest no longer exists) derives its candidate run ids from a covering-index `DISTINCT snapshot_run_id` scan and is bounded per distinct orphan run, instead of walking the whole run-row table with a correlated manifest probe per row. An empty pass therefore stays a cheap index scan rather than a ~28k-row table walk on every retention run.

---

