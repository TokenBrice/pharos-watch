# Stablecoin Listing Policy

This document defines which assets Pharos admits, how admitted assets are classified, and how assets leave the active universe. It is the public policy contract for catalog curation. Runtime price construction remains in [Pricing Pipeline](./pricing-pipeline.md).

## Sources Of Truth

Listing governance is checked in and deterministic:

| Concern | Authoritative source |
| --- | --- |
| One listing class for every catalog ID, plus retained excluded decisions for removed cemetery IDs | `shared/data/stablecoins/listing-decisions.json` |
| Asset identity, lifecycle, and lifecycle review | `shared/data/stablecoins/coins/<id>.json` |
| Decision and lifecycle validation | `scripts/ci/check-stablecoin-data.ts` |

`listing-decisions.json` is intentionally compact. It contains only `schemaVersion`, `policyVersion`, and an exhaustive `listingClassById` map. Every catalog ID has one row. When a formerly tracked asset is removed to the cemetery, its row remains as `excluded` so the historical scope decision is not silently erased; the stablecoin-data guard accepts such extra rows only when the ID exists in `shared/data/dead-stablecoins.json`. Lifecycle is otherwise catalog metadata, not duplicated in the class ledger. `priceBasis` and `exitMechanism` are authored only on sourced delisted records to preserve the evidence for their removal; Pharos does not infer or store those fields for active assets.

Provider membership is discovery evidence, not an admission decision. A CoinGecko category, DefiLlama row, symbol, name, or nominal price never proves that an asset belongs in Pharos.

## Policy 2.0 Revision (Effective 2026-11-25)

Effective **2026-11-25** (UTC; single date authority `CORE_STABLECOIN_AGGREGATE_V2_CUTOVER_DATE`), Listing Policy 2.0 replaces the mechanical `navToken`/`tbill` → `cash-equivalent` rule with an authored fixed-par, non-fund instrument test, retires `cash-equivalent` and `stable-value-investment`, introduces `tokenized-fund` and `review-hold`, delists non-linked investment funds and NAV-priced investment claims in place, and switches core monetary aggregates from `core-stablecoins-v1` to `core-stablecoins-v2`.

- **Cutover and history:** Published history is never restated. Pre-cutover series and replays retain frozen `core-stablecoins-v1` membership (`shared/data/stablecoins/core-aggregate-v1-members.json`), cross-boundary market comparisons and headline 7d/30d supply deltas are withheld across the cutover, and headline supply charts mark the step with a reference line and neutral note.
- **Fund surfaces:** Active `tokenized-fund` listings are excluded from the default screener, homepage headline totals, rankings, and Safety Score leaderboards. They remain browsable via the dedicated Tokenized Funds filter and profile surfaces with a "Not a stablecoin" badge and a fund panel (holdings, NAV source, redemption terms, investor eligibility) in place of a Safety Score letter grade.

## Listing Classes

Under Policy 2.0, an asset qualifies as `core-stablecoin` only if it passes two tests:

1. **Fixed par:** The unit is designed to stay worth one unit of a currency or a fixed weight of a precious metal, with any yield paid as additional units (rebasing or distributions) or through a separate wrapper token — never through a rising unit price set by the NAV or valuation of a pool. Fixed-$1 debt claims (such as YLDS and STBT) pass; NAV-accreting debt certificates, ETF trackers, and pool/vault shares whose unit value floats with portfolio valuation do not.
2. **Not a fund share or exchange earn product:** Shares in investment funds (such as BUIDL, even when targeting a $1 NAV) and exchange earn products (an exchange-captive yield balance redeemable only inside a single exchange account ecosystem rather than an open transferable monetary claim, such as Gate GUSD) do not qualify.

Investor gating (KYC, allowlists, accredited-investor, qualified-purchaser, or transfer restrictions) never decides listing class or admission and is reflected only in exit and accessibility scoring.

The listing class separates the research catalog from the core monetary aggregate. Policy 2.0 retires `cash-equivalent` and `stable-value-investment`: `core-stablecoin` versus `tokenized-fund` is an authored instrument decision in `listing-decisions.json`, not derived mechanically from `flags.navToken` or `mechanismArchetype`. `flags.navToken` remains a pricing flag only.

| Class | Inclusion test | Aggregate and scoring treatment |
| --- | --- | --- |
| `core-stablecoin` | A fixed-par money claim (including fixed-$1 debt claims) that is not a tracked variant, an investment-fund share, or an exchange earn product | Included in the core monetary aggregate while active (`CORE_AGGREGATE_LISTING_CLASSES` contains only `core-stablecoin`) |
| `stablecoin-variant` | A direct tracked child with `variantOf` and `variantKind` | Tracked and analyzed, but excluded from parent-inclusive aggregate totals to prevent double counting |
| `tokenized-fund` | An investment-fund share or other NAV-priced investment claim retained in the active catalog because at least one active non-fund stablecoin links it as reserve or collateral backing | Tracked outside core monetary aggregates with no Safety Score letter grade (fund holdings, NAV source, redemption terms, and investor eligibility remain visible and continue feeding downstream dependency scoring) |
| `review-hold` | A non-delisted, non-variant asset with `mechanismArchetype: null` and a valid unresolved `mechanismArchetypeReview` | Tracked and monitored while exact-product qualification is pending, but excluded from core monetary aggregates |
| `excluded` | Fails the scope or instrument tests (including delisted unlinked funds, NAV-priced investment claims, and exchange earn products) | Historical record only; never active |

An accreting vault or strategy share whose deposit and exit asset is a single tracked stablecoin (`variantOf` + `variantKind`) stays a `stablecoin-variant` of that parent and remains outside core totals; an accreting share with no tracked parent is evaluated under the instrument test as a fund or NAV claim. The listing class stored on a `frozen` or `quarantined` row reflects its classification at review and is re-tested under current instrument and link rules upon any reactivation.

Class precedence follows the guard's branches: delisted → `excluded`; `variantOf` → `stablecoin-variant`; unresolved mechanism review with `mechanismArchetype: null` → `review-hold`; otherwise the authored class in `listing-decisions.json` must be `core-stablecoin` or `tokenized-fund`. `npm run check:stablecoin-data` enforces catalog coverage, `policyVersion: "2.0"`, and this order.

An unresolved mechanism review preserves delisted and variant invariants before applying `review-hold`; `flags.navToken` does not override the hold. Remaining unresolved mechanisms require `review-hold` so the currently authored class cannot validate itself or promote an unresolved asset into core aggregates. `review-hold` carries no schema-enforced `reviewBy` deadline; the unresolved review lives in `mechanismArchetypeReview` on `shared/data/stablecoins/coins/<id>.json` (`disposition: "unresolved"`, dated `reviewedAt`, `reviewer`, `rationale`, and `sources` with `mechanismArchetype: null`), and the listing is re-decided into an authored `core-stablecoin`/`tokenized-fund` classification or moved to `delisted` when that mechanism review resolves. R25 rcUSD is held on that basis pending exact-product reserve and holder-claim qualification.

### Tokenized Fund Retention

An investment-fund share or NAV-priced investment claim stays active as `tokenized-fund` only while linked by at least one active non-fund asset (`core-stablecoin`, `stablecoin-variant`, or `review-hold`).

- **What counts as a link:** An explicit canonical `id` reference from an active non-fund asset in (1) coin `dependencies`, (2) reserves sidecar `reserves[].coinId`, (3) `dependencyReview.relationships`, or (4) a live reserve adapter's `coinId` mapping (such as Falcon USDf's live adapter mapping for JAAA and JTRSY). There is no materiality floor. `reserveReview.nonLinkDispositions` (including `candidateCoinIds`) and unlabelled reserve slices without a `coinId` do not count as links.
- **Maintenance and delisting:** `npm run check:stablecoin-data` warns if an active `tokenized-fund` has no static non-fund linker outside the guard's explicit reviewed live-adapter-only list. When an active `tokenized-fund` loses its last qualifying link from active non-fund assets, it is delisted in place at the next review (`status: "delisted"`, class `excluded`).
- **Reactivation and re-admission:** Reactivating a quarantined `tokenized-fund` or re-admitting a previously delisted fund as `tokenized-fund` requires a qualifying link from an active non-fund asset plus normal runtime admission checks; it does not require proof that the fund's underlying instrument changed.

## Instrument Eligibility

An in-scope stablecoin must make a fixed-par monetary claim (one unit of a currency or a fixed weight of a metal) that users can test through an ordinary transfer, trade, or redemption. Investment-fund shares and other NAV-priced investment claims are out of scope unless retained as `tokenized-fund` under [Tokenized Fund Retention](#tokenized-fund-retention). Every admitted asset must also have a distinct, verifiable identity and enough public evidence to explain the issuer, backing, peg or valuation mechanism, and holder exit.

Before active admission or pre-launch promotion, reviewers must demonstrate a fetchable current price and a positive circulating-supply or market-cap path for the exact asset. The research packet records both sources and observations; catalog validation separately checks that the metadata identifies a supported live-data path. A filled profile or static page alone does not establish admission, and a listing or promotion also needs the committed Safety Score admission receipt enforced by `npm run check:new-asset-evidence-packet` ([addition procedure](https://github.com/TokenBrice/pharos-watch/blob/main/docs/process/adding-a-stablecoin.md)).

The following are out of scope:

- investment-fund shares, NAV-priced debt certificates or vault shares, ETF trackers, and ordinary equity, credit, or commodity interests — except active `tokenized-fund` rows retained solely under [Tokenized Fund Retention](#tokenized-fund-retention)
- exchange earn products whose claim is redeemable only inside a single exchange account ecosystem rather than as an open monetary claim
- non-withdrawable exchange account balances, reward balances, points, or internal credits
- permissioned, deal-specific notes or receivables whose displayed unit value is contractual accounting par rather than a transferable monetary price
- instruments whose only holder exit is issuer discretion or a private bilateral process
- duplicate wrappers or provider aliases that do not represent a distinct holder instrument
- assets admitted only because an aggregator categorized them as a stablecoin
- assets that require an open-ended manual supply patch or fabricated par price

Small supply is a review signal, not an automatic exclusion. A missing live price caused by a known pricing-pipeline gap does not by itself remove an otherwise valid asset, and a genuine depeg must remain monitored rather than being hidden through lifecycle state. Persistent absence of any positive circulating-supply or market-cap path is a quarantine condition because the asset cannot participate honestly in market-size and coverage calculations.

## Price And Exit Evidence

When a reviewed delisting depends on price or exit semantics, its catalog row records the sourced evidence:

| `priceBasis` | Meaning |
| --- | --- |
| `contractual-par` | The displayed value is a term, accounting convention, or issuer promise rather than an observed executable market or ordinary redemption price. |

| `exitMechanism` | Meaning |
| --- | --- |
| `ordinary-redemption` | Published terms describe a repeatable redemption or conversion path, but the instrument still fails another scope test. |
| `discretionary` | Exit depends on issuer approval, private placement terms, or an uncommitted bilateral process. |

A positive number is not sufficient when its semantics are wrong. Contractual par must not be published as a live market price. A symbol-level DEX search, unmatched contract quote, stale provider cache, or unrelated same-symbol asset also fails the identity and price tests.

## Lifecycle Policy

| Status | Meaning | Live collection and aggregates | Public treatment |
| --- | --- | --- | --- |
| `pre-launch` | Announced or researched, not yet admitted | Excluded | Upcoming profile |
| `pre-launch` with `launchPhase: "launched"` | Publicly issued on-chain, but no admitted price or supply lane yet | Excluded | "Launched – awaiting data" profile with launch date, missing lane and review date; listed apart from upcoming coins |
| `active` or omitted | Admitted to live monitoring (in-scope stablecoin, variant, review-hold, or dependency-linked `tokenized-fund`) | Included according to listing class | Live profile and eligible active surfaces |
| `quarantined` | Temporarily withheld because no positive circulating-supply or market-cap path can currently be established | Excluded immediately | Read-only profile with reason and review date |
| `delisted` | Reviewed as outside listing scope (or an unlinked investment fund) | Excluded permanently unless the instrument changes or a fund gains a qualifying active-stablecoin link | Read-only profile with reason and source |
| `frozen` | Previously active instrument has ended or failed and is archived | Excluded | Archived profile and cemetery record |

Only active rows enter ordinary live producers and score recomputation. Quarantined and delisted records keep static detail pages but are excluded from the screener, compare, aggregates, alerts and ordinary provider refreshes. A separately reviewed reserve-only supply prerequisite may use bounded recovery without changing that lifecycle or the active producer/generation census.

Quarantine is operational, not punitive. A quarantine review records `changedAt`, a concrete reason, and `reviewBy`. The review date creates an explicit manual follow-up; extensions require another dated review. Reactivation requires a positive supply or market-cap path, the normal active-admission checks, and a new lifecycle review. Missing price coverage alone is worked as a pricing issue while the asset remains active. From `reviewBy`, `check:stablecoin-data` warns without failing.

`launched` means public on-chain issuance only; a pilot, closed-loop platform or private beta stays in an earlier phase. The phase is display policy, not admission: the row stays pre-launch, contributes nothing to collection, aggregates or scores, and its missing figures read as unavailable, never zero. The schema requires `launchDate`, a sourced milestone dated from the launch onward, and a `listingStatusReview` with `reviewBy` inside `LAUNCHED_PHASE_MAX_DWELL_DAYS` (60) of `changedAt`; authors set `changedAt` to the entry day and name the missing lane (price, supply or scope) in `reason`. By `reviewBy` the row needs a decision: promotion through the normal admission checks, a listing decision, or a new dated review that extends the dwell. Past `reviewBy`, `check:stablecoin-data` warns without failing. The Telegram channel digest announces the coin only at promotion to active, not on entry to `launched`.

Reserve-only bootstrap or staged capture never authorizes listing. Expiry/removal fails closed without resetting consumed attempts or refreshing retained evidence. Re-admission still requires reviewed legal/native-share identity and amount encoding, matched and current supply/reserve/NAV observations within the source's freshness, block-skew and reconciliation gates, a runtime price/market-cap PASS and an explicit lifecycle review. Class assets are not circulating market cap, reserve allocation or executable capacity.

An expired authored bootstrap field fails `check:stablecoin-data` until removed or explicitly re-authorized from reviewed source evidence. Recovery exposes `supplyAdmissionBootstrapExpired` IDs even under producer-priority or lease deferral. These diagnostics withhold expired authorization; they do not reopen collection, reset a consumed fingerprint or approve listing.

A missing live price does not by itself move an active asset to quarantine or delist, and it is never papered over with a substitute quote. When every admissible price lane is empty and the asset's lifecycle is otherwise sound, the gap may instead carry a reviewed price-gap acknowledgement (`STABLECOIN_PRICE_GAP_REVIEWS` in `worker/src/lib/stablecoin-publication-reviews.ts`): a dated registry entry naming an owner, a concrete reason, at least one public `https` source, and an expiry no more than roughly 30 days after the review. An acknowledged gap stays published as missing — missing counts, affected market-cap exposure, and per-asset rejection detail are unchanged — but it stops producing public health warnings and admin warning causes. Renewal requires a fresh review with new evidence; expiry is automatic, so the gap alerts again until the asset is re-sourced, frozen, or delisted. Acknowledgement never applies to a depeg, never applies to an asset that already has a price, and never substitutes for the lifecycle disposition, which keeps its own dated review.

Delist when the instrument itself fails scope — including investment-fund shares and NAV-priced investment claims with no qualifying link from an active non-fund stablecoin, exchange earn products, account-only balances, private contractual-par notes, misleading provider artifacts, or assets without a meaningful transferable or redemption claim. A delisted record requires a dated reason and public source.

An out-of-scope pre-launch row follows the same delisting path: retain its sourced catalog record and read-only profile, change its listing class to `excluded`, and remove it from upcoming surfaces. The retained profile preserves its canonical URL.

Freeze only a previously active tracked instrument (stablecoin, variant, or retained tokenized fund) that has effectively ended or failed and whose historical market record belongs in the cemetery. Record the freeze date and sourced obituary, preserve its identity and historical data as a read-only archive, and remove it from live collection and aggregates.

## Ongoing Runtime Review

The active-admission gate is run for additions and promotions and can be repeated when runtime coverage is in doubt. It records the accepted path in the asset research packet:

- a verified provider or exact-contract identity
- a supported current-price path
- a positive circulating-supply or market-cap path
- the metadata needed by that path
- unresolved risks or follow-up work

An incumbent with a price-pipeline failure remains active while the failure is investigated. An incumbent with no defensible positive supply or market-cap path moves to quarantine. An asset whose instrument semantics fail scope moves to delisted. This separates repairable pricing work from catalog-quality decisions without suppressing genuine market stress.

## Re-Admission

Re-admission of a delisted stablecoin is exceptional. It requires new evidence that the instrument changed, not merely that a provider relisted it. The sole exception is dependency-driven re-admission of a previously delisted investment fund under [Tokenized Fund Retention](#tokenized-fund-retention), which admits the fund as `tokenized-fund` (outside core aggregates and Safety Score grades) when an active non-fund stablecoin establishes a qualifying link and normal runtime admission checks pass. In both cases, the reviewed change updates the catalog lifecycle and listing class together so historical scope decisions and active publication cannot disagree.

The recorded application is the 2026-09-29 `sofid-sofi` re-admission. The 2026-07 quarantine reason — no positive market cap on any permitted source — no longer held: CoinGecko `sofiusd` began publishing a positive price and market cap (0.999461 USD and ≈328.75M USD cap with ≈12.3M USD daily volume, observed 2026-09-29), DefiLlama carries the asset (`llamaId = 430`, ≈328.81M `peggedUSD`), and the tracked deployments corroborate the circulating figure (Ethereum `totalSupply` 100,077,224 plus Solana mint supply 228,886,850.23 = 328,964,074.23). Publication binds DefiLlama list supply (`llamaId: "430"`) while CoinGecko remains the detail/price provider (`geckoId: sofiusd`), so no curated on-chain aggregate is admitted; SoFiUSD has no nominal-par override and its price comes from ordinary admitted consensus (see [Pricing Pipeline](./pricing-pipeline.md)).

The 2026-10-17 `vgbp-vnx` re-admission was reviewed by **Pharos VNX correction review (issue #1462)**. The July 19 quarantine reason, no positive DefiLlama supply, no longer held: the [DefiLlama list](https://stablecoins.llama.fi/stablecoins?includePrices=true) returned a VGBP price of $1.336434261082036 and positive USD-denominated circulating value of $169,186.18 at 09:17 UTC on October 17. The [detail endpoint](https://stablecoins.llama.fi/stablecoin/292) identified the tracked Solana mint and showed 126,595.21 GBP across Solana, Celo, and Base, with zero Ethereum supply. This closely reconciles to the 126,595.48 GBP of liabilities in the [Apex August 2026 attestation](https://vnx.io/reports/vnx-attestation-report-2026-08-31.pdf). The instrument also changed: current [issuer terms](https://prod-global-terms.s3.sa-east-1.amazonaws.com/VNX-Global-Terms.pdf) identify Bermuda-licensed VNX Global Ltd., replacing the historical VNX Commodities AG structure, and [monthly ISAE 3000 reasonable-assurance reports](https://vnx.gitbook.io/vnx-global/transparency/audits) now identify currency-matched GBP cash at Bermuda Commercial Bank. VGBP returns to active monitoring through the ordinary DefiLlama path (`llamaId: "292"`, `detailProvider: "defillama"`); the existing `core-stablecoin` class remains appropriate. No manual supply override or untracked Ethereum deployment was added.

The 2026-10-30 `busd0-usual` re-admission was reviewed by **Pharos runtime gate review**. The July 15 quarantine reason — no positive circulating supply or market cap on a permitted source — no longer held: [CoinGecko `usd0-liquid-bond`](https://www.coingecko.com/en/coins/usd0-liquid-bond) returned a $0.977576 price and $500,391,103 market cap at 17:32 UTC on October 30 2026 (`last_updated_at` 2026-10-30T17:32:55Z, 511,850,589.57 bUSD0), and the [DefiLlama contract quote](https://coins.llama.fi/prices/current/ethereum:0x35d8949372d46b7a3d5a56006ae77b215fc69bc0) for the tracked Ethereum deployment returned $0.977636 at 0.99 confidence the same day. bUSD0 returns to active monitoring through CoinGecko detail admission (`geckoId: "usd0-liquid-bond"`); the existing `stablecoin-variant` class and `variantOf: "usd0-usual"` relationship remain appropriate. No manual supply override was added.

The catalog owner's 2026-11-16 ruling returns `usd-dinari` to the catalog as a launched-awaiting-data pre-launch row, pending the Safety Score new-asset evidence gate. Removal commit [0762ffa914](https://github.com/TokenBrice/pharos-watch/commit/0762ffa9144618d1b4afd74f7a8643578e02ab65) on March 10 recorded no reason; no failure rationale is inferred. [Dinari's February 6, 2024 announcement](https://dinari.com/blog/usd-stusd-yield-bearing-stablecoin) establishes public Ethereum issuance of the instrument before its current replacement deployments. The [issuer's deployment table](https://docs.dinari.com/docs/usdplus-evm) identifies the current token on Ethereum, Arbitrum, Base and Plume. The [DefiLlama list](https://stablecoins.llama.fi/stablecoins?includePrices=true) and [detail endpoint](https://stablecoins.llama.fi/stablecoin/465), observed November 15 at 23:22 UTC, pass the price and supply lanes through `llamaId: "465"`. Active admission remains blocked by 17 own open questions and the unresolved Mint Authority control inventory across all four chains. Promotion requires current deployed source/ABI, pinned evidence closing mint, rate, limit, role, upgrade, facet and bypass paths, resolution of the remaining non-documentation Safety questions, and a passing admission receipt after the final coin edit. The listing review is due January 15, 2027. The canonical profile and legacy `cg-dinari-usd` alias return to the catalog; the row remains outside active collection, aggregates and scoring.

## Change Procedure

For an addition or promotion:

1. Apply the instrument and class tests before editing the catalog.
2. Add the catalog row and its `listingClassById` entry.
3. Record a passing runtime price and market-cap path in the research packet.
4. Regenerate catalog projections.
5. Run `npm run check:stablecoin-data` and the focused tests named by the addition procedure.

For quarantine or delisting:

1. Change the catalog lifecycle with the required review metadata.
2. For delisting, classify the row as `excluded` and retain sourced price/exit evidence when it explains the decision.
3. Regenerate catalog projections and verify active surfaces no longer include the ID.
4. Preserve canonical URLs and legacy ID redirects for historical readability.
5. Run `npm run check:stablecoin-data` and focused lifecycle tests.

For a full cemetery removal authorized by the lifecycle owner, remove the catalog source and its active-universe projections, add the cemetery record, and retain the prior listing ID as `excluded`. This keeps the scope decision auditable even though the asset is no longer part of the tracked catalog.

A curated cemetery record in `shared/data/dead-stablecoins.json` follows the cemetery's owner-approved rules:

- **Inclusion.** A new record needs a public market and a primary public source that documents its failure or discontinuation (an issuer or protocol announcement, governance record, official docs or status page, regulator, court or registry filing, or on-chain record); reputable press may be linked only when it documents the same event, and market-data listings, provider "ended" markers, launch or fundraising articles and general wikis never qualify. There is no size floor; peak market cap is recorded when known. Older archive records do not all meet this stricter bar: each links a public source, but some link the best available context for a coin that faded without an announcement. The archive as a whole must not be described as primary-source evidence.
- **Primary cause.** Each record carries one primary cause: the root reason the coin failed or its issuance and operation ended, whether or not it lost its peg. Triggers such as runs, exploits or orders are described in the obituary.

Every new curated record carries `recordedAt`, the UTC `YYYY-MM-DD` date on which it entered Pharos (not the death date), and a `mechanismArchetype` describing how the coin was designed to hold its peg. Retain a stable identity, sourced obituary and valid death date; omit peak market cap when reliable evidence is unavailable rather than recording zero.

For a new asset, complete identity and source research, classify its instrument and lifecycle, pass the active-admission gate when applicable, and record each editorial or downstream-coverage decision or intentional gap. Update the catalog and listing decision together, regenerate their derived artifacts, validate the resulting lifecycle and live-data coverage, and verify the deployed public surfaces.
