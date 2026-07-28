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

## Listing Classes

The listing class separates the research catalog from the core monetary aggregate.

| Class | Inclusion test | Aggregate treatment |
| --- | --- | --- |
| `core-stablecoin` | A transferable stable-value monetary instrument that is not a tracked variant, NAV/fund cash equivalent, or credit investment | Included in the core aggregate while active |
| `cash-equivalent` | A non-variant with `flags.navToken === true`, or a non-variant classified as `mechanismArchetype: "tbill"` | Included in the core aggregate while active, with NAV-aware pricing |
| `stablecoin-variant` | A direct tracked child with `variantOf` and `variantKind` | Tracked and analyzed, but excluded from parent-inclusive aggregate totals to prevent double counting |
| `stable-value-investment` | A non-variant classified as `mechanismArchetype: "rwa-credit-fund"` | Tracked on its separate investment surface, excluded from the core monetary aggregate |
| `excluded` | Fails the scope or instrument tests | Historical record only; never active |

Class precedence is deterministic: `excluded`, then `stablecoin-variant`, then `stable-value-investment`, then `cash-equivalent`, then the residual `core-stablecoin` class. `npm run check:stablecoin-data` enforces exact catalog coverage and this precedence.

## Instrument Eligibility

An in-scope asset must make a stable-value claim that users can test through an ordinary transfer, trade, redemption, or modeled NAV path. It must also have a distinct, verifiable identity and enough public evidence to explain the issuer, backing, peg mechanism, and holder exit.

Active additions and pre-launch promotions must pass the existing runtime price and market-cap gate documented in [Adding a Stablecoin](./process/adding-a-stablecoin.md#1a-hard-runtime-data-gate-for-active-assets). The research packet must identify an accepted price path and a positive circulating-supply or market-cap path. The static catalog check also verifies that active metadata identifies a supported cache-admission path. These checks are process and code invariants; there is no separate admission-receipt registry.

The following are out of scope:

- non-withdrawable exchange account balances, reward balances, points, or internal credits
- permissioned, deal-specific notes or receivables whose displayed unit value is contractual accounting par rather than a transferable monetary price
- instruments whose only holder exit is issuer discretion or a private bilateral process
- ordinary equity, credit, commodity, or fund interests with no modeled stable monetary or cash-equivalent reference
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
| `active` or omitted | In scope and admitted to live monitoring | Included according to listing class | Live profile and eligible active surfaces |
| `quarantined` | Temporarily withheld because no positive circulating-supply or market-cap path can currently be established | Excluded immediately | Read-only profile with reason and review date |
| `delisted` | Reviewed as outside listing scope | Excluded permanently unless a new scope decision is approved | Read-only profile with reason and source |
| `frozen` | Previously active instrument has ended or failed and is archived | Excluded | Archived profile and cemetery record |

Quarantine is operational, not punitive. A quarantine review records `changedAt`, a concrete reason, and `reviewBy`. The review date creates an explicit manual follow-up; extensions require another dated review. Reactivation requires a positive supply or market-cap path, the normal active-admission checks, and a new lifecycle review. Missing price coverage alone is worked as a pricing issue while the asset remains active.

Delist when the instrument itself fails scope, including account-only balances, private contractual-par notes, misleading provider artifacts, or assets without a meaningful transferable or redemption claim. A delisted record requires a dated reason and public source.

Freeze only a previously active stablecoin that has effectively ended or failed and whose historical market record belongs in the cemetery. [Freezing a Tracked Stablecoin](./freezing-stablecoins.md) owns that procedure.

## Ongoing Runtime Review

The active-admission gate is run for additions and promotions and can be repeated when runtime coverage is in doubt. It records the accepted path in the asset research packet:

- a verified provider or exact-contract identity
- a supported current-price path
- a positive circulating-supply or market-cap path
- the metadata needed by that path
- unresolved risks or follow-up work

An incumbent with a price-pipeline failure remains active while the failure is investigated. An incumbent with no defensible positive supply or market-cap path moves to quarantine. An asset whose instrument semantics fail scope moves to delisted. This separates repairable pricing work from catalog-quality decisions without suppressing genuine market stress.

## Re-Admission

Re-admission is exceptional. It requires new evidence that the instrument changed, not merely that a provider relisted it. The same reviewed change updates the catalog lifecycle and listing class so historical scope decisions and active publication cannot disagree.

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

The complete implementation procedure for new assets is [Adding a Stablecoin](./process/adding-a-stablecoin.md). Catalog structure and generated artifacts are documented in [Stablecoin Data Registry](./stablecoin-data.md).
