# Classification System, Peg Handling & Gold Stablecoins

## Stablecoin Classification System

Each tracked stablecoin is defined in the checked-in per-coin data assets under `shared/data/stablecoins/coins/*.json`, loaded through `shared/lib/stablecoins/registry.ts` from the prevalidated `shared/data/stablecoins/coins.prevalidated.generated.ts` snapshot (which mirrors `shared/data/stablecoins/coins.generated.json`), and validated by `shared/lib/stablecoins/schema.ts` at generation/test time. Import stablecoin helpers from their explicit submodules; use the registry module for the full catalog and active/pre-launch/frozen splits. Each entry carries these flags:

### Type (governance field internally)

Three-tier system reflecting actual dependency on centralized infrastructure:

| Tier                    | Label    | Meaning                                                                                                               | Examples                                 |
| ----------------------- | -------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `centralized`           | CeFi     | Fully centralized issuer, custody, and redemption                                                                     | USDT, USDC, PYUSD, FDUSD                 |
| `centralized-dependent` | CeFi-Dep | Decentralized governance/mechanics but depends on centralized custody, off-chain collateral, or centralized exchanges | DAI, USDS, USDe, GHO, FRAX, crvUSD, sUSD |
| `decentralized`         | DeFi     | Fully on-chain collateral, no centralized custody dependency                                                          | LUSD, BOLD, BEAN                         |

The key distinction for `centralized-dependent`: these protocols may have on-chain governance and smart contract mechanics, but they ultimately rely on off-chain t-bill deposits, centralized exchange positions (delta-neutral), or significant USDC/USDT collateral. Calling them "decentralized" would be misleading. For example, crvUSD's peg keepers use centralized stablecoins (USDC, USDT, USDP), and sUSD V3 added USDC as core collateral on Base.

### Backing

| Value           | Meaning                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rwa-backed`    | Backed by real-world assets (fiat reserves, treasuries, gold)                                                                                                       |
| `crypto-backed` | Backed by on-chain crypto collateral                                                                                                                                |
| `algorithmic`   | Legacy / shadow-only — still a valid `BACKING_TYPE_VALUES` member but no longer assigned to any tracked coin; retained only for PSI shadow assets (see prose below) |

Active Pharos taxonomy no longer exposes `algorithmic` as a standalone backing bucket. Coins with programmatic peg controls are classified by their actual collateral base instead. Historical shadow assets kept only for PSI continuity can still carry legacy `algorithmic` metadata.

### Peg Currency

`USD`, `EUR`, `GBP`, `CHF`, `BRL`, `RUB`, `JPY`, `KRW`, `IDR`, `INR`, `MYR`, `SGD`, `HKD`, `TRY`, `AUD`, `ZAR`, `CAD`, `CNY`, `CNH`, `PHP`, `MXN`, `VND`, `UAH`, `ARS`, `KGS`, `NGN`, `XOF`, `GOLD`, `SILVER`, `VAR` (variable/CPI-linked), `OTHER`

### Boolean Flags

- `yieldBearing` — token itself accrues yield (e.g., USDY, USDe, BUIDL)
- `rwa` — backed by real-world assets like treasuries/bonds (distinct from `rwa-backed` which also includes plain fiat reserves)
- `navToken` — price appreciates over time as yield accrues (USYC, USDY, TBILL, YLDS). Excluded from peg deviation metrics; table shows "NAV" instead of bps. Also used for CPI-indexed tokens (FPI) — table shows "CPI" for VAR-pegged navTokens

### Additional Metadata

Key fields on `StablecoinMeta` (see `shared/types/core.ts` plus `shared/types/stablecoin-meta-schemas.ts` for the typed/schema source):

- `id: string` — stablecoin ID in canonical ticker-issuer format (e.g., `"usdt-tether"`, `"usdc-circle"`)
- `llamaId?: string` — DefiLlama numeric stablecoin ID for `stablecoins.llama.fi` calls when internal IDs diverge
- `detailProvider?: "defillama" | "coingecko" | "commodity"` — explicit detail data source selector (migration field replacing ID-prefix heuristics)
- `marketAvailability?: "market-traded" | "limited-trading" | "non-traded-utility" | "legacy-or-wind-down"` — descriptive availability label for issuer/regulatory coverage audits; currently used to preserve eurostablecoins.xyz market-status distinctions for EUR stablecoins without changing runtime cache admission
- `collateral?: string` — description of the collateral backing
- `pegMechanism?: string` — description of the peg maintenance mechanism
- `mechanismArchetype?: MechanismArchetype` — one of `"fiat-cash" | "tbill" | "cdp" | "synthetic-delta-neutral" | "algorithmic" | "rwa-credit-fund"` (defined in `shared/types/core.ts`). When set, the coin detail page renders an SVG mechanism diagram in `KeyInfoCard` plus a "Learn how X stablecoins work" link to the matching `/learn/mechanisms/<slug>/` explainer. Slug helpers live in `shared/lib/classification/mechanism-archetypes.ts`; the dedicated explainer route contract is [learn-mechanisms-page.md](./learn-mechanisms-page.md).
- `archetypeOverride?: boolean` — when `true`, this coin's `mechanismArchetype` is an intentional departure from its parent variant's archetype (schema-validated)
- `commodityOunces?: number` — troy ounces per token (for gold- and silver-pegged stablecoins)
- `geckoId?: string` — CoinGecko coin ID for price/mcap lookups (commodity and non-DefiLlama tokens)
- `cmcSlug?: string` — CoinMarketCap slug for fallback price lookups
- `protocolSlug?: string` — DefiLlama protocol slug for TVL/mcap data (commodity tokens)
- `proofOfReserves?: ProofOfReserves` — proof of reserves configuration
- `links?: StablecoinLink[]` — external links (website, docs, twitter)
- `jurisdiction?: Jurisdiction` — regulatory jurisdiction
- `mica?: MicaProfile` — EU MiCA authorization status, EMT/ART token type, competent authority, issuer entity, significance flag, and sourced register/reference links. See [mica-tracker.md](./mica-tracker.md).
- `genius?: GeniusProfile` — U.S. GENIUS Act implementation-watch posture: applicability, authorization status, issuer pathway, regulator fields, reserve/redemption disclosure presence, negative-evidence review, reviewer metadata, and source references. See [compliance-page.md](./compliance-page.md).
- `contracts?: ContractDeployment[]` — on-chain contract addresses per chain
- `dependencies?: DependencyWeight[]` — upstream stablecoin dependencies (for report cards)
- `canBeBlacklisted?: boolean | "possible"` — direct freeze/blacklist capability override (reported descriptively); upstream exposure is computed
- `blacklistabilityReview?: BlacklistabilityReview` — required for every explicit `canBeBlacklisted` value and used for reviewed inherited/No rationale; `reviewedStatus` must match the authored status
- `chainTier? / deploymentModel? / collateralQuality? / custodyModel? / governanceQuality?` — report card resilience/decentralization overrides
- `oracleRisk?: OracleRiskProfile` — reviewed CDP oracle / collateral price-feed setup, with optional review provenance and collateral-branch rows. Safety Score v8.11 reads this only for crypto-backed `mechanismArchetype: "cdp"` assets, applying a penalty-only Decentralization blend to direct non-variant CDPs; missing reviews and non-CDP rows stay neutral, while resolvable variants display inherited parent oracle exposure without a duplicate direct blend.
- `bridgeRouteRisk?: BridgeRouteRiskProfile` — reviewed cross-chain route setup, with route tier, summary, provenance, confidence, optional protocol evidence, and sources. Safety Score v8.12 reads this as a penalty-only Decentralization blend for curated profiles; missing reviews stay neutral. L2BEAT Interop can support review evidence and candidate queues, but queue output is not curated metadata until a reviewer writes a sourced profile.
- `infrastructures?: Infrastructure[]` — structured infrastructure-lineage list (`"liquity-v1"` / `"liquity-v2"` / `"m0"`) used for UI badges, cohort filters, and discovery hubs. An array so a coin can belong to more than one infrastructure simultaneously, though in practice each coin currently has zero or one entry.
- `variantOf?: string` / `variantKind?: "savings-passthrough" | "strategy-vault" | "risk-absorption" | "bond-maturity"` — active-only parent-variant metadata for tracked wrapper, strategy-vault, or bond-leg products whose user expectation is still direct exposure to another tracked stablecoin
- `pegReferenceId?: string` — id of the tracked stablecoin used as this coin's peg-deviation reference (drives severe active-depeg cap inheritance from a parent). For tracked variants it is invariant-bound to equal `variantOf` (enforced in `shared/lib/stablecoins/schema.ts` and `validate-variants.ts`)
- `reserves?: ReserveSlice[]` — reserve composition data
- `yieldConfig?: YieldConfig` — yield intelligence configuration
- `pythFeedId?: string` — Pyth Network oracle feed ID (used for gold/commodity stablecoins)
- `tradedContracts?: ContractDeployment[]` — traded contract addresses separate from `contracts`
- `liveReservesConfig?: LiveReservesConfig` — live reserve sync configuration (see `docs/live-reserves.md`)
- `notices?: CoinNotice[]` — per-coin alert notices shown on detail pages
- `status?: "pre-launch" | "active" | "frozen"` — lifecycle state; omitted rows are active
- `frozenAt?: string` / `obituary?: StablecoinObituary` — freeze date and cemetery/detail-page obituary content required for frozen tracked coins
- `launchDate?`, `announcedDate?`, `expectedLaunchDate?`, `launchPhase?`, `launchPhaseDetail?`, `featuredContent?`, `milestones?`, `dateHistory?` — launch/upcoming timeline metadata for pre-launch and newly launched assets
- `mintAuthority?: MintAuthorityProfile` — reviewed mint/burn authority posture used by the Mint Authority Score and detail-page authority summaries
- `tags?: string[]` — freeform tag array for filtering and categorization

### Mint Authority Taxonomy

Mint Authority is a reviewed mint-control taxonomy and score input; since Safety Score v8.0 the score drags the Decentralization dimension through a penalty-only blend, though it is not a dimension of its own. It focuses on who can create durable supply or alter minting paths through direct minters, minter admins, proxy/cap admins, facilitators, bridges, off-chain signer systems, governance, or wrapper inheritance. Missing data means the stablecoin detail page omits the Mint Authority section until a review is curated, and score-oriented aggregate surfaces show `NR`.

Compact `mintAuthoritySummary` projections can appear in structural/user-facing tables, including `/coverage/`, the homepage stablecoin table, and `/screener/`. Those surfaces bucket the reviewed data into display/filter labels (`No priv.`, `Governed`, `Multisig`, `Issuer`, `Bridge`, `Inherited`, `Unknown`) and may show the standalone Mint Authority Score/band. The display buckets themselves do not feed report-card methodology; the underlying Mint Authority Score feeds only the Decentralization blend (v8.0).

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

Authority posture labels are descriptive bands only: `none-resolved`, `bounded-admin`, `partially-bounded-admin`, `concentrated-admin`, `unbounded-or-compromised`, and `unknown`. Do not color or rank these like report-card grades.

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

`sync-fx-rates.ts` is triggered in the 15-minute quarter-hourly slot, but an internal `sync-fx-rates:last-write` cooldown gates upstream work to every 30 minutes. Frankfurter's maintained hosted API at `api.frankfurter.dev` (ECB data) covers EUR, GBP, CHF, BRL, JPY, IDR, SGD, TRY, AUD, ZAR, CAD, CNY, PHP, MXN, MYR, and KRW. CNH, RUB, UAH, ARS, KGS, NGN, XOF, and VND are filled from the secondary `fawazahmed0/currency-api` path because Frankfurter/ECB does not cover the full set needed for peg evaluation. When Frankfurter is temporarily unavailable, that same dated secondary feed can backstop the wider fiat set. If both Frankfurter and the existing secondary mirrors are unavailable, the worker falls through to ExchangeRate-API's daily USD reference snapshot before dropping to cached-only mode. If none of the live FX fetch paths respond but the last published daily references are still within their freshness cadence, the cron now carries those dated references forward as a successful live refresh instead of classifying the run as a degraded cached fallback. When `OPENEXCHANGERATES_API_KEY` is configured, the cron also runs a real-time Open Exchange Rates cross-validation pass and can promote validated realtime quotes into the cached fallback-rate set for supported pegs.

## Commodity & Non-DefiLlama Stablecoins

Gold, silver, and some fiat stablecoins are not in DefiLlama's stablecoin API. These use the same canonical `ticker-issuer` ID format as all other stablecoins (e.g., `xaut-tether`, `kag-kinesis`, `jpyc-jpyc`) and are distinguished by their `detailProvider` field (`"commodity"` or `"coingecko"`) and `geckoId`/`protocolSlug` fields in `StablecoinMeta`.

The Worker's `sync-stablecoins` cron derives the supplemental set directly from `ACTIVE_STABLECOINS` by selecting all gold/silver entries (by `pegCurrency`) plus all entries explicitly marked with `detailProvider === "coingecko"`. Runtime code then splits that set into commodity tokens and fiat CoinGecko-only tokens, fetches the needed CoinGecko/DefiLlama data, shapes the result into DefiLlama-compatible rows, and merges those rows into the cached `peggedAssets` array. For preview-only fiat CoinGecko assets that expose no usable market price/market cap yet, the cron can still keep the asset in coverage by combining on-chain supply with the fresh/static FX peg reference to derive USD circulating supply; the default path uses total supply, while configured protocol-inventory cases can subtract live non-circulating holder balances first. In those cases the asset remains in the cache with `price = null` until a real market quote appears. Last-known-good supplemental preservation also applies to those tracked `detailProvider === "coingecko"` assets even when they do not yet have a `geckoId`.

Gold/silver token price normalization and sanity validation both use the `commodityOunces` field, so fractional-ounce assets are compared against the correct per-token gold/silver reference instead of full-ounce spot. For gold tokens that declare a `protocolSlug`, historical TVL is fetched from the DefiLlama protocol API to populate `circulatingPrevDay/Week/Month` with actual values (instead of copying current mcap). Silver tokens currently use the CoinGecko market/supply fallback; when historical data is unavailable, these fields are `null` and the frontend shows "N/A" rather than a misleading 0%.
