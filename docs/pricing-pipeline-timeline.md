# Pricing Pipeline Methodology - Version Timeline

Internal changelog reconstructed from the machine-readable methodology version source. Covers Pricing Pipeline `v1.0` through `v2.6` (2026-02-01 -> 2026-03-19).

---

## v2.6 - Published DEX challenger snapshots and durable FX freshness metadata (Mar 19, 2026)

**Commit:** `unreleased`

- Pool challenge and depeg confirmation now read dedicated challenger snapshots instead of depending on the visible top-pools subset
- Challenger coverage is persisted per stablecoin and falls back safely during migration gaps
- FX fallback runs now preserve source timestamps and source modes instead of implicitly refreshing them
- Health and status surfaces now distinguish usable FX freshness from underlying source freshness

---

## v2.5 - Kraken and Bitstamp primary pricing, Jupiter Solana fallback, Chainlink reference overlays (Mar 19, 2026)

**Commit:** `unreleased`

- Added Kraken and Bitstamp as additional primary CEX pricing voices
- Added a Jupiter Price API fallback pass for unresolved Solana assets
- Added curated Chainlink EUR/USD, GBP/USD, JPY/USD, XAU/USD, and XAG/USD overlays for FX and commodity validation
- Status reporting now exposes Kraken, Bitstamp, and Jupiter participation explicitly

---

## v2.4 - Pairwise consensus hardening, RedStone freshness gate, authoritative override ordering (Mar 19, 2026)

**Commit:** `unreleased`

- Consensus agreement now requires pairwise clustering instead of allowing transitive-source chains
- Fixed-peg assets stay on fixed-peg rules when peg references are temporarily unavailable
- Stale or aggregate-only RedStone rows are excluded before consensus
- Protocol-backed redeem-price overrides remain final after GeckoTerminal probing

---

## v2.3 - Per-protocol DEX bridge aggregation and top-pool challenge source split (Mar 18, 2026)

**Commit:** `unreleased`

- DEX bridge persistence now stores one aggregated price source per protocol instead of repeating individual pools
- Pool challenge reads large current pools from `dex_liquidity.top_pools_json` instead of the consensus bridge payload
- Non-USD tracked stablecoin pairs now use peg-reference-aware conversion in direct-API DEX pricing

---

## v2.2 - Pool confirmation fix, peg-type-aware challenge, source quality gating (Mar 17, 2026)

**Commit:** `unreleased`

- Added pool-level individual prices as a fourth depeg-confirmation source
- Made the pool-challenge threshold peg-type-aware
- Added Pyth-confidence and RedStone venue-agreement gating
- Downgraded CoinGecko-plus-DefiLlama-only agreement to `single-source`
- Preserved the full consensus source list in labels

---

## v2.1 - Consensus honesty: independent DL list price, GeckoTerminal probe, pool challenge (Mar 16, 2026)

**Commit:** `unreleased`

- Removed the DefiLlama coins API from primary consensus because it mirrored CoinGecko data
- Added DefiLlama stablecoins-list pricing as an independent aggregator voice
- Added a GeckoTerminal pool probe for CoinGecko-only single-source assets
- Added a pool-challenge guard that can downgrade soft consensus and replace price with a TVL-weighted pool mean

---

## v2.0 - Multi-source consensus with oracle, CEX, and on-chain pricing (Mar 14, 2026)

**Commit:** `unreleased`

- Replaced 2-source cross-validation with an 8-source weighted consensus system
- Added Pyth, Binance, Coinbase, RedStone, Curve on-chain pricing, and promoted DEX observations
- Introduced clustering-based consensus, price-confidence tagging, and the 4-pass enrichment pipeline

---

## v1.0 - Initial 2-source price cross-validation (Feb 1, 2026)

**Commit:** `unreleased`

- Launched baseline pricing with CoinGecko as primary and DefiLlama as cross-validation
- Used simple comparison logic instead of clustering
- Added a basic DexScreener enrichment path for missing prices

---

## Notes

- Canonical machine-readable source: `shared/lib/pricing-pipeline-version.ts`
- Live consensus and enrichment logic runs through `worker/src/lib/price-consensus.ts` and `worker/src/cron/enrich-prices.ts`
