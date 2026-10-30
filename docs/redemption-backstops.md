# Redemption Backstops

Modeled redemption-route coverage for tracked stablecoins. This subsystem estimates how credibly a holder can exit to par or near-par outside secondary-market DEX liquidity, then exposes that estimate through a standalone snapshot API. Since redemption `v4.3` the legacy `effectiveExitScore` blend is retired: same-notional exit is published by the Safety Score V9 Exit pillar alone, which composes the same route-scoring primitives from `shared/lib/exit-route-scoring.ts`.

> **Agent navigation** — Grep headings: Coverage · Cron Schedule · Scoring Model · Captured local-fiat costs · Physical-to-USD Exit · Exact-request execution certificates · Config Registry · Reviewed channel suspension · Output-key identity contract · Capacity Models · Provider / Source Definitions · Database Schema · API Endpoint · Frontend Consumers. Current configs own the inventory; structured methodology changelogs own release history.

---

## Methodology Versioning

- **Current methodology version:** <!-- GENERATED-START: methodology-version-redemption-backstop -->`v4.52`<!-- GENERATED-END: methodology-version-redemption-backstop -->
- **Public methodology anchor:** `/methodology/#redemption-backstop-methodology`
- **Canonical source files:** `shared/lib/redemption-backstops.ts`, `shared/lib/redemption-backstop-configs/*`, `shared/lib/exit-route-scoring.ts`, `shared/lib/redemption-backstop-scoring.ts`, `shared/lib/methodology-versions/registry.ts`
- **Structured changelog:** `shared/data/methodology-changelogs/redemption-backstop/`

The `v4.51` release keeps cohort restrictions bound to the exact output path; only a source-owned pause survives a rejected payout identity. MetaMorpho V1 donations cannot floor or replace validated API capacity, and Liquity v1 gross ActivePool debt cannot establish executable eligible-Trove debt. GBPA and MXNT explicitly retain unquantified capacity. FILQ and Sygnum FIUSD distinguish cash output from NAV input pricing; strUSD separates permissionless on-chain submission from issuer-discretionary eligibility. The NAV label correction alone is presentation-only. Weights, ladders and freshness budgets are unchanged.

Activation is provisionally **2026-10-16 00:00 UTC (`1792108800`)**, to be re-dated at release. The changed route-score inputs follow the `v4.5` precedent for withdrawn unsupported assumptions; a route-level fixed-clock comparison and fresh producer-dependent observations remain separate release requirements. No comparison result or production acceptance is claimed. Safety's existing exact-request execution and evidence policy is unchanged, so this release does not itself advance the Safety Score methodology.

Earlier release history lives in `shared/data/methodology-changelogs/redemption-backstop/`; keep this document focused on the current contract.

The standalone history is published at `/methodology/redemption-backstop-changelog/`. The current methodology section distinguishes this route diagnostic from V9 Exit, which re-evaluates exact same-notional route evidence under the V9 policy.

The independent DEX alternative in Safety Exit uses [source-fresh measured history](https://github.com/TokenBrice/pharos-watch/blob/main/docs/process/dex-liquidity-appendix.md#curve-capture-and-measured-profiles), not a new redemption capacity observation. Expiring a DEX history constituent neither refreshes issuer/protocol evidence nor proves that the redemption route failed or has zero capacity.

That DEX alternative also requires hash-bound source provenance and executed-outcome proof. A number-only quote or unavailable CryptoSwap kill probe establishes neither executable depth nor redemption failure; issuer/protocol routes retain their own admission and clocks. The measured-profile cutover does not create a new redemption observation or alter its formula.

Measured DEX alternatives cannot use stale or future non-USD peg-reference fallback as current USD capacity. Their [FX target-admission gate](https://github.com/TokenBrice/pharos-watch/blob/main/docs/process/dex-liquidity-appendix.md#measured-evm-joining) leaves issuer/protocol payout valuation and standalone redemption formulas unchanged; unavailable DEX valuation establishes no redemption failure or zero.

Selected-payout impairment belongs to the redemption methodology: reviewed output identity takes priority over backing composition, and unknown basket payout shares remain unquantified. Identity corrections do not authorize a new fiat rail or promote eventual issuer rights into funded token capacity.

---

## Coverage

Configured coverage is defined statically behind the thin facade in `shared/lib/redemption-backstops.ts`, with route-family modules under `shared/lib/redemption-backstop-configs/`.

- **Configured coins and family counts:** derived from `REDEMPTION_BACKSTOP_CONFIGS`; do not copy the changing roster or totals into this document
- **Route families:** `offchain-issuer`, `stablecoin-redeem`, `collateral-redeem`, `queue-redeem`, `psm-swap`, and `basket-redeem`
- **No discovery layer:** only coins present in `REDEMPTION_BACKSTOP_CONFIGS` are modeled

The config registry is validated at module load time against `WORKER_TRACKED_META_BY_ID`, so unknown IDs fail fast during build/test/runtime startup without loading the full evidence-heavy stablecoin catalog. The shared config identity/docs helpers, Worker entry builder, availability checks, live metadata, capacity profiles, and route observations read `shared/lib/stablecoins/worker-runtime-registry.ts`. Its lossless slices preserve parent/peg-reference identity, dependency ID/weight and reserve coin-ID/percentage pairs, protocol identity, deployments, and the public documentation links consumed by these helpers; public/Pages documentation behavior is unchanged.

Coverage is route-specific, not a second inventory of reserve holdings. Family configs own each asset's concrete payout, access, capacity model, terms, sources and outstanding gaps; `shared/data/coverage-dispositions/redemption-coverage-dispositions.ts` owns reviewed unconfigured assets. Known rights or outputs do not establish funded same-notional execution.

- **Rights versus capacity:** a legal/full-position entitlement, reserve dashboard, AUM, current debt or daily customer limit is not an executable buffer. `unquantified` means unavailable amounts, not observed zero. USDFC and Mezo retain fee/status diagnostics without promoting gross ActivePool debt into eligible-Trove capacity.
- **Exact outputs:** typed `redemption.outputAssetKeys` must match the configured complete payout set. Missing, malformed, extra or different keys withhold capacity, live fees and favorable openness/eligibility/settlement (`route-output-identity-unobserved`). Static reviewed fees keep their independent contract. A shared input/facility pause or authored suspension survives rejection; a restriction on another payout cohort does not. Identity alone supplies neither price nor execution.
  A newly observed optional payout must remain in the complete `unresolvedOutputAssetKeys` census when its exact identity or USD valuation is not admitted. The config schema cannot combine resolved and unresolved output arrays. A producer may establish a separately selected and priced pool; curation must not value an incomplete choice set as a complete basket.
- **Vaults:** ordinary Morpho V1/V1.1 withdrawal sources market claims, not donated wallet assets, so validated API liquidity has no idle-cash floor. VaultV2 may retain independently fresh idle after a zero/unreadable selected adapter; missing idle is unavailable. Force-deallocation/in-kind positions are not additive cash. Zero `maxWithdraw`/`maxRedeem` conventions do not prove zero capacity. VaultV2's exact source distinguishes owner `sendShares`, receiver `receiveAssets`, deposit `sendAssets` and fee-recipient `receiveShares` gates; none waives execution proof.
- **Valuation:** generic non-USD ERC-4626 capacity is unavailable without same-path FX (`erc4626-capacity-non-usd-unvalued`). Exact EUR certificates independently bind fresh observed token USD prices and EUR/USD expected value to both source generations and the older clock; that does not promote unvalued reserve telemetry or assume EURCV/TRY parity.
- **Direct observers:** the registry in `worker/src/cron/reserve-adapters/executable-redemption-observers.ts` distinguishes measured from diagnostic-only lanes. Lido/Monetrix/Saturn queues do not become funded capacity from idle cash, queue counts or operator processing. USDfr's restricted controller and apyUSD's funded owner-claimable receipts require their exact guards and same-run output valuation; delayed funded receipts are eventual-only. Reserve-backed eEARN/sdUSD/sUSN keep their separate strategies rather than duplicate reads.
  The observer contracts and shared `readStateWithPlan` identity/read helper live below the registry in `worker/src/cron/reserve-adapters/executable-redemption-read-client.ts`; concrete observers import that module rather than their own registry.
- **Clocks:** observer state uses `EXECUTABLE_REDEMPTION_OBSERVATION_MAX_AGE_SEC` (600 seconds) and shared future skew. Captured valuation retains the stablecoins generation's original `updatedAt`, positive safe-integer generation and `STABLECOINS_GENERATION_CONSUMER_MAX_AGE_SEC` budget (1,800 seconds). Measured native amount, output valuation and all-in cost are independent predicates; `output-valuation-unobserved` and `all-in-cost-unobserved` remain distinct.
- **Queues and access:** cooldown minima, serviced-day bands, API averages and source-staleness budgets are not completion maxima or FIFO allocation. Protocol submission may be permissionless while legal eligibility is issuer-discretionary; it does not make a parent issuer rail permissionless. The configured payout and current holder/cohort must match before faster settlement can apply.
- **Fees and replay:** issuer/protocol zero covers only its stated component. Frozen request-point costs take precedence; an observation scalar applies only when both notional and cost budget match. Other points resolve their own bounded terms. Formula-provenance repair requires captured formula confidence. Curation needs a new producer/accepted publication, never backdated fees or synthetic capacity.
- **Calendars:** `v9RouteReviewTerms.businessDayTerms` retains jurisdiction, cutoff/timezone, binding-versus-target assurance, start event and unresolved/sequential gates. Safety walks the complete reviewed submission horizon, not a calendar-day guess or a rejected captured scalar. The coarse `days` label is **Multi-day**, never an implied seven-day maximum.

For example, [OUSD partner redemption](https://tempo.xyz/developers/docs/guide/ousd) is a verified-customer USD eventual entitlement: Bridge's processing promise is not completed bank receipt, and zero issuer fee is not zero bank/partner/network cost. Its [dashboard](https://reserves.bridge.xyz/ousd) and [transparency endpoint](https://transparency.bridge.xyz/v0/stablecoins/ousd) are self-reported; no immediate-capacity floor is inferred. The independently attested major-issuer hot-buffer precedent is a separate admission review, not automatic promotion of a displayed cash percentage.

Current configs retain the exact source-backed distinctions for Ondo USDon versus separately gated USDC, native XAUt versus physical/dollar delivery, native wrappers versus parent issuer routes, and funded claims versus requests. Consult their sources rather than treating a historical coverage list as current.

`npm run audit:coverage -- --domain=redemption-backstops --report <path>` emits each config's literal/resolved capacity basis, reviewed fallback source and daily limit. Registry parity uses `scripts/maintenance/audit-redemption-registry-parity.ts --snapshot <path>` and `--compare <before.json> <after.json>`; all authored fields survive, object/row order is irrelevant, array order remains meaningful, and no synthetic capacity/score projection is emitted.

---

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

Independent asset resolvers use the existing `mapWithConcurrency` worker pool with `REDEMPTION_BACKSTOP_RESOLVE_CONCURRENCY = 3` from `shared/lib/cron-jobs.ts`; that same constant owns the natural redemption and recovery connection reservations. Each observer retains its sequential, body-draining RPC/proof steps. The natural reserve slot is **4/6** (`max(reserves 2, redemption 3, sentinel 1) + Kinesis 1`); five-minute recovery is **3/6**, with its phases and Kinesis serialized. The resolver pool changes neither freshness/admission nor the 300-second child timeout.

Results and failed-row placeholders are collected by input index and published in configured order only after every resolver settles; one asset failure remains isolated. Cancellation stops admission of new assets, drains already-started resolvers and prevents partial publication. Resolution progress counts completed resolvers (including failed rows), coalesced after ten completions or fifteen seconds and on completion, with serialized reporting to prevent stale progress overwrites.

Final row and selected-detail schema admission happens inside each asset's failure boundary, then again after the output-dependency join. A malformed member becomes an explicit failed placeholder with unavailable capacity; `sourceFailureReasons[id]` records `redemption-snapshot-schema-invalid`, `schemaPath`, and the schema's machine-readable `schemaReason`. If a post-join member fails, disclosures are rebuilt against that placeholder and revalidated before opening the immutable manifest. Healthy rows and placeholders retain the complete configured census; storage validation remains defense in depth. Global reserve/stablecoins admission holds and cancellation before publication still write no snapshot rows.

Only selected capacity, fee, route-status/output or specialized-route evidence carries `reserveInput` in immutable `details_json`: generation/digest, asset, successful attempt, configuration fingerprint and the consumed `ReserveFreshnessView`. Direct RPC, unused and purely static evidence remain unbound. Accepted reserve envelopes and consumed manifests use schema v2: original `freshnessMode` (including absent/null) and `sourceFreshnessInvalid` are captured, never reconstructed as not-applicable from a null timestamp. Mode-less v1 bound input is unavailable to current capture health until new full-cohort reserve and redemption runs; no immutable backfill or old-envelope reinterpretation is allowed.

When timestamp-less composition carries independently admitted same-run on-chain redemption capacity, the consumed binding additionally seals `redemptionCapacityEvidence: { sourceTimestamp, blockNumber, outputAssetKeys }`. The producer emits it only after the existing exact-route capacity, status, eligibility, warning and identity gates pass. Capture checks the immutable row/census match, original fetch/config identity, original on-chain timestamp and configured output keys; the source age remains capped by the tighter adapter/coin allowance and 48-hour same-run ceiling. The composition's original unverified freshness stays unchanged and grants no Backing credit. Old composition-only bindings remain quarantined until a newly produced redemption run; no evidence is backfilled into historical rows.

Before building rows, the strict stablecoins cache must have a positive safe-integer generation timestamp no later than the run clock and age within `STABLECOINS_GENERATION_CONSUMER_MAX_AGE_SEC` (twice the producer interval, currently 1,800 seconds). This producer-to-producer admission window is distinct from the 600-second public endpoint advisory and pinned executable-state freshness budgets. Failure returns `stablecoins-cache:invalid-supply-generation` and holds prior output. Run metadata records `stablecoinsInput: { updatedAt, assessedAt, maxAgeSec }`, the actual source timestamp and assessment clock, independently of depeg's evidence budget. Metadata also binds reserve generation/digest, `runClockSec` and the consumed-input census to immutable rows. A missing per-asset supply bucket remains null, not global cache failure or observed zero.

Status semantics:

- `ok` when routes publish without blocking failures and the reused DEX diagnostic input is fresh. Diagnostic `missing-capacity`, market-impaired and `missing-cache` rows do not by themselves degrade the cron. The capacity tolerance budget (`max(1, ceil(activeConfigured * 1%))`) is recorded as `metadata.quality.reason = capacity-coverage-floor` when exceeded; it does not change successful publication into an operational failure. The DEX score remains backward-compatible context only; it never computes a combined exit score.
- `degraded` when at least one row is written but an active configured route fails or hits a non-`missing-capacity`/non-`impaired`/non-`missing-cache` unresolved state, the reused DEX liquidity snapshot is stale or missing, the runtime cache has no active configured route at all, a DEX-liquidity preload step failed, or the D1 write/retention step returned warnings
- `error` when no row reaches `resolutionState: "resolved"` and route failures, blocking unresolved states, all active configured routes missing capacity, or an empty active configured cohort prevent resolution; an eventual-only resolved row need not have a numeric headline score

Cron metadata includes `synced`, `resolved`, `unresolved`, `unresolvedMissingCapacity` (plus per-family/per-provider `familyMissingCapacityBy` / `providerMissingCapacityBy` breakdowns when any capacity is missing, so a single failing adapter family cannot hide inside the aggregate tolerance), `unresolvedCritical`, `availabilityDegraded`, `marketImpliedDegraded`, `marketEvidenceUncertain`, `missingCapacityOkThreshold`, `coverageRatio`, `failed`, `configured`, `activeConfigured`, `cacheAbsentConfigured`, `dynamic`, `estimated`, `static`, `liquidityStale`, `severeActiveDepegThresholdBps`, registry/run manifest fields (`registryHash`, `familyCounts`, `strongProxyCount`, `heuristicCount`, `validatorVersion`, `configMethodologyVersion`, `v4ScoringParametersHash`), and route-status producer fields (`routeStatusProducer`, `routeStatusProducerFetches`), plus capped matching ID lists or `missingFromCache` when relevant. Intentional confirmed impairment and current-evidence uncertainty do not by themselves degrade the cron run.

The producer label includes executable observers as well as reused reserve adapters and static policy. `routeStatusProducerFetches` is derived from actual direct-observer attempts, not configured capability. `directObserverAttemptedCount` counts routes whose direct observer was invoked, including unavailable reads; `directObserverConsumedCount` counts admitted rows that actually selected its live route status. `directObserverUnavailableCount` counts attempted routes whose status was not consumed, including failed, output-rejected, overridden, or schema-quarantined evidence. Static-only runs report false and zero counts. These diagnostics do not change scheduler connection accounting or claim that reused reserve evidence was fetched again.

Route exceptions also persist `sourceFailureReasons`, keyed by stablecoin ID, in both the immutable run manifest and cron metadata. Each entry contains a machine-readable `code` and a sanitized error `message` (at most 240 characters); the first 25 failed routes in configured order are retained, with `sourceFailureReasonsTruncated` marking any remainder. Executable identity checks preserve `code-unavailable`, `implementation-unavailable`, `code-drift`, or `implementation-drift`: unavailable reads are not observed mismatches. Their messages name the checked address, identity kind and exact observation block, without provider response text. Other exceptions use `route-resolution-failed`. Every identity rejection remains fail-closed with unknown route status and unavailable capacity; proxy bytecode, implementation storage/code and route state retain the same concrete block and caller-supplied RPC routing options, never re-pinning or changing expected identities to clear a failure. This compaction-protected metadata key preserves the actual observer/decode failure instead of only a `sync-error` placeholder or an array count. Full stacks remain in Worker logs; URLs, credentials and SQL are removed from persisted messages.

`registryHash` is a diagnostic digest of complete configs in canonical ID order; authoring order cannot rotate it. It is not a cache key, snapshot generation ID or Safety Score capture/publication fingerprint.

`coverageRatio` is `activeResolved / activeConfigured` over cache-present configured IDs (zero when that cohort is empty); `resolved` still counts all resolved rows. Cache-absent rows with measured absolute capacity remain published but cannot inflate active-cache coverage.

---

## Scoring Model

### Component Weights

Canonical weights are authored in `shared/lib/exit-route-scoring.ts`; `shared/lib/redemption-backstop-scoring.ts` aliases that table for the standalone diagnostic:

| Component            | Weight |
| -------------------- | ------ |
| Access               | 0.20   |
| Settlement           | 0.15   |
| Execution certainty  | 0.15   |
| Capacity             | 0.25   |
| Output asset quality | 0.15   |
| Cost                 | 0.10   |

If `capacityScore` is unavailable, `computeRedemptionBackstopScore()` returns `null` and the route is treated as unrated. When executable capacity is measured, zero capacity returns a zero headline with `zero-executable-capacity`; positive capacity below both the first 1% request-completion and $100,000 absolute-capacity breakpoints returns zero with `immaterial-executable-capacity`. Other components cannot manufacture a positive route score without a material executable exit.

### Route-Family Caps

Some route families are intentionally capped even when their component mix scores higher:

| Route family      | Cap |
| ----------------- | --- |
| `queue-redeem`    | 70  |
| `offchain-issuer` | 65  |

An optional per-config `totalScoreCap` can apply an additional `config-cap`.

Route-family classification and score caps do not establish execution. A native unwrap pays its exact output, not guaranteed downstream dollars or access to the parent's issuer rail. Holder/cohort restrictions, collateral valuation and queued request/claim gates survive classification; documented fast paths cannot make an ordinary queued route atomic.

The exit-route observation envelope this producer emits is consumed by the Safety Score V9 Exit pillar, which is the only same-notional route grader. Redemption observations accept only `issuer-redemption` and `protocol-redemption` as potentially scoreable families; `eventual-redemption` is diagnostic-only. Reviewed `documented-terms` evidence uses a one-year review window. Reviewed opaque-fee observations can carry modeled capacity tagged with `feeEvidence: "undisclosed-reviewed"` while remaining producer-level non-score-eligible; a consumer must apply an explicit bounded-unknown fee policy rather than treating the route as cost-bounded. Derived full-supply rows evaluate a documented-variable fee against the same reviewed ceiling as hot-buffer routes (`costModel.feeBpsMax` or the Safety-only `v9RouteCostTerms` overlay, including its minimum and fixed charges); only a documented-variable fee without a ceiling keeps that tag. Route independence — and with it the pillar's bounded redundancy credit — is decided by the V9 Exit pillar from enumerated failure domains and physical resource keys.

The V9-only FPI path observes its Controller Pool, FRAX and FPI price feeds, and CPI tracker at one Ethereum block. Admission pins every dependency address and runtime hash, verifies current oracle rounds and controller/feed agreement, rejects paused or out-of-band state, and measures the live fee, quote, FRAX balance, and maximum redeemable FPI. Capacity is denominated as input FPI at the CPI peg; execution cost and the pinned FRAX output value remain separate so the all-in loss must satisfy the modeled-request ceiling. The configured CPI update bounds admit observations up to 62 days old at high model confidence, downgrade observations from 62 through 366 days to medium, and reject older state. The issuer collateral response and the nested route attempt publish through the same reserve-adapter result, so a failed issuer request cannot leave a new route attempt attached to stale composition. This evidence is consumed only by explicit V9 replay and does not alter standalone public redemption rows or scores.

Physical `physicalCommodityDelivery` uses `commodity:xau`/`commodity:xag` from the shared XAU/XAG enum, never fiat or same-notional output. USD valuation requires a source and clock; absent prices stay unavailable. Standalone valuation is captured USD/oz × fine weight less published fees, tier 65 (55 for unbounded delivery), with `sameNotionalEligible: false`. Safety Exit separately admits reviewed physical-to-USD capabilities without changing the standalone score or inventing fiat proceeds.

The September 21 terms pass structures XAUt, PAXG, KAU, KAG, GGBR, PGOLD, XAUm, DGLD, XAGm, CGO and GLDT. CGO conservatively uses the contractual 1,000-token minimum rather than the FAQ's 10; both sources remain attached. XAUt's 430-token deposit is a conservative threshold, not a fixed bar weight. GLDT's CHF 300 vault-pickup charge is an authored CHF `costModel.feeComponents` component, not an invented USD delivery deduction; without a complete fee ceiling it cannot establish all-in cost. GLDY stays unstructured because no reviewed primary source publishes a physical minimum; contradictory secondary fees do not establish one.

### Captured local-fiat costs and outputs

`costModel.feeComponents` (or Safety-only `v9RouteCostTerms.feeComponents`) adds a complete reviewed, additive currency-denominated fee schedule. Each component names an uppercase ISO `currency` and either `terms` or `tiers`. Terms may carry `flatAmount`, `feeBps`, `minAmount` and `maxAmount`: the native charge is `min(max(flatAmount + nativeNotional × feeBps / 10,000, minAmount), maxAmount)`. Omitted amounts/percentage are zero; omitted caps are unbounded. Percentage-with-minimum/maximum therefore uses one component, while separately additive bank charges use another. Existing bps, USD minimum and USD network/bridge terms are unchanged and still additive to these components.

Tier `upToNotional` thresholds are in the component's currency, strictly increasing and upper-exclusive; the final tier must omit its threshold. At each requested USD notional the evaluator first divides by the captured USD-per-native-currency reference, selects the tier, applies native caps, then converts its charge back to USD. Authors must supply the complete applicable schedule, not a minimum, unknown tax, uncertain payout count, account-history condition or optional rail masquerading as an all-in ceiling. Components are deep-cloned with configs and cannot mutate sibling registry entries.

A component alone does not establish that the rest of a dynamic formula is bounded. The existing percentage bound or admitted numeric telemetry is still required; for a complete component-only schedule, authors explicitly set the separate base to zero (`feeBps: 0` on `fee-bps`, or `feeBpsMax: 0` on a formula model). An incomplete dynamic schedule retains a null base and remains unquantified even if its CHF/JPY flat charge is known.

The producer's component-cost reason vocabulary is emitted by `worker/src/lib/redemption-backstop/cost.ts`: `redemption-cost-percentage-ceiling-absent` means the separate percentage ceiling is absent (even with available FX), while `redemption-cost-fiat-reference-unavailable` means a required component currency has no admitted FX rate after the ceiling gate passes. Neither reason supplies a numeric cost or makes the incomplete schedule bounded.

Conversion reads only captured `pegReference` entries with matching `pegCurrency`, positive finite value, `source: "fx"`, no unavailable flag, and a positive non-future source clock within 86,400 seconds inclusive of the scoring request clock. Missing, stale, future, static/fallback, peer-token median and conflicting equal-clock quotes fail closed. The redemption producer reuses its already captured strict stablecoins generation (at most 1,800 seconds old) and its existing peg-reference derivation; the Safety compiler reads its frozen `pegDataById` at `clockSec`. No evaluator fetches a new FX rate, substitutes a token price, or relabels CHF/JPY/IDR amounts as USD. Missing FX leaves `disclosed-unquantified` cost evidence and no known numeric cost; a reusable zero-bps value cannot bypass that gap.

New component-priced non-USD fiat observations pin their USD-per-native-unit reference, its currency-bound source identity and clock beside request-point execution cost only when the reference is no more than 60 seconds newer than route evidence (the shared exit-route schema tolerance). A newer quote leaves the valuation fields unpinned so fact building can resolve its captured FX reference or fail closed, without invalidating the redemption row. Output review preserves a still-admitted pin rather than silently switching output to a later FX generation; stale/future pins are withheld rather than refreshed by a different captured rate.

The same admitted reference values non-USD `fiat` outputs with equal actual/expected native-unit USD values and retains the reference clock and 86,400-second budget. A single explicit issuer output identity such as `fiat:JPY` can be valued on both `issuer-redemption` and issuer-scoped `eventual-redemption` observations without changing an ambiguous basket, tracked-token identity or physical-delivery promise. A delayed protocol route does not inherit this issuer identity exception. Without admitted FX its identity remains known but valuation stays unavailable. USD schedules and USD fiat-par output behavior are unchanged; captured numeric execution-point fees continue to take precedence over newly evaluated fallback terms.

### Physical-to-USD Exit capability

`physicalToUsd` is a Safety-only reviewed config block. It names metal/fine ounces per token, token minimum and increment or enumerated fine-weight bar classes, vaults, sale/delivery scope, fineness, verified-customer eligibility, issuer percentage/fixed fees, delivery/insurance/assay/tax/conversion bounds, issuer settlement legs, optional best-effort issuer cash process, review/expiry and quoted evidence. Terms expire at the earlier explicit expiry or 90 days; the captured raw metal reference retains its 24-hour bound. Missing lot/weight, unstated issuer timing and explicitly unbounded inputs publish null beside a named rejection, never inferred capacity. A Good Delivery gold class may conservatively require 430 tokens plus fee per deposit and count 350 fine ounces; excess deposit is refunded without charging a price/retention loss ([LBMA §2.1.7](https://www.lbma.org.uk/publications/good-delivery-rules/technical-specifications), [Paxos §11.4](https://www.paxos.com/terms-and-conditions/pax-gold-terms-conditions)).

Reviewed configs cover PAXG, XAUT, KAU, KAG, XAUm, XAGm, GGBR, PGOLD, DGLD, CGO and GLDT; a configured candidate is not an admitted route. XAUT models delivery within Switzerland, without inferring Zurich from the country; Kinesis global door delivery and DGLD Swiss-to-European shipping conservatively retain cross-border logistics. Matrixdock's stated T+3 applies only after stablecoin-order execution, Kinesis contact time and GGBR processing time are not bullion-release promises, and XAGm's approximate silver-bar range does not establish a guaranteed fine-weight floor. PGOLD keeps unpublished fees rather than reviving a legacy quote; CGO uses the contractual kilogram minimum, lower contractual purity and both published transfer/redemption charges. GLDT retains its specific one-gram NFT class and the published CHF300 pickup charge as unavailable in USD (`unbounded`), not as an unpublished fee eligible for a policy estimate.

For each existing $100K/$1M/$10M/$25M grid request, the pure evaluator sizes affordable integer lots without borrowing, values delivered fine metal at the captured reference and computes `N = G − issuer fees − bounded logistics/tax/conversion − modelled sale spread`, `c = 10,000 × (G − N) / G`. Physical admission requires `c ≤ 500 bps`; cost scoring uses the same 200-bps denominator as every other route, not the physical admission ceiling. Gross input capacity and net proceeds are both traced. All deductions enter execution cost once: USD output retention remains one, output quality and offchain route ceiling remain 65, and weights and delay/backlog/minimum multipliers are unchanged. Physical routes admit any verified (KYC'd) customer with a neutral eligibility multiplier, without changing other route families. There is no metal-price-movement charge. Best-effort cash branches use their independently reviewed lots, costs and final-USD timing with the existing low model-confidence factor and the same policy sale spread for their bar class/location; an issuer's attempt to sell never implies a zero spread.

Optional `throughput` on the physical route or its independently reviewed cash branch specifies delivered-fine-metal-equivalent `tokens` per calendar `periodSec`, with a source URL and evidence quote. Each grid point is bounded by affordable integer lots and documented throughput over that branch's complete maximum settlement window. Without documented throughput, policy credits at most one minimum redeemable lot per window, using the conservative delivered fine-weight floor and captured spot; it does not infer inventory or buyer demand from supply, mint-rate limits, processing times or minimum denominations. The current reviewed sources establish no physical throughput, so configs retain that conservative fallback rather than invented limits. Admitted capacity is `modelled-terms-lower-bound`, never `exact-lower-bound`, and keeps the existing medium/low model-confidence discounts.

One authority, `semantic.exit.physicalToUsd` in the methodology policy JSON, owns these conservative modelled sale spreads:

| Metal / bar class | London or Zurich (bps) | Other vault (bps) |
| --- | ---: | ---: |
| Gold Good Delivery | 100 | 200 |
| Gold kilobar | 200 | 300 |
| Gold small bar / coin | 400 | 500 |
| Silver Good Delivery | 100 | 200 |
| Silver kilobar | 300 | 400 |
| Silver small bar / coin | 800 | 900 |

These are policy estimates, not executable dealer bids. [BullionVault's primary tariff](https://www.bullionvault.com/help/tariff.html) quotes 0.10% for the first 1–4 400oz gold bars and 0.10% markdown for 32–80 1000oz silver bars; its [daily-price sale](https://www.bullionvault.com/daily-price.do) charges 0.5%. A 1% primary-vault Good Delivery spread deliberately exceeds both. [GoldSilver's dealer buyback guide](https://goldsilver.com/learn/selling/understanding-buyback-spreads/) states larger gold bars (including kilo) bid about 1% or less below spot, recognized 1oz gold bars/sovereign coins 1–2%, generic gold 2–4%, and silver coins 5–8%; policy uses 2% gold kilo, 4% small gold and the upper 8% small-silver figure, with an additional 1% outside primary vaults. The 3% silver-kilo value is a conservative model choice between professional large-bar and retail small-silver evidence, not a dealer quote. Small-silver sale routes exceeding the physical ceiling receive no credit.

Explicit published charges win. Unpublished issuer redemption fees use 100 bps and USD100 fixed, conversion 50 bps; fee assumptions publish `fee-policy-assumed` and low confidence. USD100 covers ordinary transfer/processing friction above BullionVault's cited ACH USD10/SWIFT typically≤USD30; 50 bps conversion exceeds its 30-bps currency switch. In-vault spread covers unpublished transport/insurance/assay, without charging them twice. Same-jurisdiction delivered routes conservatively estimate transport USD3000/500/100 and assay USD1000/100/50 per Good Delivery/kilobar/small lot plus 100-bps insurance. BullionVault's tariff cites Zurich release USD1200/bar plus USD1000–2000 armoured transport, London USD600/bar plus USD250–750; the Good Delivery allowance exceeds those primary-market examples, and the smaller-lot/assay/insurance values are deliberately conservative policy estimates rather than logistics quotes. Cross-border logistics without published bounds remain unavailable; explicit unbounded never becomes an estimate.

Tax is not imposed on every holder sale. Modelled in-vault sales have zero tax for gold and silver; delivered/released metal uses only the unpublished-tax jurisdiction fallback: Hong Kong 0; Singapore 0 for qualified IPM (gold fineness≥0.995, silver≥0.999); Switzerland gold0/silver810 bps; London/EU investment gold0/silver2000 bps; other gold0 only at fineness≥0.995, otherwise2000 bps, and other silver2000 bps. These are release/import-cost allowances, not a claim that a selling holder owes buyer VAT. Sources: [IRAS IPM guide §§2–5](https://www.iras.gov.sg/media/docs/default-source/e-tax/gst-guide-on-exemption-of-investment-precious-metals7f0062ff-780a-4a53-90fa-e1f3b1e25770.pdf), [HMRC investment-gold exemption](https://www.gov.uk/guidance/gold-acquisitions-imports-investments-and-vat-notice-70121) and [20% standard VAT](https://www.gov.uk/vat-rates), [Swiss FTA rates](https://www.estv.admin.ch/en/vat-rates-switzerland) and [VAT Ordinance Art.44](https://www.estv.admin.ch/dam/en/sd-web/FRi2nAPvZT4n/mwst-publ-vat-ordinance-en.pdf), [EU Directive 2006/112/EC Arts.344–356](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32006L0112), and [Hong Kong government's no-sales-tax/VAT statement](https://www.familyofficehk.gov.hk/en/why-hong-kong/simple-and-low-tax-system/index.html).

Curated settlement legs cover issuer release/delivery only. An explicit maximum wins; a stated typical time without maximum uses `clamp(3 × typical, 10, 30)` business days at low confidence with `settlement-maximum-policy-assumed`. The policy vocabulary maps “several business days” (including “up to several”) to 7 typical, hence 21 maximum. No stated issuer time earns no credit. The evaluator automatically appends the modelled dealer-sale leg: [LBMA spot-market convention](https://www.lbma.org.uk/publications/the-otc-guide/frequently-asked-questions) describes forward delivery as later than two business days, so spot T+2 supplies a policy typical2 and conservative maximum10 business days. Sequential maxima include intervening weekends in calendar delay; the existing settlement multipliers are the only time charge. Public primary/alternative traces retain endpoint, holder scope, branch, lots/tokens, gross/net USD, cost, maximum time, freshness budgets, assumptions and rejection reason.


Physical traces publish `netUsd` only for positive calculated proceeds; non-positive proceeds publish null with `physical-net-usd-nonpositive`, and below-minimum requests publish null with `physical-request-below-minimum`. `costBps` retains the full loss from signed proceeds, never a zero-clamped statistic. Both rejected cases earn no score credit.

Severe active downside depegs add a current-exercisability gate on top of the static route score. The incident gate is an open live `depeg_events` row whose explicit direction is below peg; `peak_deviation_bps`, `peak_price`, `started_at`, and incident age remain historical context and never establish present severity. `degraded` / `market-implied` requires the same stablecoins generation used by the redemption run to be no more than 1800 seconds old, its underlying `priceObservedAt ?? priceUpdatedAt` to be finite, non-future, and no more than 1800 seconds old, non-cached and authoritative price trust, an authoritative peg reference, and a finite current signed deviation at or below -2500 bps. A fresh authoritative deviation above that boundary releases this overlay without closing the incident. If currency cannot be established, the route publishes `unknown` / `market-implied`, remains `resolutionState: impaired`, applies `market-implied-depeg-evidence-uncertain`, and withholds its score; a missing feed therefore cannot turn a permanently collapsed asset into an open static route.

Confirmed downside impairment and current-evidence uncertainty both propagate through the exact reviewed payout set. A configured `stable-single` output has weight one even when backing holds a different proportion or asset. Baskets use only admitted live payout weights matching the complete reviewed output set, with the original valuation clock no more than 1800 seconds old and never future; absent, rejected or mismatched weights leave `outputImpairedShare` omitted while preserving the affected dependency identity and an explicit unquantified-share reason. Neither reserve proportions nor equal weights fill that gap. Parent (`variantOf`/`pegReferenceId`), reserve and declared-dependency fallback applies only without reviewed payout identity; the reserve/dependency fallback still excludes `offchain-issuer`. Only confirmed current severe dependencies contribute to a numeric impaired share, and the largest absolute current severe deviation supplies attribution. Confirmed severe evidence takes precedence over uncertain dependencies; without a severe member, a relevant uncertain open incident makes the route `unknown` and unrated. The direct strong-live exception never bypasses output impairment or uncertainty, including an unquantified basket. The redemption producer only reads `depeg_events`; lifecycle ownership and incident closure remain with the depeg producer.

Declared tracked-stablecoin outputs carry `outputDependencyResolution: { stablecoinId, resolutionState }` for the first observed non-resolved configured output in that completed snapshot, omitted for absent/resolved output rows. `applyOutputDependencyResolution` performs a snapshot-local join after all success/failure rows are collected, rebuilding it if final schema admission quarantines a member; direct builders return only their own row and never mutate earlier outputs or share a clock-keyed global map. This disclosure does not alter valid upstream measurements, status, confidence, scores or Safety eligibility. The writer explicitly preserves it in selected `details_json` for immutable and history rows, and bulk/per-coin readers return the same stored disclosure. No D1 migration or backfill is required: old immutable rows that never captured it remain unchanged until a fresh producer run supplies new evidence.

---

## Exact-request execution certificates (local V10)

Safety Score methodology 10.0 admits new unsupported-rail execution only through an optional `executionCertificate` on the existing route observation, paired with `executionModelId`. Legacy documented issuer routes remain separate and retain their current charge, including issuer non-disclosure. The reviewed structural registry `shared/data/safety-score-v9/exit-execution-model-reviews-v1.json` now contains exact synchronous ERC-4626 vault reviews; a reviewed identity is not capacity, and every rail still needs a fresh admitted execution certificate.

`shared/types/exit-route.ts` owns the strict certificate/review/point/gate shapes. `semantic.exit.executionModels` in the methodology policy owns admitted model IDs, required gates, exact-request requirements, source/price maximum ages, future skew, permitted capacity bases and certification ceilings. `shared/lib/safety-score-v9/exit-execution.ts` is the common compiler/evaluator admission authority. Permissioned off-ramp models use a 300-second source/price budget; reviewed `erc4626-instant` uses 18,000 seconds for the four-hour producer. The dormant Kraken producer is retired and exact orderbook admission is research-only. None inherits the more lenient stale-retention treatment of legacy routes. Missing model/review is `method-unsupported`; a supported read/proof failure is `producer-failed`; explicit issuer non-disclosure remains `issuer-undisclosed`.

Execution-model reviews use an **inclusive** `expiresAt` instant: the evaluation clock must satisfy `reviewedAt <= clock <= expiresAt`. An otherwise admissible certificate remains admitted one second before expiry and at exact equality; one second after expiry it is unavailable with `execution-review-expired` / `method-unsupported`. The fact-set compiler uses the same boundary when enumerating reviewed rails without certificates: the missing-runtime gap remains applicable through equality and is not emitted for an expired review. This contract preserves existing behavior and does not renew source/price observations, waive other certificate gates, or change the expiry rules of other evidence families.

The implemented permissioned adapter is `worker/src/lib/exit-execution/securitize-offramp.ts`. It pins the off-ramp proxy/implementation, asset/provider/output identities, dependency bytecode and EIP-1967 implementation bindings, then reads pause, transfer-not-burn, internal two-step semantics and provider inventory. Each passing prefix receives its own NAV/fee/minimum-output quote and actual holder `redeem(amount,minOutput)` `eth_call`, with real token balance/approval prerequisites and no state overrides. It also obtains gas estimate/gas price and requires a current native-USD reference. A view quote alone, provider inventory alone, absent approved holder context, failed execution or unknown gas value is diagnostic. Internal two-step transfers are one transaction; external queues/issuer processing are not silently recast as atomic.

The certificate records executable **input notional** separately from retained output USD. Output legs keep their real denomination (for example, VBILL's RLUSD, FUSD's USDT, scrvUSD's pool USDaf versus separate vault crvUSD). Integer raw-unit arithmetic is preserved until the existing numeric valuation/curve boundary. Execution fees and gas affect execution cost; the output-valuation mechanism applies output-price retention once. Unknown valuation of one basket leg invalidates the basket. Shared provider/token inventory, PSM/vault resources and settlement accounts are common-mode resources, not additive independent liquidity.

`buildRedemptionBackstopEntry` appends new producer observations without replacing its documented issuer route. `buildSafetyScoreV9RouteReviews` uses certificate-specific holder/access/settlement/resource/output semantics rather than inheriting one issuer entry's terms for every rail. The compiler admits the exact canonical-supply stress request and the evaluator independently rechecks current policy, review, clock and request before accepting the point; missing exact points cannot fall back to smaller legacy curves. Public projection excludes customer identities, prerequisites, evidence IDs and producer configuration.

For reviewed vault-owned shares, an absent or stale market-price reference may be replaced only by the exact pinned `convertToAssets` gross NAV multiplied by an independently observed, policy-fresh underlying USD price. The reference binds the vault block hash and complete underlying reference, with the older source clock; no synthetic seed price, nominal underlying parity or freshness extension is admitted. External-share custodian routes retain their separate market-price and pinned gas requirements.

Withheld execution routes persist diagnostic-only `executionRouteFailures` and `exitRouteObservationCoverage.unsupportedReasons` in per-asset run/history details and API rows, naming stale, unavailable or future price legs with their observed clock, source generation and effective `capturePriceMaxAgeSec`, without changing route admission or scoring.

The serial ERC-4626 observer measures one canonical request and at most five bounded smaller probes after its ordinary-max/idle fallback. A successful call that burns shares but transfers no underlying is an unfunded/deferred receipt, not instant execution. The original attempt remains in the optional, diagnostic-only `canonicalAttempt` on the point, pinned to its block and retaining its actual burn, return and received amounts; classification distinguishes completed, accepted-but-unfunded, reverted and inconsistent receipts. Canonical queue acceptance requires full burn, zero return and same-call supply/fee reconciliation before any smaller probe. For a reviewed vault-owned-share route with positive max bounds, smaller same-block calls with the original holder balance may prove an instant lower bound; every selected receipt still requires exact transfer, burn, return value, supply reconciliation and cost admission. Fee-share replay restores the winning calldata even after later unsuccessful probes. `settlement.scope: "executed-input-only"` confines immediate settlement to the demonstrated fraction; the unexecuted remainder stays unknown, not zero capacity or a bounded queue payout. The diagnostic does not itself alter admission, gates, capacity or scores. Existing certificates without these optional fields parse unchanged. Existing four-hour scheduling, one-connection peak and policy admission floors remain unchanged.

An inconsistent canonical receipt fails closed; its typed pinned diagnostic is retained in the runtime failure, not admitted as execution. Public certificate projection retains diagnostic amounts and outcomes but omits opaque revert bytes. Neither diagnostic outcome nor an unknown remainder is a new scoring input.

Other approved model IDs remain research-only/diagnostic in policy until their exact callable identity and model prerequisites exist. The reviewed synchronous `erc4626-instant` lane is enabled; its scoring curve projects only the generation-bound canonical request while the original canonical attempt and selected proven receipt remain separately available in the certificate. A partial receipt is a lower bound, never complete unwind or exhaustion. Queues require funded claims and a proven completion maximum, not accepted requests, epoch length or T+ estimates; bridge withdrawals require the complete initiation/proof/finalization/destination-liquidity path; physical-to-USD retains its separate documented/modelled method and must not become an observed certificate. Mento, basket, conditional, other rate-bearing and uncovered DEX families are not activated by the registry's existence.

Captured-input replay uses the supported maintainer procedure in `docs/process/safety-score-equivalence-harness.md`. Diagnostic packets retain actual clocks, exact requests and honest failures, remain separately labeled, and never backdate evidence or mutate canonical curation/old captures. Ignored campaign diagnostics are not durable operating commands. The [scoring history](https://pharos.watch/methodology/scoring-changelog/) records release changes; a registry entry alone changes neither schedule nor permissioned/ERC-4626 admission.

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

Scalar `v9RouteReviewTerms.settlementDelaySec` is admitted only with dated, current source support explicitly including `settlement` for the **completed configured endpoint**, with chronology and payout-identity gates for favorable corrections. A route-only citation, processing target, cooldown or claim-eligibility minimum does not prove final receipt. Scalar and business-day representations are mutually exclusive; only unconditional binding calendar terms with admitted cutoff/timezone/coverage can yield a completion ceiling. Rejected scalar/calendar reviews cannot revive a persisted generated SLA.

`scoringDisposition: "bounded-terms-gap"` plus `missingScoringFields` retains the asset's primary capacity/cost/settlement review across every redemption-lane route ID, including noncanonical FPI controller, sfrxUSD cross-chain and `execution:<digest>` observations, even when captured numbers or known statuses exist. Canonical ID formatting is not an exemption. Only the separately reviewed `physical-to-usd:<asset-id>` rail with its own `physicalToUsd` trace opts out; a matching name alone cannot. Strictly newer admitted exact execution evidence for the same asset/rail/model/request can supersede the review. The explicit missing factors remain causal diagnostics, not proof of measured total-exit failure.

Config cloning uses native `structuredClone` on data-only configs at registry initialization, isolating the complete nested authored shape, including fee tiers, physical fees/stages/evidence, suspension sources, docs and calendar terms. Keep functions and other non-cloneable values out of configs. Each family authors one final row per ID with its source path; registry and family factories reject every duplicate before map conversion and enforce family ownership. Reviewed docs are finalized without replaying historical default overrides. Midas, Spiko, Ondo and Nest use the same collision-safe construction without new semantic defaults or evidence credit.

`RedemptionBackstopConfigSchema` owns scalar bounds; the registry audit renders each canonical issue as `schema-validation` with its field path, without a second scalar diagnostic. Contextual adapter/observer identity, numeric daily-limit prose, documentation-support ratchets, source-AST overwrite detection and manifest completeness remain separate checks. Unused-live-telemetry policy rows remain exported and audited; only consumed runtime policy kinds need private indexes.

The public registry import lives in `shared/lib/redemption-backstops.ts`. The actual config inventory is split by route family under `shared/lib/redemption-backstop-configs/` to keep review and change scopes small.

Family ownership follows the modeled holder endpoint, not issuer branding: opaque asynchronous burn/attest/release belongs to `queue-redeem`, and inventory-dependent on-chain swaps to `psm-swap`, including whitelisted cohorts. Preserve the reviewed access, execution, payout and gap facts when correcting family ownership; do not falsify them to satisfy a family constraint. Such corrections can change route diagnostics and require replay.

`outputAssets` records concrete holder-route outputs, not every reserve asset. Stable outputs use tracked stablecoin IDs; collateral outputs use canonical `asset:<symbol>` keys. Configured baskets are limited to 16 members, matching the `ExitRouteOutput.assetKeys` bound. Leave the field unset when the published route is incomplete or when its tracked and untracked members cannot all be represented: an incomplete subset must not turn an unresolved basket into a resolved one. When a complete reviewed route contains untracked assets, `unresolvedOutputAssetKeys` may preserve the exact identities for diagnostics; those keys do not resolve or score the output.

Explicit stable `outputAssets` take precedence over offchain issuers' legacy fiat default; payouts are not input NAV or reserve holdings. Physical delivery and unresolved commodity collateral retain precedence. The output schema requires currency for fiat, and commodity identity plus `sameNotionalEligible: false` for physical delivery; it rejects fiat/tracked fields on physical outputs and requires source-timed USD evidence for any valuation. Issuer rails never infer payouts from `variantOf`; the legacy fiat projection is not evidence of bank settlement.

The reviewed issuer selections explicitly pay USDT for FinChain FUSD, USDC for Gate GUSD, wM for Noble USDN, and M for KAST USDK. Noble's separate wM-to-USDC market swap is not its direct bridge-redemption output. These tracked endpoints flow through the producer and Safety output review rather than `fiat:USD`. KAST's M unwrap is not a separately mediated partner fiat ramp; every route retains its reviewed access, cost, capacity and settlement constraints.

Config modules own per-asset payout evidence and gaps. A single tracked payout scores output quality **100** at par only with captured valuation; a multi-output route retains conservative `stable-basket` quality **80** and weakest-price semantics, not invented equal weights or holder-choice branches. Known physical delivery remains non-comparable unless its separately reviewed metal-sale path is admitted.

A holder route must bind the exact tracked asset and deployment, not a same-symbol token, legacy/replacement mint or unrelated wrapper. Administrative burns, borrower repayment, reserve management and secondary-market cash-out do not by themselves establish holder redemption.

For example, [PYUSDx terms](https://www.moonpay.com/legal/pyusdx_terms) give onboarded eligible counterparties PYUSD, not a universal fiat claim; [Ondo's guide](https://docs.ondo.finance/ondo-stocks/investing-and-redeeming.md) separates instant USDon from inventory-conditioned USDC. Full-supply issuer/fund entitlements are eventual-only unless a funded buffer is independently established. Bank rights, subscription minima, NAV, daily thresholds and gate percentages supply neither current capacity nor completed receipt.

Opaque composite/migration paths cannot be relabeled deterministic `stablecoin-redeem`/`psm-swap` merely to register documentary access. Solomon replacement USDv, Initia iUSD and legacy ICON bnUSD retain sourced unconfigured dispositions; known balances, 1:1 displays and institutional issuer terms do not establish exact end-to-end payout/execution. A configured institutional route likewise does not admit an unrelated native/wrapper rail.

### Reviewed channel suspension (local V10)

`routeStatus: "suspended"` requires a dated, sourced `routeSuspension` review naming the exact configured `redemption:<asset-id>:<family>` route. The registry rejects a different asset/family identity; capture-time admission rejects a later review. A suspended channel has null standalone immediate/eventual/scoring capacity and scores, and compiles into a diagnostic route with no executable request or curve. Public standalone status reasons, Safety Exit reasons and alternative-route diagnostics disclose the channel and reason. The admitted cessation is a source-bound D (`measured-adverse`) exact-channel witness, not U; its intentionally masked execution factors create no missing-data obligations. It contributes zero eligible capacity without claiming a measured numeric zero or whole-asset exhaustion.

DEX observations, separately identified issuer routes and execution certificates keep their own scoring evidence. If there is no scored alternative, or the best measured alternative scores zero, a suspended channel cannot certify total exit failure: the portfolio retains the existing `missing-same-notional-route` bounded-unknown floor, without `no-viable-exit-path` or measured-adverse total-exit attribution. The other routes' own traces remain unchanged. This record never changes lifecycle, wind-down, holder rights or reserve evidence.

**VNXAU, reviewed October 2, 2026.** The [June 19 primary notice](https://vnx.li/blog) suspended the legacy **vnx.li** platform exchange from **June 30 at 18:00 CET** and ended its remaining-balance withdrawal window **July 31 at 18:00 CET**. Only that legacy channel is reviewed suspended. [VNX Global terms §6](https://prod-global-terms.s3.sa-east-1.amazonaws.com/VNX-Global-Terms.pdf) separately describe discretionary, resource-dependent commodity-token exchange at **my.vnx.io**, including VNXAU for fiat or other digital assets. That channel has no admitted capacity, complete payout set or settlement maximum and earns no credit; it is not treated as suspended by the legacy notice. The Metals.io market diagnostic remains separate. No currently bounded physical-release timing or current reserve composition is established, and the production-capture smoke still publishes VNXAU **NR**, not F.

**EURR, reviewed October 7, 2026.** The StablR direct issuer channel is source-confirmed suspended **as of June 24, 2026**. The rendered publisher date, not the URL's `2025` suffix, owns that date; it is an as-of boundary, not an invented incident onset. Missing or severe market quotes do not reopen the selected channel. Other routes and lifecycle retain their separate evidence.


### Output-key identity contract

Output identity is kind-specific and must remain stable from the configured route through the producer observation and Safety Score V9 review:

- `tracked-stablecoin` outputs use tracked stablecoin registry IDs. Unknown IDs are rejected rather than inferred from symbols.
- `collateral` outputs use the reviewed non-tracked `asset:<symbol>` vocabulary derived from the redemption config registry. These keys are deliberate collateral identities, not aliases for tracked stablecoins.
- `unresolved-asset` outputs may use only the exact keys declared by `unresolvedOutputAssetKeys`. They remain unresolved except for a single explicit non-USD issuer `fiat:<ISO currency>` identity, which the captured local-fiat path can value with admitted FX; ambiguous alternatives and baskets never inherit fiat par.

The registry validator enforces configured identities, while the V9 review boundary rejects unknown identities and preserves a captured identity mismatch for diagnostics rather than rewriting the producer's observation. USD0 (`usd0-usual`) therefore keeps its reviewed mixed-collateral outputs `asset:usyc`, `asset:m`, and `asset:ustbl`; renaming them to tracked IDs or moving them to an unresolved namespace would silently break exact output matching and valuation.

The complete payout set is mandatory: untracked members cannot be dropped to create a priced basket, and holder-selected alternatives are not proportional baskets. Preserve exact untracked receipt identities rather than aliasing them to tracked siblings. Cash payout is distinct from NAV input pricing; identity alone proves neither valuation, openness, funded capacity, complete costs nor completed receipt. Physical delivery, a conditional issuer-change payout and a secondary sale remain separate paths.

### Capacity Models

Capacity resolution is dispatched in `worker/src/lib/redemption-backstop/capacity.ts`. `static.ts` under `worker/src/lib/redemption-backstop-capacity/` owns the three discriminated static models; `reserve-sync.ts` and `executable-observer.ts` retain live admission. `worker/src/lib/redemption-backstop/sources.ts` orchestrates the entry build. `buildBoundedCapacityFields` in `profile.ts` shares supply/day/profile arithmetic; each model retains its own null, zero, confidence and horizon policy.

Correcting an output identity does not quantify its inventory. The selected token still needs its own admitted price/dependency evidence; missing price or route terms stay unavailable instead of receiving fiat-par or current-capacity credit.

Config defaults, legal full-position rights, AUM, gate percentages and numerical diagnostics cannot close executable-capacity, all-in-cost or final-completion gaps. Unknown capacity stays unavailable, never observed zero. Review dates do not become publisher dates; endpoint recovery, a config correction or a new production run alone cannot renew positive evidence. Only fresh exact-route evidence measuring the missing predicate, or a separately admitted exact-request certificate, can close that predicate without clearing unmeasured sibling conditions.

Queued requests, funded owner-claimable receipts and operator processing are distinct. Idle balances, queue counts, refill-dependent escrow and initial fees do not establish new-holder throughput; cooldowns, claim minima, service averages and customer-response deadlines are not completion maxima. Issuer processing is not bank receipt. A measured delayed receipt may support eventual-only capacity, with its own output valuation, guards and costs, never an invented immediate buffer or completion SLA.

| Capacity model          | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `supply-full` | Sets full current supply as `capacityProfile.eventualUsd` and derives the diagnostic `eventualRedeemabilityScore`; current scoring capacity stays empty because the immediate buffer is not separately quantified. |
| `supply-ratio` | Immediate modeled capacity is `supplyUsd * ratio`, bounded by supply. A documented daily limit caps `scoringUsd`, not `immediateUsd`; confidence is heuristic unless the config explicitly opts into stronger evidence. |
| `fixed-usd`             | Immediate modeled capacity equals a reviewed absolute USD buffer, clamped to current supply when supply is known; missing-supply rows keep the USD amount visible but use conservative absolute-tier scoring                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `unquantified`          | Retains reviewed qualitative route terms without a capacity source. Immediate, scoring and eventual USD amounts/ratios remain null; public semantics are `eventual-only`, profile horizon is `unknown`, and resolution is `missing-capacity`. It never borrows supply, reserve balances or an adapter lacking exact-route capacity telemetry. |
| `reserve-sync-metadata` | Reads normalized `reserve_composition.metadata.redemption.capacityUsd` / `capacityRatioOfSupply`, from the latest fresh live snapshot only when the adapter explicitly exposes redemption-capacity telemetry and the snapshot carries scoring-grade freshness evidence. The telemetry must isolate assets immediately executable through the holder route; mixed reserve or accounting buckets remain contextual backing evidence. Degraded snapshots still fail closed by default, but specific lower-bound-only warning classes can be allowlisted per route when they indicate reserve completeness limits rather than broken telemetry. Routes can also fall back to a reviewed configured ratio or USD amount when public docs publish a hard primary-market buffer floor. Full-supply eventual capacity is emitted only when the config explicitly sets `eventualCapacityModel: "supply-full"` and carries `reviewedAt` plus supporting route sources. |
| `executable-observer` | Uses an exact registry-declared direct reader with explicit `observerId`, `capacityUse` (`diagnostic-only` or `measured`) and required payout keys. Diagnostic-only observations retain status/fee/provenance without numeric capacity. Measured observations require valid block/source clock and same-run output valuation; no static ratio, full-supply or reserve-liquidity fallback exists. |

Rows may include `capacityProfile`, which separates `immediateUsd`, `dailyLimitUsd`, `queuedUsd`, `eventualUsd`, `scoringUsd`, `scoringHorizon`, and `capacityProfileConfidence`. Legacy `immediateCapacityUsd`, `immediateCapacityRatio`, and `capacityScore` remain populated for compatibility. Reserve-sync backing or total supply is not evidence that the holder route can eventually redeem all supply; eventual capacity therefore remains absent unless that route-level claim passes the explicit reviewed opt-in.

For positive supply, `immediateCapacityRatio = immediateCapacityUsd / supplyUsd` after the supply bound; `scoringCapacityRatio = scoringCapacityUsd / supplyUsd` after supply and daily-limit bounds. Daily limits constrain scoring capacity, not the immediate inventory. An issuer-reported ratio is nested diagnostic telemetry: it may infer an omitted USD amount but never overrides the finalized amount's ratio. Missing or zero supply leaves ratios unavailable. V9 does not consume CDP capacity ratios.

Absent, empty or wholly invalid supply buckets remain null; explicit finite zero remains observed zero. Independently measured/fixed absolute USD buffers remain visible when supply is unavailable, with ratios unavailable and existing absolute-tier scoring; supply-full/ratio models cannot invent a denominator or redeemable zero.

The internal `evidenceObservedAt` is the validated nested `redemption.sourceTimestamp`, or, for `same-run-onchain` / `same-run-api` telemetry without one, the producing reserve snapshot's `fetchedAt`. Exit observations keep that original clock for `observedAt` and age; entry `updatedAt` remains publication time. Missing evidence time cannot establish a scoreable live-direct observation. Documented-bound observations use their direct evidence time when available and otherwise retain the terms-review date. Same-run state retains V9's existing 8h redemption evidence budget. An exact reserve-backed `verified-source-timestamp` observation instead expires at the earliest of the original disclosed source time plus the admitted tighter adapter/coin source budget, original reserve fetch plus 48 hours, and redemption run plus 8 hours. This separates disclosure cadence from producer cadence without renewing either clock or widening either budget. Nested source timestamps older than the stricter adapter/coin reserve source-age budget are rejected before persistence; the existing two-day reserve freshness fallback applies when neither declares a budget.

Live reserve adapters emit a nested `metadata.redemption` object for redemption-specific telemetry. The validator rejects malformed or unsupported redemption telemetry before persistence, including negative capacity, capacity ratios outside `0..1`, negative fees, capacity fields from adapters that declare no capacity support, fee fields from adapters that declare no fee support, or direct-capacity tiers emitted by proxy-only adapters. The store-row decoder still reads legacy flat capacity/fee fields from historical rows (30-day retention) and maps them into the nested contract at decode time, but no producer writes them.

`live-metadata.ts` consumes canonical decoded nested telemetry directly; malformed-versus-absent remains the decoder's discriminant. Only opaque legacy flat buy-fee bounds need local numeric parsing. Capacity and fee admission, clock/output identity checks and adverse route constraints remain independent.

`capacityRejectionReason` is an optional machine-readable public field, owned by `RedemptionCapacityRejectionReasonSchema` in `shared/types/redemption.ts`. It includes canonical reserve rejection codes plus `route-output-identity-unobserved`, `redeemable-capacity-unobserved`, `output-valuation-unobserved`, `all-in-cost-unobserved`, `settlement-bound-unproven`, `malformed-telemetry`, `unsupported-capacity-kind`, `missing-source-timestamp`, `future-source-timestamp`, `stale-source-timestamp` and `missing-block-number`. A missing amount is heuristic unknown capacity, not `live-direct` measured zero; an observed native amount can instead lack valuation or all-in cost. Rejected input can use only an explicitly reviewed model fallback, never retained invalid telemetry, and no fallback may rescue an observed non-open route.

Timestamp-less **unverified composition** may carry independently admitted nested on-chain redemption proof only with a clean fetch/configuration, valid original source time/block, configured exact payout keys, scoreable capacity kind, observed openness, holder eligibility and capacity. Malformed/future/stale/invalid composition cannot bypass admission; reserve-warning and route-specific degraded lower-bound allowlists remain. This grants no composition freshness or Backing credit.

`settlementBoundUnproven` survives fallback, profiles and observations. Unknown/open async routes withhold immediate/scoring capacity; older required-chain time owns multichain diagnostics. Independently measured funded delayed receipts may support eventual-only capacity, not same-notional immediate liquidity. Fully observed paused-zero remains adverse zero.

Positive telemetry rejection retains independently sourced adverse status, daily limits and async restrictions. Non-open observed routes prohibit every ratio/USD fallback. Producer vocabulary cannot author a suspension; only source-reviewed `routeSuspension` can.

Current asset-to-reader choices belong to family configs and `liveReservesConfig.params.redemptionLiquidity`, not this document. Durable live-admission rules are:

- Measure the holder's exact resource, not full reserve NAV. Contract-owned balances, allowance-limited Cash Wallets, currently withdrawable strategy claims and enabled facilities have distinct guards and may share one resource. Reservoir wrappers share their terminal USDC PSM inventory; wrapper and downstream balances are never additive independent liquidity.
- Preserve one validated numbered block/hash/time across all required identities, balances, quotes, decimals and guards. Synchronized Mento reserves/balances, actual outputs, trading-limit headroom and oracle/market-hours state must all pass; an unreadable shutdown/quote is unavailable, not zero. Fee absence grants no cost credit and partial outputs never become complete.
- Keep the exact [Mento OracleAdapter](https://celo.blockscout.com/address/0xc1b767756f582d124e76bb3e246f31e6ab256059) evidence boundary: `FXMarketClosed()` is a named `fx-market-closed` rejection, not a missing quote. Stored reserves and old open-market quotes cannot override closure. The reserve sync records closure as the informational `mento-redemption-fx-market-closed` warning: capacity stays unavailable, but a routine weekend/holiday closure does not degrade the reserve read.
- ERC-4626 idle is not total instantly redeemable backing. Only source-reviewed `atomic-full-backing`, Stability Pool, cross-chain hop, active-strategy, Yearn queue or exact Morpho paths may use their own declared source. Required unread strategy/implementation/peer/return-funding probes fail closed, never fall back to full NAV or a disabled local path.
- Morpho V1/V1.1 validated market liquidity has no donated idle floor. V2 `forceDeallocatableLiquidity` is contextual; selected-adapter/idle fallback remains distinct. Null/omitted warnings mean none, while exact informational warning exceptions can still withhold API capacity; malformed/unreviewed warnings degrade reserve evidence.
- Observed pause/shutdown wins. Otherwise openness must come from the exact configured route/observer; positive balances, clean reserve snapshots, deposit-disabled flags and failed pause probes cannot certify open. The current-open gate also applies when a live-direct atomic/immediate observation is not score-eligible.
- A specialized observer owns its full state contract: Noon's pinned handler pointer/live retroactive period, eEARN operator batching and sdUSD strategy liquidity cannot inherit a generic cooldown rule. Unexpected pointers, unreadable/out-of-range periods or identity drift yield unavailable, not a substituted delay.
- Reviewed degraded lower bounds are allowlisted for reserve-completeness warnings only, never broken route telemetry. Static documented buffers need an explicit published holder-route floor; backing, delta-neutral strategy descriptions and route docs alone cannot promote full-supply immediate capacity.

The resulting row is tagged with one `sourceMode`:

- `dynamic` for admitted live reserve evidence or registry-driven executable-observer evidence
- `estimated` for static supply models or configured reserve-sync fallback ratios
- `static` for fixed-USD models as well as unresolved/error diagnostic rows; use `resolutionState`, not source mode, to establish availability

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

Provider identifiers are defined in `shared/lib/redemption-backstop-providers.ts` and describe where the capacity number came from, what confidence defaults apply, and whether the source can ever survive a severe-depeg gate.

| Provider                | Capacity source           | Default source mode | Default confidence | Default semantics   | Severe-depeg scoreability         |
| ----------------------- | ------------------------- | ------------------- | ------------------ | ------------------- | --------------------------------- |
| `supply-full-model`     | Full supply model         | `estimated`         | `heuristic`        | `eventual-only`     | Not scoreable                     |
| `supply-ratio-model`    | Configured supply ratio   | `estimated`         | `heuristic`        | `immediate-bounded` | Not scoreable                     |
| `fixed-usd-model`       | Fixed reviewed USD buffer | `static`            | `documented-bound` | `immediate-bounded` | Not scoreable                     |
| `unquantified-model`    | No quantified capacity    | `static`            | `heuristic`        | `eventual-only`     | Not scoreable                     |
| `reserve-sync-metadata` | Live reserve metadata     | `dynamic`           | `dynamic`          | `immediate-bounded` | Requires strong live-direct route |
| `reserve-sync-fallback` | Reviewed fallback ratio   | `estimated`         | `heuristic`        | `immediate-bounded` | Not scoreable                     |
| `executable-observer` | Direct executable reader | `dynamic` | Measurement-derived | Use/horizon-dependent | Requires separately admitted strong live-direct evidence |
| `sync-error`            | Failure sentinel          | `static`            | `heuristic`        | `immediate-bounded` | Not scoreable                     |

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

`snapshot_run_id` links immutable `redemption_backstop_run_rows` to a completed `redemption_backstop_runs` manifest. API and report-card readers prefer the latest valid completed run. If the newest completed manifest is incomplete or its rows are unreadable, readers try recent earlier completed runs before returning `503`. The true-legacy `MAX(updated_at)` fallback is retired: with no valid completed run, readers fail closed to `503` (fresh local databases 503 cleanly until the first completed sync).


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

The cron writes immutable `redemption_backstop_run_rows` first, writes daily history, and marks the run manifest completed only after the immutable row count and bounds are valid. The legacy current-mirror refresh is retired: readers (including the depeg-resolver context, which uses a narrow store reader over the latest valid completed run) consume immutable run rows exclusively, and the `redemption_backstop` table is frozen in place pending a separately coordinated destructive cleanup.

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

The sync inserts a `running` row before writing immutable run rows, writes history after those rows are complete, and marks the manifest `completed` only after the immutable row count and update bounds are valid. If immutable row, history, or completion writes fail after the manifest is started, the writer best-effort marks the manifest `failed` with phase-specific failure metadata before rethrowing. Readers prefer the latest valid completed run, use its `max_updated_at` for response freshness, and use its `methodology_version` for API methodology attribution. If no completed run exists, they return `503`; the legacy current-mirror write and the `MAX(updated_at)` fallback are retired.

Run manifests and immutable run rows are pruned after successful writes with a 14-day retention window. The prune keeps the just-written run and the latest completed run even when either is older than the cutoff, so current API reads stay intact. Retention failures are recorded as completed-run warnings instead of failing the already-written snapshot.

The orphan run-row pass (rows whose manifest no longer exists) derives its candidate run ids from a covering-index `DISTINCT snapshot_run_id` scan and is bounded per distinct orphan run, instead of walking the whole run-row table with a correlated manifest probe per row. An empty pass therefore stays a cheap index scan rather than a ~28k-row table walk on every retention run.

---

## API Endpoint

### `GET /api/redemption-backstops`

**File:** `worker/src/api/redemption-backstops.ts`

- Returns `503` with `{ "error": "Redemption backstop snapshot unavailable" }` when no valid completed run can be read cleanly from immutable run rows (including before the first completed sync on a fresh database); partial manifested current rows are not treated as authoritative
- The response metadata carries `snapshotSource: "run-rows"`; snapshots are read only from immutable rows for a valid completed run
- Otherwise returns the current map plus methodology metadata from `buildRedemptionBackstopsSnapshot(db)`, with `methodology.version` attributed from the latest completed run manifest and `currentVersion` preserved as the live code version
- Optional `capacityRejectionReason` carries the exact typed admission failure. Malformed/missing required immutable details invalidate a run; earlier valid fallback retains its original freshness, including stale/no-store treatment. No surviving complete run means `503`.
- Cache profile: `standard` (`public, s-maxage=300, max-age=60`) with freshness headers based on `updatedAt`

See the [public API reference](https://pharos.watch/api/) for the exact response shape.

---

## Frontend Consumers

- `src/hooks/api-hooks.ts` exports `useRedemptionBackstops()`, wired through `FRONTEND_API_QUERY_DESCRIPTORS.redemptionBackstops` in `src/lib/api-query-descriptors.ts` with `CRON_INTERVALS["sync-redemption-backstops"]` (the 4-hour producer cadence)
- `src/hooks/use-stablecoin-detail-view-model.ts` uses `useRedemptionBackstopCoin(id)` and the site-only `/api/redemption-backstop-coin?stablecoin=<id>` transport. It selects a row only after the same whole-run admission as bulk and live-signal readers, preserving the original methodology, manifest generation and full cohort count. Response freshness uses the admitted manifest's original `max_updated_at`; `projection.updatedAt` retains the selected row's own clock. Absent rows carry `row-not-published` under that admitted generation, never a zero route score or permission to skip sibling validation. Whole-cohort consumers keep `useRedemptionBackstops()`.
- `src/components/stablecoin-detail/redemption-backstop-card.tsx` renders one `Standalone route score` with a route-specific title (`Issuer redemption route` or `Redemption route`), source freshness, route family, source mode, resolution state, route status, model confidence, access/settlement/output/capacity blocks, eventual-only vs immediate-bounded capacity messaging, explicit redemption-fee summaries keyed off `feeModelKind`, reviewed docs/source context, component subscores, and contextual methodology hint / footer actions.
- Capacity headlines preserve finite nonnegative absolute observations, including zero with no supply ratio. Eventual-only semantics alone assert no amount: current-supply wording requires an admitted resolved eventual profile bound without capacity rejection; unquantified routes remain explicit.
- `composeExitComponentScore` in `shared/lib/exit-route-scoring.ts` owns the displayed weighted total and cap delta; labels are centralized in `shared/lib/classification.ts` via `classification/redemption.ts`. Safety reconciliation uses typed exact `routeId` plus the redemption `lane`, never opaque key suffixes.
- `src/lib/stablecoin-detail-view-model.ts` includes redemption freshness in the detail-page stale-query rail
- `/coverage` consumes `useRedemptionBackstops()` through `src/lib/coverage/redemption.ts`. It distinguishes scored route-family states from low-confidence heuristic routes, resolved-but-unscored routes, configured-but-unrated routes, impaired routes, no route, and `Data n/a` feed-unavailable states. Within impaired rows, `degraded` / `market-implied` means confirmed current severe evidence, while `unknown` / `market-implied` means the open incident lacks current authoritative evidence; both remain unrated and cannot inflate public strong-coverage counts. The Redemption quick filter includes configured/resolved route states but excludes `Data n/a`.

The maintenance coverage audit requires a durable reviewed disposition for every active asset without a route config. `shared/data/coverage-dispositions/redemption-coverage-dispositions.ts` records evidence URLs, reviewer/date, rationale, the exact blocker and evidence still needed, and a route family only when official evidence proves that family. `add` means the holder route is evidenced but configuration still needs the listed capacity/status inputs; `needs-research`, `defer`, and `hard-reject` remain legitimate coverage outcomes and do not create a scoreable route. The audit rejects stale registry rows and keeps heuristic configured routes visible until hard capacity evidence replaces them.

`npm run audit:coverage -- --domain=redemption-coverage` always evaluates these reviewed-disposition findings. Default and `--check` modes have identical exit semantics (`0` for a valid reviewed backlog, `1` for findings); `--check` only changes presentation. `--strict-active-gaps` independently escalates default-inferred active gaps. A nonzero backlog is not itself a failing invariant, and none of these modes admits a runtime route.

There is no dedicated redemption list page. The stablecoin detail page is the primary route-diagnostic surface; its contextual hints distinguish the standalone score from Safety Exit. Public methodology sections for both are owned under `/methodology/`.
