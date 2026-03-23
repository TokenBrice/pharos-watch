# Pricing Pipeline Methodology - Version Timeline

Internal changelog reconstructed from the machine-readable methodology version source. Covers Pricing Pipeline `v1.0` through `v2.15` (2026-02-01 -> 2026-03-23).

---

## v2.15 - Independent FX recovery during cached fallback (Mar 23, 2026)

**Commit:** `unreleased`

- Cached-fallback FX runs now keep probing Open Exchange Rates, Chainlink reference feeds, and gold-api.com instead of freezing those recovery paths until Frankfurter recovers
- A single stale intraday peg can no longer trap the whole FX lane in repeated cached fallback when an independent overlay source can refresh it
- If those independent probes restore fresh full-set fiat coverage, the run exits cached fallback immediately and resets the fallback streak
- Operator metadata still records the failed Frankfurter / mirror transport path, but no longer exaggerates the duration of a recovered subset outage

---

## v2.14 - Replay-safe trusted-price continuity for confirmed depegs (Mar 23, 2026)

**Commit:** `unreleased`

- Previous-trusted severe-depeg continuity now also consults fresh replay-safe `price_cache` rows instead of relying only on the immediately previous stablecoins publication
- A temporarily `low` or unusable stablecoins run no longer causes the next fallback-validation pass to forget an already corroborated open depeg
- Cached replay can therefore keep publishing the last fresh authoritative depeg price through brief corroboration gaps instead of flapping to `N/A` on detail surfaces
- This specifically closes the intermittent USR-style gap where PSI could still explain the depeg from replay-safe state while the detail page lost its current price

---

## v2.13 - Source-aware trust, observed-time freshness, and weak-price jump quarantine (Mar 22, 2026)

**Commit:** `unreleased`

- Pricing source capabilities now come from one canonical registry shared by consensus, replay safety, pool challenge, GT probing, status health, and depeg trust classification
- Cached stablecoin payloads now preserve `priceObservedAt` and `priceSyncedAt`; compatibility `priceUpdatedAt` now reflects the true observation timestamp instead of the sync write time
- Soft single-source prices and soft-only high-confidence consensus can no longer mutate live depeg state directly; only fresh hard sources remain depeg-authoritative
- Weak fixed-peg price jumps versus the previous trusted price now require corroboration before publication
- Published DEX challenger snapshots now retain the live `$100K` pool threshold and no longer suppress per-coin publication just because an unrelated DEX source degraded globally
- GeckoTerminal probing now revisits weak CoinGecko / DL-list soft outcomes, not only strict one-source cases
- Direct-API DEX quote conversion now reuses only authoritative tracked stablecoin prices; weak tracked prices fall back to peg references instead of feeding the bridge loop
- Replay cache now stores source/confidence/timestamps/source lists, and RedStone derives its price from the venue median rather than the provider aggregate
- CoinMarketCap, Jupiter, and DexScreener enrichment passes now fail independently instead of aborting the whole late-enrichment block

---

## v2.12 - Identity-safe enrichment, severe-downside publication guards, and replay-safe DEX quote derivation (Mar 22, 2026)

**Commit:** `unreleased`

- Primary pricing candidates are no longer gated on `geckoId`; tracked assets can still enter consensus through non-CoinGecko voices
- DefiLlama pass 1b now probes only tracked alternate deployments instead of synthesizing same-address identities across chains
- CoinMarketCap and DexScreener symbol fallbacks now require uniqueness within the tracked registry
- RedStone prices now require at least two corroborating venues before entering primary consensus
- Pool challenge now applies to DEX-inclusive soft consensus clusters unless an exempt hard source is present
- GeckoTerminal probing now cross-checks eligible single-source DL-list results in addition to single-source CoinGecko results
- Direct-API DEX quote conversion now prefers tracked cached stablecoin prices and no longer treats unknown addressed USD-like symbols as automatic `$1` references
- Replay cache now stores only replay-safe non-low, non-fallback prices and expires after 6 hours
- Severe fixed-peg downside publication now requires corroboration unless the source is an explicit protocol-redemption or pool-challenge replacement mark

---

## v2.11 - Canonical DEX token identity and non-overlapping DEX consensus (Mar 22, 2026)

**Commit:** `unreleased`

- Runtime DEX parsing no longer learns new token ownership from DeFiLlama or subgraph symbol strings
- Addressed unknown tokens are dropped instead of falling back to symbol matches in price-bearing DEX paths
- DeFiLlama pools with `underlyingTokens` now match tracked assets by canonical addresses only
- Promoted per-protocol DEX bridge sources now require corroboration, or the absence of non-DEX voices, before entering primary consensus
- The overlapping `dex-promoted` aggregate is now withheld whenever promoted per-protocol DEX bridge data exists for the same asset

---

## v2.10 - Cadence-valid FX carry-forward semantics (Mar 20, 2026)

**Commit:** `unreleased`

- FX refreshes now treat already-current daily references as a successful live carry-forward when they are still within expected source cadence
- Failed Frankfurter or mirror transports no longer automatically mark the published FX state as cached fallback when the underlying daily reference is still current
- Per-peg metadata preserves source dates and cadence semantics during carry-forward runs
- Status still degrades once the underlying daily references genuinely age out, rather than on transport failure alone

---

## v2.9 - Jupiter V3 freshness fix and exact DexScreener address fallback (Mar 20, 2026)

**Commit:** `unreleased`

- Jupiter fallback no longer rejects V3 quotes solely because optional `createdAt` metadata is old
- Jupiter recovery continues to rely on liquidity gating and peg-aware validation
- DexScreener enrichment now prefers exact chain+address pool lookups before falling back to symbol search
- DexScreener search remains as the last fallback path under the same bounded request budget

---

## v2.8 - Tertiary full-set FX fallback for multi-source outages (Mar 20, 2026)

**Commit:** `unreleased`

- Added ExchangeRate-API as a tertiary live full-set FX fallback
- Frankfurter remains preferred for the core fiat set
- The secondary `fawazahmed0/currency-api` mirrors still cover CNH/RUB/UAH/ARS and can backstop the wider fiat set
- Pricing methodology and About page now disclose ExchangeRate-API as an externally visible FX reference source

---

## v2.7 - Secondary FX full-set live fallback for Frankfurter outages (Mar 20, 2026)

**Commit:** `unreleased`

- Expanded the dated secondary FX mirror path so it can backstop the wider fiat reference set
- Prevents immediate cached-only FX runs during Frankfurter outages when the secondary feed is healthy
- Preserves daily source-date semantics in per-peg FX metadata during that live fallback path

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
