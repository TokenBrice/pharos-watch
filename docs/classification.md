# Classification System, Peg Handling & Gold Stablecoins

## Stablecoin Classification System

Each stablecoin in `src/lib/stablecoins.ts` has flags:

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
| `algorithmic` | Maintains peg via algorithmic mechanisms |

### Peg Currency

`USD`, `EUR`, `GBP`, `CHF`, `BRL`, `RUB`, `JPY`, `IDR`, `SGD`, `TRY`, `AUD`, `ZAR`, `CAD`, `CNY`, `PHP`, `MXN`, `UAH`, `ARS`, `GOLD`, `SILVER`, `VAR` (variable/CPI-linked), `OTHER`

### Boolean Flags

- `yieldBearing` — token itself accrues yield (e.g., USDY, USDe, BUIDL)
- `rwa` — backed by real-world assets like treasuries/bonds (distinct from `rwa-backed` which also includes plain fiat reserves)
- `navToken` — price appreciates over time as yield accrues (USYC, USDY, TBILL, YLDS). Excluded from peg deviation metrics; table shows "NAV" instead of bps. Also used for CPI-indexed tokens (FPI) — table shows "CPI" for VAR-pegged navTokens

### Additional Metadata

Key fields on `StablecoinMeta` (see `src/lib/types.ts` for the full interface):

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
- `reserves?: ReserveSlice[]` — reserve composition data
- `yieldConfig?: YieldConfig` — yield intelligence configuration

### Bluechip Grade

`BluechipGrade` is a union type in `types.ts`: `"A+" | "A" | "A-" | "B+" | "B" | "B-" | "C+" | "C" | "C-" | "D" | "F"`. Used by `GRADE_COLORS` in `classification.ts` and `GRADE_ORDER` in `bluechip.ts` for compile-time completeness checking.

## Non-USD Peg Handling

Peg deviation for non-USD stablecoins requires knowing the USD value of the peg currency. `src/lib/peg-rates.ts` derives this by computing the median price among stablecoins of each `pegType` (from DefiLlama data) with >$1M supply. This avoids hardcoding FX rates. The function always returns a `PegRatesResult` containing both `rates` (the numeric lookup) and `sources` (which source was used per currency). The deviation is then `((price / pegRef) - 1) * 10000` basis points.

For thin peg groups (often <3 qualifying coins), live `fxFallbackRates` from `sync-fx-rates.ts` are used when available. In `derivePegRates()`, if a peg group has fewer than 3 qualifying coins and a fallback rate exists, the fallback is used directly instead of the peer median. This prevents one or two coins from becoming their own unstable peg reference.

Live FX rates are fetched every 15 minutes by `sync-fx-rates.ts` from frankfurter.app (ECB data) for EUR, GBP, CHF, BRL, JPY, IDR, SGD, TRY, AUD, ZAR, CAD, CNY, PHP, MXN. RUB, UAH, and ARS use a secondary API (`fawazahmed0/exchange-api` via jsDelivr CDN) since ECB doesn't publish these currencies.

## Commodity & Non-DefiLlama Stablecoins

Gold, silver, and some fiat stablecoins are not in DefiLlama's stablecoin API. These are identified by their `geckoId` and/or `protocolSlug` fields in `StablecoinMeta` (in `src/lib/stablecoins.ts`), and use synthetic IDs (e.g., `gold-xaut`, `silver-kag`, `cg-jpyc`).

The Worker's `sync-stablecoins` cron derives the list of commodity and CoinGecko-only tokens directly from `TRACKED_STABLECOINS` by filtering on `geckoId` and `pegType`. Data is fetched from CoinGecko, shaped into DefiLlama-compatible format, and merged into the `peggedAssets` array before caching.

Gold/silver token price normalization handles both 1-gram and 1-troy-ounce tokens via the `commodityOunces` field. Historical TVL is fetched from the DefiLlama protocol API (using `protocolSlug`) to populate `circulatingPrevDay/Week/Month` with actual values (instead of copying current mcap). When historical data is unavailable, these fields are `null` and the frontend shows "N/A" rather than a misleading 0%.
