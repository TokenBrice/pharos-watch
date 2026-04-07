# Classification System, Peg Handling & Gold Stablecoins

## Stablecoin Classification System

Each tracked stablecoin is defined in the checked-in data assets under `shared/data/stablecoins/*.json` and loaded through `shared/lib/stablecoins/index.ts` + `shared/lib/stablecoins/schema.ts`. Each entry carries these flags:

### Type (governance field internally)

Three-tier system reflecting actual dependency on centralized infrastructure:

| Tier | Label | Meaning | Examples |
|------|-------|---------|----------|
| `centralized` | CeFi | Fully centralized issuer, custody, and redemption | USDT, USDC, PYUSD, FDUSD |
| `centralized-dependent` | CeFi-Dep | Decentralized governance/mechanics but depends on centralized custody, off-chain collateral, or centralized exchanges | DAI, USDS, USDe, GHO, FRAX, crvUSD, sUSD |
| `decentralized` | DeFi | Fully on-chain collateral, no centralized custody dependency | LUSD, BOLD, ZCHF, BEAN |

The key distinction for `centralized-dependent`: these protocols may have on-chain governance and smart contract mechanics, but they ultimately rely on off-chain t-bill deposits, centralized exchange positions (delta-neutral), or significant USDC/USDT collateral. Calling them "decentralized" would be misleading. For example, crvUSD's peg keepers use centralized stablecoins (USDC, USDT, USDP), and sUSD V3 added USDC as core collateral on Base.

### Backing

| Value | Meaning |
|-------|---------|
| `rwa-backed` | Backed by real-world assets (fiat reserves, treasuries, gold) |
| `crypto-backed` | Backed by on-chain crypto collateral |

Active Pharos taxonomy no longer exposes `algorithmic` as a standalone backing bucket. Coins with programmatic peg controls are classified by their actual collateral base instead. Historical shadow assets kept only for PSI continuity can still carry legacy `algorithmic` metadata.

### Peg Currency

`USD`, `EUR`, `GBP`, `CHF`, `BRL`, `RUB`, `JPY`, `IDR`, `SGD`, `TRY`, `AUD`, `ZAR`, `CAD`, `CNY`, `CNH`, `PHP`, `MXN`, `UAH`, `ARS`, `GOLD`, `SILVER`, `VAR` (variable/CPI-linked), `OTHER`

### Boolean Flags

- `yieldBearing` — token itself accrues yield (e.g., USDY, USDe, BUIDL)
- `rwa` — backed by real-world assets like treasuries/bonds (distinct from `rwa-backed` which also includes plain fiat reserves)
- `navToken` — price appreciates over time as yield accrues (USYC, USDY, TBILL, YLDS). Excluded from peg deviation metrics; table shows "NAV" instead of bps. Also used for CPI-indexed tokens (FPI) — table shows "CPI" for VAR-pegged navTokens

### Additional Metadata

Key fields on `StablecoinMeta` (see `shared/types/index.ts` for the full interface):

- `id: string` — stablecoin ID in canonical ticker-issuer format (e.g., `"usdt-tether"`, `"usdc-circle"`)
- `llamaId?: string` — DefiLlama numeric stablecoin ID for `stablecoins.llama.fi` calls when internal IDs diverge
- `detailProvider?: "defillama" | "coingecko" | "commodity"` — explicit detail data source selector (migration field replacing ID-prefix heuristics)
- `collateral?: string` — description of the collateral backing
- `pegMechanism?: string` — description of the peg maintenance mechanism
- `commodityOunces?: number` — troy ounces per token (for gold- and silver-pegged stablecoins)
- `geckoId?: string` — CoinGecko coin ID for price/mcap lookups (commodity and non-DefiLlama tokens)
- `cmcSlug?: string` — CoinMarketCap slug for fallback price lookups
- `protocolSlug?: string` — DefiLlama protocol slug for TVL/mcap data (commodity tokens)
- `proofOfReserves?: ProofOfReserves` — proof of reserves configuration
- `links?: StablecoinLink[]` — external links (website, docs, twitter)
- `jurisdiction?: Jurisdiction` — regulatory jurisdiction
- `contracts?: ContractDeployment[]` — on-chain contract addresses per chain
- `dependencies?: DependencyWeight[]` — upstream stablecoin dependencies (for report cards)
- `canBeBlacklisted?: boolean | "possible"` — blacklist capability (for resilience scoring)
- `chainTier? / deploymentModel? / collateralQuality? / custodyModel? / governanceQuality?` — report card resilience/decentralization overrides
- `protocolFamily?: "liquity"` — structured protocol-lineage family used for UI badges, cohort filters, and discovery hubs
- `protocolVariant?: "v1" | "v2" | "style"` — structured Liquity-family variant used for stricter cohorting (`v1`, `v2`) or broader lineage-only grouping (`style`)
- `reserves?: ReserveSlice[]` — reserve composition data
- `yieldConfig?: YieldConfig` — yield intelligence configuration
- `pythFeedId?: string` — Pyth Network oracle feed ID (used for gold/commodity stablecoins)
- `tradedContracts?: ContractDeployment[]` — traded contract addresses separate from `contracts`
- `liveReservesConfig?: LiveReservesConfig` — live reserve sync configuration (see `docs/live-reserves.md`)
- `notices?: CoinNotice[]` — per-coin alert notices shown on detail pages
- `tags?: string[]` — freeform tag array for filtering and categorization

### Protocol Lineage

Pharos now supports a small structured protocol-lineage layer for families that users may want to recognize across multiple issuers or forks.

Current support:

- `protocolFamily: "liquity"`
- `protocolVariant: "v1" | "v2" | "style"`

This is intentionally narrower than the general classification system:

- use `protocolFamily` / `protocolVariant` for concrete fork or lineage cohorts that deserve dedicated badges, filters, and discovery pages
- keep `tags` for loose editorial labels that do not need first-class routing or filtering semantics

For Liquity-family assets:

- `v1` means the classic LUSD-style pattern
  - 110% liquidation threshold / minimum collateral ratio
  - Stability Pool liquidation path
  - no ongoing borrower interest
- `v2` means the BOLD-style pattern
  - user-set borrower rates
  - Stability Pools
  - Liquity-style redemptions across branch-like collateral markets
- `style` means the lineage is clear, but Pharos is not claiming a strict v1/v2 classification from the currently verified metadata

### Bluechip Grade

`BluechipGrade` is a union type in `shared/types/index.ts`: `"A+" | "A" | "A-" | "B+" | "B" | "B-" | "C+" | "C" | "C-" | "D" | "F"`. It is used by `GRADE_ORDER` in `src/lib/bluechip.ts` for compile-time completeness checking.

## Non-USD Peg Handling

Peg deviation for non-USD stablecoins requires knowing the USD value of the peg currency. `shared/lib/peg-rates.ts` derives this by computing the median price among stablecoins of each `pegType` (from DefiLlama data) with >$1M supply. This avoids hardcoding FX rates. The function always returns a `PegRatesResult` containing both `rates` (the numeric lookup) and `sources` (which source was used per currency). The deviation is then `((price / pegRef) - 1) * 10000` basis points.

For thin peg groups (often <3 qualifying coins), live `fxFallbackRates` from `sync-fx-rates.ts` are used when available. In `derivePegRates()`, if a peg group has fewer than 3 qualifying coins and a fallback rate exists, the fallback is used directly instead of the peer median. This prevents one or two coins from becoming their own unstable peg reference.

Live FX rates are refreshed every 15 minutes by `sync-fx-rates.ts`. Frankfurter's maintained hosted API at `api.frankfurter.dev` (ECB data) covers EUR, GBP, CHF, BRL, JPY, IDR, SGD, TRY, AUD, ZAR, CAD, CNY, PHP, and MXN. CNH, RUB, UAH, and ARS are filled from the secondary `fawazahmed0/currency-api` path because Frankfurter/ECB does not cover the full set needed for peg evaluation. When Frankfurter is temporarily unavailable, that same dated secondary feed can backstop the wider fiat set. If both Frankfurter and the existing secondary mirrors are unavailable, the worker falls through to ExchangeRate-API's daily USD reference snapshot before dropping to cached-only mode. If none of the live FX fetch paths respond but the last published daily references are still within their freshness cadence, the cron now carries those dated references forward as a successful live refresh instead of classifying the run as a degraded cached fallback. When `OPENEXCHANGERATES_API_KEY` is configured, the cron also runs a real-time Open Exchange Rates cross-validation pass and can promote validated realtime quotes into the cached fallback-rate set for supported pegs.

## Commodity & Non-DefiLlama Stablecoins

Gold, silver, and some fiat stablecoins are not in DefiLlama's stablecoin API. These use the same canonical `ticker-issuer` ID format as all other stablecoins (e.g., `xaut-tether`, `kag-kinesis`, `jpyc-jpyc`) and are distinguished by their `detailProvider` field (`"commodity"` or `"coingecko"`) and `geckoId`/`protocolSlug` fields in `StablecoinMeta`.

The Worker's `sync-stablecoins` cron derives the supplemental set directly from `ACTIVE_STABLECOINS` by selecting entries that have a `geckoId` and are either gold/silver-pegged or explicitly marked with `detailProvider === "coingecko"`. Runtime code then splits that set into commodity tokens and fiat CoinGecko-only tokens, fetches the needed CoinGecko/DefiLlama data, shapes the result into DefiLlama-compatible rows, and merges those rows into the cached `peggedAssets` array. For preview-only fiat CoinGecko assets that expose an ID but no usable market price/market cap yet, the cron can still keep the asset in coverage by combining on-chain total supply with the fresh/static FX peg reference to derive USD circulating supply; in that case the asset remains in the cache with `price = null` until a real market quote appears.

Gold/silver token price normalization and sanity validation both use the `commodityOunces` field, so fractional-ounce assets are compared against the correct per-token gold/silver reference instead of full-ounce spot. Historical TVL is fetched from the DefiLlama protocol API (using `protocolSlug`) to populate `circulatingPrevDay/Week/Month` with actual values (instead of copying current mcap). When historical data is unavailable, these fields are `null` and the frontend shows "N/A" rather than a misleading 0%.
