# Classification System, Peg Handling & Gold Stablecoins

## Stablecoin Classification System

Each tracked stablecoin is defined in the checked-in per-coin data assets under `shared/data/stablecoins/coins/*.json`, loaded through `shared/lib/stablecoins/registry.ts` from the generated `shared/data/stablecoins/coins.generated.json` aggregate, and validated by `shared/lib/stablecoins/schema.ts` at generation/test time. Import stablecoin helpers from their explicit submodules; use the registry module for the complete catalog and explicit lifecycle splits. Each entry carries these flags:

### Type (governance field internally)

Three-tier system reflecting actual dependency on centralized infrastructure:

| Tier                    | Label    | Meaning                                                                                                               | Examples                                 |
| ----------------------- | -------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `centralized`           | CeFi     | Fully centralized issuer, custody, and redemption                                                                     | USDT, USDC, PYUSD, FDUSD                 |
| `centralized-dependent` | CeFi-Dep | Decentralized governance/mechanics but depends on centralized custody, off-chain collateral, or centralized exchanges | DAI, USDS, USDe, GHO, FRAX, crvUSD, sUSD |
| `decentralized`         | DeFi     | Fully on-chain collateral, no centralized custody dependency                                                          | LUSD, BOLD                               |

The key distinction for `centralized-dependent`: these protocols may have on-chain governance and smart contract mechanics, but they ultimately rely on off-chain t-bill deposits, centralized exchange positions (delta-neutral), or significant USDC/USDT collateral. Calling them "decentralized" would be misleading. For example, crvUSD's peg keepers use centralized stablecoins (USDC, USDT, USDP), and sUSD V3 added USDC as core collateral on Base.

### Backing

| Value           | Meaning                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rwa-backed`    | Backed by real-world assets (fiat reserves, treasuries, gold)                                                                                                       |
| `crypto-backed` | Backed by on-chain crypto collateral                                                                                                                                |
| `algorithmic`   | Legacy / shadow-only — still a valid `BACKING_TYPE_VALUES` member but no longer assigned to any tracked coin; retained only for PSI shadow assets (see prose below) |

Active Pharos taxonomy no longer exposes `algorithmic` as a standalone backing bucket. Coins with programmatic peg controls are classified by their actual collateral base instead. Historical shadow assets kept only for PSI continuity can still carry legacy `algorithmic` metadata.

### Peg Currency

`PEG_CURRENCY_VALUES` in `shared/types/core.ts` is the runtime authority. It covers the tracked fiat pegs (including COP, CLP, GHS, KES, and PEN), `GOLD`, `SILVER`, `VAR` (variable/CPI-linked), and `OTHER`; do not maintain a second literal enum here.

### Boolean Flags

- `yieldBearing` — token itself accrues yield (e.g., USDY, USDe, BUIDL)
- `rwa` — backed by real-world assets like treasuries/bonds (distinct from `rwa-backed` which also includes plain fiat reserves)
- `navToken` — price appreciates over time as yield accrues (USYC, USDY, TBILL, YLDS). Excluded from peg deviation metrics; table shows "NAV" instead of bps. Also used for CPI-indexed tokens (FPI) — table shows "CPI" for VAR-pegged navTokens

### Listing Class And Lifecycle

`shared/data/stablecoins/listing-decisions.json` assigns exactly one class to every catalog ID: `core-stablecoin`, `cash-equivalent`, `stablecoin-variant`, `stable-value-investment`, or `excluded`. The compact ledger stores only that class mapping. Class precedence is `excluded`, variant metadata, `rwa-credit-fund`, NAV/t-bill cash equivalent, then residual core stablecoin. Aggregate helpers include active core and cash-equivalent rows, exclude variants from parent-inclusive totals, and report stable-value investments separately.

Lifecycle remains on the per-coin catalog row: active or omitted, `pre-launch`, `quarantined`, `delisted`, or `frozen`. Only active rows enter live producers and score recomputation. Quarantined and delisted records keep static detail pages but are excluded from the screener, compare, aggregates, alerts, and new provider refreshes. See [Stablecoin Listing Policy](./listing-policy.md) for eligibility and review rules.

### Additional Metadata

Key fields on `StablecoinMeta` (see `shared/types/core.ts` plus `shared/types/stablecoin-meta-schemas.ts` for the typed/schema source):

- `id: string` — stablecoin ID in canonical ticker-issuer format (e.g., `"usdt-tether"`, `"usdc-circle"`)
- `llamaId?: string` — DefiLlama numeric stablecoin ID for `stablecoins.llama.fi` calls when internal IDs diverge
- `detailProvider?: "defillama" | "coingecko" | "commodity"` — explicit detail data source selector (migration field replacing ID-prefix heuristics)
- `marketAvailability?: "market-traded" | "limited-trading" | "non-traded-utility" | "legacy-or-wind-down"` — descriptive availability label for issuer/regulatory coverage audits; currently used to preserve eurostablecoins.xyz market-status distinctions for EUR stablecoins without changing runtime cache admission
- `collateral?: string` — description of the collateral backing
- `pegMechanism?: string` — description of the peg maintenance mechanism
- `mechanismArchetype?: MechanismArchetype` — one of `"fiat-cash" | "tbill" | "cdp" | "synthetic-delta-neutral" | "algorithmic" | "rwa-credit-fund" | "commodity-claim"` (defined in `shared/types/core.ts`). When set, the coin detail page renders an SVG mechanism diagram in `KeyInfoCard` plus a "Learn how X stablecoins work" link to the matching `/learn/mechanisms/<slug>/` explainer. Slug helpers live in `shared/lib/classification/mechanism-archetypes.ts`; the dedicated explainer route contract is [learn-mechanisms-page.md](./learn-mechanisms-page.md).
- `mechanismArchetypeReview?: MechanismArchetypeReview` — sourced base-metadata review with a `resolved` or `unresolved` disposition, reviewer, review date, rationale, and sources. A reviewed unresolved row deliberately blocks v9 classification instead of silently guessing an archetype.
- `implementationLaunchDate?: string` — launch boundary for the currently deployed mechanism when it materially differs from the product's `launchDate`. The same fuzzy formats are supported, but track-record consumers use the latest possible date in the stated period as a conservative age lower bound.
- `archetypeOverride?: boolean` — when `true`, this coin's `mechanismArchetype` is an intentional, sourced departure from its parent variant's archetype. Redundant same-archetype overrides are invalid.
- `commodityOunces?: number` — troy ounces per token (for gold- and silver-pegged stablecoins)
- `geckoId?: string` — CoinGecko coin ID for price/mcap lookups (commodity and non-DefiLlama tokens)
- `cmcSlug?: string` — CoinMarketCap slug for fallback price lookups
- `protocolSlug?: string` — DefiLlama protocol slug for TVL/mcap data (commodity tokens)
- `proofOfReserves?: ProofOfReserves` — proof configuration plus an optional sourced `latestReport` that distinguishes assurance method, assets-only versus assets-and-liabilities scope, and liability reconciliation
- `links?: StablecoinLink[]` — external links (website, docs, twitter)
- `jurisdiction?: Jurisdiction` — regulatory jurisdiction
- `mica?: MicaProfile` — EU MiCA authorization status, EMT/ART token type, competent authority, issuer entity, significance flag, and sourced register/reference links. See [mica-tracker.md](./mica-tracker.md).
- `genius?: GeniusProfile` — U.S. GENIUS Act implementation-watch posture: applicability, authorization status, issuer pathway, regulator fields, reserve/redemption disclosure presence, negative-evidence review, reviewer metadata, and source references. See [compliance-page.md](./compliance-page.md).
- `contracts?: ContractDeployment[]` — on-chain contract addresses per chain
- `dependencies?: DependencyWeight[]` — upstream stablecoin dependencies (for report cards)
- `dependencyReview?: DependencyReview` — sourced review required for manual-only dependency relationships that reserve composition cannot express; reviewed relationships must exactly match those authored edges
- `blacklistabilityReview?: BlacklistabilityReview` — required for every tracked asset and the canonical source of its reviewed `true`, `false`, `"possible"`, or `"inherited"` freeze/blacklist status, evidence, reviewer, and review date
- `collateralQuality? / custodyModel?` — reviewed resilience and custody fields used by live Selector constraints and DDR depeg-duration verdicts
- `governanceQuality?` — legacy metadata key displayed as **Control posture** on stablecoin detail pages. Its six values describe where operational authority sits (`immutable-code`, `dao-governance`, `multisig`, `regulated-entity`, `single-entity`, or `wrapper`); the field is descriptive only and is not a Safety Score V9 input. Missing values remain hidden rather than rendering an inferred or unknown posture.
- `oracleRisk?: OracleRiskProfile` — reviewed CDP oracle / collateral price-feed setup, with optional review provenance and collateral-branch rows. Branch evidence can record feed provider/path/address/chain, heartbeat and staleness bounds, fallback behavior, observation block/date, collateral parameters, liquidation behavior, backstops, shutdown/bad-debt handling, and sources. Safety Score V9 compiles applicable branch evidence and unresolved applicability into typed Economic Control facts and gaps.
- `bridgeRouteRisk?: BridgeRouteRiskProfile` — reviewed cross-chain route setup, with route tier, summary, provenance, confidence, optional protocol evidence, sources, and deployment-level `routes[]`. Each route identifies its exact chain/contract representation, issuance/transfer semantics, reviewed tier, scope (`global`, `canonical`, `peripheral`, or `unknown`), and optional controller/failure-domain evidence. Routes that are liabilities against one shared lockbox may carry the same `representationId`; this binds an observed pooled lockbox balance to an exact reviewed member inventory without implying per-destination supply. Safety Score V9 combines these reviewed identities with bounded runtime materiality evidence and fails closed when a required route fact is unresolved.
- `infrastructures?: Infrastructure[]` — structured infrastructure-lineage list (`"liquity-v1"` / `"liquity-v2"` / `"m0"`) used for UI badges, cohort filters, and discovery hubs. An array so a coin can belong to more than one infrastructure simultaneously, though in practice each coin currently has zero or one entry.
- `variantOf?: string` / `variantKind?: VariantKind` — active-only parent-variant metadata for tracked pure wrappers, savings passthroughs, strategy vaults, risk-absorption legs, or bond-maturity products whose user expectation is still direct exposure to another tracked stablecoin. `VARIANT_KIND_VALUES` in `shared/types/core.ts` owns the exact enum.
- `pegReferenceId?: string` — id of the tracked stablecoin used as this coin's peg-deviation reference (drives severe active-depeg cap inheritance from a parent). For tracked variants it is invariant-bound to equal `variantOf` (enforced in `shared/lib/stablecoins/schema.ts` and `validate-variants.ts`)
- `reserves?: ReserveSlice[]` — reserve composition data; slices may add structured asset class, obligor, risk factors, liquidity horizon, or evidenced maximum maturity without encoding a score
- `reserveReview?: ReserveReview` — sourced, dated review of the reserve composition and its known unknown exposure; optional per-slice non-link dispositions are fingerprinted by current index and name and remain non-scoring until a real `coinId` is authored
- `custodyProfile?: CustodyProfile` — reviewed providers, optional sourced shares, legal safeguards, reuse posture, provenance, and uncertainty behind the current `custodyModel`; Safety Score V9 compiles applicable wrapper-custody evidence, while consistency checks remain advisory rather than auto-deriving a tier
- `yieldConfig?: YieldConfig` — yield intelligence configuration
- `pythFeedId?: string` — Pyth Network oracle feed ID (used for gold/commodity stablecoins)
- `tradedContracts?: ContractDeployment[]` — traded contract addresses separate from `contracts`
- `liveReservesConfig?: LiveReservesConfig` — live reserve sync configuration (see `docs/live-reserves.md`)
- `notices?: CoinNotice[]` — per-coin alert notices shown on detail pages
- `status?: "pre-launch" | "active" | "quarantined" | "delisted" | "frozen"` — lifecycle state; omitted rows are active
- `listingStatusReview?: ListingStatusReview` — dated reason and review provenance required for quarantined and delisted records; quarantined reviews also require `reviewBy`
- `priceBasis?: "contractual-par"` / `exitMechanism?: "ordinary-redemption" | "discretionary"` — sourced delisting evidence only; CI forbids these fields on non-delisted rows
- `frozenAt?: string` / `obituary?: StablecoinObituary` — freeze date and cemetery/detail-page obituary content required for frozen tracked coins
- `launchDate?`, `announcedDate?`, `expectedLaunchDate?`, `launchPhase?`, `launchPhaseDetail?`, `featuredContent?`, `milestones?`, `dateHistory?` — launch/upcoming timeline metadata for pre-launch and newly launched assets
- `pegScoreCoverage?` — reviewed lower bound for PegScore and recent-window observation. Author only after replay plus continuous live coverage has been audited; record the exact `startDate`, `reviewedAt`, optional `replayRunId`, and a note describing the verified boundary. It takes precedence over age-derived tracking anchors and must not imply coverage before the reviewed date.
- `mintAuthority?: MintAuthorityProfile` — reviewed mint/burn authority evidence compiled into Safety Score V9's Economic Control mint component and used by detail-page authority summaries; profiles can also carry structured upgradeability, active/resolved incident state, observation points, and reviewed common failure-domain keys
- `tags?: string[]` — freeform tag array for filtering and categorization

### Implementation Age Policy

`launchDate` remains the product or project launch. Author `implementationLaunchDate` only when a later deployed mechanism, relaunch, or critical implementation boundary makes the product date misleading. The field requires a sourced `mechanismArchetypeReview` and cannot unambiguously predate `launchDate` or its own review.

For `YYYY`, `YYYY-MM`, `YYYY-Qn`, and `YYYY-Hn`, track-record age uses the inclusive end of that period. When the period end is later than the fixed scoring `asOf` date, the `asOf` date is used, yielding zero claimed age for the unresolved part of the period. Tracked variants resolve effective implementation age from the newest required layer across the child and parent chain, with cycle detection; they do not blindly inherit either endpoint.

### Mint Authority Taxonomy

Mint Authority is a reviewed mint-control taxonomy. It focuses on who can create durable supply or alter minting paths through direct minters, minter admins, proxy/cap admins, facilitators, bridges, off-chain signer systems, governance, or wrapper inheritance. Since safety `9.1` the taxonomy has no score of its own: Safety Score V9 compiles the reviewed control evidence into the Economic Control pillar's mint component, and that component is the mint score every surface shows. Missing data produces explicit V9 evidence gaps and an `NR` mint state; it never implies safety.

Compact `mintAuthoritySummary` projections can appear in structural/user-facing tables, including `/coverage/`, the homepage stablecoin table, and `/screener/`. Those surfaces bucket the reviewed data into review-route labels (`No priv.`, `Governed`, `Multisig`, `Issuer`, `Bridge`, `Inherited`, `Unknown`), which describe which curation route an asset is on and carry no score. The mint score and band beside them are the published V9 mint component and its posture band.

Mint path labels:

| Value                           | Meaning                                                                                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `immutable-user-collateralized` | Users can mint only through immutable collateralized protocol rules; no privileged mint, cap, or upgrade path is resolved.                   |
| `user-collateralized-governed`  | Users mint through protocol mechanics, but governance/admins can alter collateral modules, debt ceilings, rates, or related mint parameters. |
| `issuer-direct-mint`            | Issuer/operator/minter can create durable supply directly, usually expected to be backed by off-chain reserves.                              |
| `permissioned-minter`           | On-chain minter roles, registries, or allowlists can mint within authorization.                                                              |
| `offchain-attested-minter`      | Minting depends on backend signatures, RFQ/order settlement, service roles, or off-chain validation.                                         |
| `facilitator-bucket-mint`       | Approved facilitators/minters can mint within bucket or route capacity.                                                                      |
| `amo-or-custodian-hybrid`       | AMOs, custodians, or strategy contracts can mint, move, or allocate supply under governance-defined constraints.                             |
| `bridge-or-oft-synthetic`       | Destination supply depends on bridge, OFT, lockbox, messenger, or attestation routes.                                                        |
| `m0-permissioned-minter`        | M0-specific approved minter/validator and extension-wrapper issuance semantics.                                                              |
| `wrapped-or-variant-inherited`  | Wrapper, staking, savings, or variant asset inherits authority from a parent plus wrapper mechanics.                                         |
| `unknown`                       | Not reviewed or insufficient evidence.                                                                                                       |

Authority posture labels are descriptive bands only: `none-resolved`, `none-resolved-mint`, `bounded-admin`, `partially-bounded-admin`, `unbounded-reconciled`, `concentrated-admin`, `unbounded-or-compromised`, and `unknown`. Do not color or rank these like report-card grades.

`unbounded-reconciled` ("Unbounded, supervised & reconciled") names economically unbounded minting that is reconciled against reserves or run under a supervisory regime. It renders in the same elevated tone as `concentrated-admin` and `unbounded-or-compromised`, and the depeg resolver treats it identically to them: the supervision is real, but the claim can still be expanded at will.

`none-resolved` and `none-resolved-mint` ("No privileged mint resolved" / "No privileged mint path") are the two *scopes* of one finding, and both render in the same minimized tone.

- `none-resolved` is whole-of-chain: no control anywhere on the mint path holds privileged ability of any kind — including upgrade or parameter authority — and a wrapper may only use it when its reviewed parent is also `none-resolved`.
- `none-resolved-mint` is mint-scoped: no control can mint or authorize minting on this asset, while other control domains may exist. Upgrade and parameter authority do not disqualify it, and it makes no claim about a wrapper's parent.

Safety Score V9 derives its mint posture mint-scoped, so a share wrapper over a governed parent derives `none-resolved` from facts the whole-of-chain curated value can never assert. `none-resolved-mint` is the annotation that states the same fact at the same scope. It is a benign posture: the depeg resolver treats it as neither fragile nor risky, and it does not earn the R1 non-inflatable-supply anchor, which stays reserved for whole-of-chain `none-resolved` and immutable user-collateralized mint paths.

Mint controls derive a stable controller identity from `chain + address`; EVM addresses are case-normalized while case-sensitive non-EVM addresses are preserved. `failureDomainKeys` are reserved for reviewed off-chain common modes that an address cannot express. `controllerAssetId` may identify the tracked native asset whose issuance system owns a reused controller. The V9 dependency evaluator uses that directionality to avoid making the controller's native asset depend on downstream products while keeping foreign products exposed to the shared controller; the field does not change the standalone Mint Authority Score. `upgradeability` records proxy model, implementation/admin addresses, mint-logic mutability, delay, observation point, sources, and the exact existing control label that owns an upgradeable path. `mintIncidents.status` is required; `resolvedAt` is optional for historical remediation and forbidden on an active incident.

### Infrastructure Tagging

Pharos supports a small structured infrastructure layer for shared technical foundations that users may want to recognize across multiple issuers or forks.

Current support:

- `infrastructures: ["liquity-v1"]` &mdash; classic LUSD-style Liquity v1 forks
- `infrastructures: ["liquity-v2"]` &mdash; BOLD-style Liquity v2 forks
- `infrastructures: ["m0"]` &mdash; coins built on the M0 issuance platform

This is intentionally narrower than the general classification system:

- use `infrastructures` for concrete shared-foundation cohorts that deserve dedicated badges, filters, and discovery pages
- keep `tags` for loose editorial labels that do not need first-class routing or filtering semantics

**Liquity v1** is the classic LUSD-style pattern:

- 110% liquidation threshold / minimum collateral ratio
- Stability Pool liquidation path
- no ongoing borrower interest
- forks share source code with the upstream Liquity codebase but operate independently with their own reserves

**Liquity v2** is the BOLD-style pattern:

- user-set borrower rates
- Stability Pools
- Liquity-style redemptions across branch-like collateral markets
- forks share source code with the upstream Liquity v2 codebase but operate independently

**M0** is an issuance-platform lineage rather than a code lineage:

- coins are built on M0's smart-contract rails (minter governance, the SwapFacility, the `MExtension.sol` contract pattern)
- M0 provides the issuance machinery; reserve composition is set by the issuer and **may or may not include the underlying $M token**
- some M0-built coins are simple $M wrappers; others manage diversified collateral via M0's infrastructure
- a governance issue at the M0 protocol level potentially affects every M0-built coin, even though their day-to-day operations and reserves are independent

The `infrastructures` field is an array because a coin could in principle belong to multiple infrastructures (e.g., a hypothetical Liquity v2 fork that also wraps M0); in practice every currently-tagged coin has exactly one entry.

### Bluechip Grade

`BluechipGrade` is a union type in `shared/types/core.ts`: `"A+" | "A" | "A-" | "B+" | "B" | "B-" | "C+" | "C" | "C-" | "D" | "F"`. It is used by `GRADE_ORDER` in `src/lib/bluechip.ts` for compile-time completeness checking.

## Non-USD Peg Handling

Peg deviation for non-USD stablecoins requires knowing the USD value of the peg currency. `shared/lib/peg-rates.ts` derives this by computing the median price among stablecoins of each `pegType` from the stablecoins cache / DefiLlama-compatible `peggedAssets` rows with at least $1M supply. This avoids hardcoding FX rates. The function always returns a `PegRatesResult` containing `rates` (the numeric lookup), `sources` (which source was used per currency), and `counts` (the number of qualifying live contributors per currency). The deviation is then `((price / pegRef) - 1) * 10000` basis points.

For thin peg groups (often <3 qualifying coins), live `fxFallbackRates` from `sync-fx-rates.ts` are used when available. In `derivePegRates()`, if a peg group has fewer than 3 qualifying coins and a fallback rate exists, the fallback is used directly instead of the peer median. If a peg group has no qualifying live contributors at all, the same fallback rate is still published when available instead of silently reverting the peg reference to `1`. This prevents one or two coins from becoming their own unstable peg reference and keeps thin non-USD groups stable when a provider temporarily zeroes the only live asset in that peg.

`sync-fx-rates.ts` is triggered in the 15-minute quarter-hourly slot, but scheduled time maps each invocation into a 30-minute cadence bucket. The first delivery claims the bucket with a generation-fenced compare-and-swap; a bucket is completed only after canonical publication, and a failed bucket remains retryable at the next quarter-hour slot. Frankfurter's maintained hosted API at `api.frankfurter.dev` (ECB data) covers EUR, GBP, CHF, BRL, JPY, IDR, SGD, TRY, AUD, ZAR, CAD, CNY, PHP, MXN, MYR, KRW, HKD, and INR. CNH, RUB, UAH, ARS, KGS, NGN, XOF, and VND are filled from the secondary `fawazahmed0/currency-api` path because Frankfurter/ECB does not cover the full set needed for peg evaluation. When Frankfurter is temporarily unavailable, that same dated secondary feed can backstop the wider fiat set. If both Frankfurter and the existing secondary mirrors are unavailable, the worker falls through to ExchangeRate-API's daily USD reference snapshot before dropping to cached-only mode. If none of the live FX fetch paths respond but the last published daily references are still within their freshness cadence, the cron now carries those dated references forward as a successful live refresh instead of classifying the run as a degraded cached fallback. When `OPENEXCHANGERATES_API_KEY` is configured, the cron also runs a real-time Open Exchange Rates cross-validation pass and can promote validated realtime quotes into the cached fallback-rate set for supported pegs.

## Commodity & Non-DefiLlama Stablecoins

Gold, silver, and some fiat stablecoins are not in DefiLlama's stablecoin API. These use the same canonical `ticker-issuer` ID format as all other stablecoins (e.g., `xaut-tether`, `kag-kinesis`, `jpyc-jpyc`) and are distinguished by their `detailProvider` field (`"commodity"` or `"coingecko"`) and `geckoId`/`protocolSlug` fields in `StablecoinMeta`.

The Worker's `sync-stablecoins` cron derives the supplemental set directly from `ACTIVE_STABLECOINS` by selecting all gold/silver entries (by `pegCurrency`) plus all entries explicitly marked with `detailProvider === "coingecko"`. Runtime code then splits that set into commodity tokens and fiat CoinGecko-only tokens, fetches the needed CoinGecko/DefiLlama data, shapes the result into DefiLlama-compatible rows, and merges those rows into the cached `peggedAssets` array. For preview-only fiat CoinGecko assets that expose no usable market price/market cap yet, the cron can still keep the asset in coverage by combining on-chain supply with the fresh/static FX peg reference to derive USD circulating supply; the default path uses total supply, while configured protocol-inventory cases can subtract live non-circulating holder balances first. In those cases the asset remains in the cache with `price = null` until a real market quote appears. Last-known-good supplemental preservation also applies to those tracked `detailProvider === "coingecko"` assets even when they do not yet have a `geckoId`.

Gold/silver token price normalization and sanity validation both use the `commodityOunces` field, so fractional-ounce assets are compared against the correct per-token gold/silver reference instead of full-ounce spot. For gold tokens that declare a `protocolSlug`, historical TVL is fetched from the DefiLlama protocol API to populate `circulatingPrevDay/Week/Month` with actual values (instead of copying current mcap). Silver tokens currently use the CoinGecko market/supply fallback; when historical data is unavailable, these fields are `null` and the frontend shows "N/A" rather than a misleading 0%.
