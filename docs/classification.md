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

`USD`, `EUR`, `GBP`, `CHF`, `BRL`, `RUB`, `JPY`, `GOLD`, `VAR` (variable/CPI-linked), `OTHER`

### Boolean Flags

- `yieldBearing` — token itself accrues yield (e.g., USDY, USDe, BUIDL)
- `rwa` — backed by real-world assets like treasuries/bonds (distinct from `rwa-backed` which also includes plain fiat reserves)
- `navToken` — price appreciates over time as yield accrues (USYC, USDY, TBILL, YLDS). Excluded from peg deviation metrics; table shows "NAV" instead of bps. Also used for CPI-indexed tokens (FPI) — table shows "CPI" for VAR-pegged navTokens

### Additional Metadata

- `collateral?: string` — description of the collateral backing
- `pegMechanism?: string` — description of the peg maintenance mechanism
- `goldOunces?: number` — troy ounces of gold per token (for gold-pegged stablecoins)
- `proofOfReserves?: ProofOfReserves` — proof of reserves configuration
- `links?: StablecoinLink[]` — external links (website, docs, twitter)
- `jurisdiction?: Jurisdiction` — regulatory jurisdiction

## Non-USD Peg Handling

Peg deviation for non-USD stablecoins requires knowing the USD value of the peg currency. `src/lib/peg-rates.ts` derives this by computing the median price among stablecoins of each `pegType` (from DefiLlama data) with >$1M supply. This avoids hardcoding FX rates. The deviation is then `((price / pegRef) - 1) * 10000` basis points.

For thin peg groups (GBP, CHF, BRL, RUB, JPY — often <3 qualifying coins), a `FALLBACK_RATES` map provides approximate FX rates. If the median from <3 coins deviates >10% from the fallback, the fallback is used instead. This prevents a single depegged coin from becoming its own reference rate (which would always show 0 bps deviation).

Live FX rates are fetched every 2 hours by `sync-fx-rates.ts` from frankfurter.app (ECB data) for EUR, GBP, CHF, BRL, JPY, IDR. RUB uses a secondary API (`open.er-api.com`) since ECB doesn't publish ruble rates.

## Gold Stablecoins (XAUT, PAXG)

These use synthetic IDs (`gold-xaut`, `gold-paxg`) since they're not in DefiLlama's stablecoin API. Data comes from CoinGecko, shaped into DefiLlama-compatible format by the Worker's `sync-stablecoins` cron, and merged into the `peggedAssets` array before caching. Gold token price normalization handles both 1-gram and 1-troy-ounce tokens via the `goldOunces` field. Historical TVL is fetched from the DefiLlama protocol API to populate `circulatingPrevDay/Week/Month` with actual values (instead of copying current mcap). When historical data is unavailable, these fields are `null` and the frontend shows "N/A" rather than a misleading 0%.

## Non-DefiLlama Fiat Stablecoins (JPYC, IDRT)

These use synthetic IDs (`cg-jpyc`, `cg-idrt`) and are fetched from CoinGecko via the `FIAT_COINGECKO_TOKENS` config in `sync-stablecoins.ts`. Same pattern as gold tokens — data is shaped into DefiLlama-compatible format and merged into `peggedAssets` before caching.
