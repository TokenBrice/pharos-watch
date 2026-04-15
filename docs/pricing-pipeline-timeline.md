# Pricing Pipeline Methodology - Version Timeline

Internal changelog reconstructed from the machine-readable methodology version source. Covers Pricing Pipeline `v1.0` through `v4.38` (2026-02-01 -> 2026-04-15).

---

## v4.38 - Corroborated severe-depeg pool challenge protection (Apr 15, 2026)

**Commit:** `unreleased`

- Pool challenge still downgrades confidence when large DEX protocol groups disagree with a selected severe-depeg primary price
- Pool challenge no longer replaces that selected price when at least two live candidate sources independently corroborate severe downside and at least one of them is depeg-authoritative
- The same severe-downside candidate evidence satisfies the temporal-jump guard when the previous trusted price was near peg
- This prevents near-peg or stale DEX liquidity from overwriting a USR-style severe depeg already confirmed by CoinGecko, DefiLlama-list, and Pyth

---

## v4.37 - Severe-depeg corroboration continuity through validation (Apr 15, 2026)

**Commit:** `unreleased`

- Primary severe-downside corroboration evidence is now preserved through the later prevalidation and post-enrichment validation passes when the selected primary price remains unchanged
- Low-confidence severe depeg prices can stay published when multiple live candidate sources independently confirm the downside even if they do not form a tight high-confidence cluster
- The severe-downside guardrail is unchanged for genuinely single-source prices because candidate evidence is reused only when the current asset price, source, and confidence still match the primary result
- This prevents USR-style `N/A` flapping after primary pricing accepted a corroborated severe depeg and a later generic validation pass lost the candidate-price evidence

---

## v4.36 - Blocked Binance host accounting (Apr 15, 2026)

**Commit:** `unreleased`

- Binance all-host 403/451 blocks from Worker egress are now recorded as no-contribution provider blocks rather than source outages
- Diagnostics still persist every attempted Binance endpoint, status, and snippet so operators can see the provider-edge block
- Binance contributes zero prices in this state; consensus continues through the remaining hard venue/oracle/protocol inputs

---

## v4.35 - No-candidate Jupiter breaker recovery (Apr 15, 2026)

**Commit:** `unreleased`

- Jupiter no-candidate runs now close stale-open breaker state without making an external provider health request
- This reflects that authoritative pricing removed all current Jupiter fallback candidates, so a provider-edge block is not part of the active pricing path
- Future eligible Solana fallback candidates still use the normal Jupiter circuit breaker and provider diagnostics path

---

## v4.34 - Binance host failover for Worker egress (Apr 15, 2026)

**Commit:** `unreleased`

- Binance ticker fetches now try `data-api.binance.vision` first and fall back to `api.binance.com` before recording a failed source outcome
- The fallback was added after production Worker diagnostics showed HTTP 403 from the market-data mirror while local provider audits still saw healthy `USDTUSD` and `USDCUSD` Binance markets
- Binance diagnostics preserve each attempted endpoint so operators can distinguish mirror-specific blocks from parser/config problems

---

## v4.33 - Jupiter official gateway fallback (Apr 15, 2026)

**Commit:** `unreleased`

- Jupiter fallback and health probes now use `https://api.jup.ag/price/v3` instead of the Lite gateway
- This follows repeated Worker-side Cloudflare 403 block pages from `lite-api.jup.ag` while the official V3 gateway continued returning the same response shape
- Jupiter remains a best-effort Solana fallback behind primary consensus, authoritative protocol-backed prices, liquidity gates, and peg-aware validation

---

## v4.32 - Provider diagnostics and authoritative fallback gating (Apr 14, 2026)

**Commit:** `unreleased`

- Binance and Jupiter price attempts now persist compact diagnostics into `sync-stablecoins` cron metadata, including endpoint, status, candidate counts, parsed/response counts, matched counts, and sanitized non-OK snippets
- Protocol-backed live overrides are pre-applied before fallback enrichment and re-applied after GeckoTerminal probing, so known redeemable wrappers and extension assets do not hit fallback sources before their authoritative price is available
- Jupiter can run a bounded health probe when a previously open circuit has no remaining fallback candidates, allowing a stale-open breaker to recover once the provider is reachable

---

## v4.31 - Curated-contract price fallback and USDnr M0 inheritance (Apr 13, 2026)

**Commit:** `unreleased`

- DefiLlama contract-price fallback now tries curated tracked `contracts` metadata when the upstream stablecoin row has no `address`
- `ctusd-citrea` can resolve through its fresh DefiLlama `citrea:<contract>` quote without relying on stale CoinGecko rows or symbol search
- `usdnr-nerona` now inherits tracked `wm-m0` live pricing and historical replay through the existing authoritative `protocol-redeem` lane used by other M0 extension assets

---

## v4.3 - CoinGecko simple-price upstream freshness gate (Apr 11, 2026)

**Commit:** `unreleased`

- CoinGecko `/simple/price` requests now include `last_updated_at`
- Rows with a CoinGecko upstream timestamp older than the source trust window are excluded from primary consensus instead of being stamped as fresh local fetches
- When CoinGecko omits the timestamp despite the request, the row remains local-fetch provenance for backwards compatibility with partial responses

---

## v4.2 - Inherited wM pricing for M0 extension assets (Apr 10, 2026)

**Commit:** `unreleased`

- `usdk-kast` and `xo-exodus` now inherit tracked `wm-m0` pricing through the authoritative `protocol-redeem` lane when the parent rail is available
- Historical depeg backfills for those extension assets replay the tracked `wm-m0` market series instead of relying on missing or thin child-market history
- This extends the tracked-base inheritance pattern already used for `usdai-usd-ai -> pyusd-paypal`

---

## v4.1 - Split DexScreener exact-vs-search breaker accounting (Apr 8, 2026)

**Commit:** `unreleased`

- DexScreener pass 4 now keeps separate breaker state for exact token-address lookups and the last-resort symbol-search endpoint
- `dexscreener-prices` now reflects `/tokens/v1/{chainId}/{address}` availability only, while `dexscreener-search` tracks `/latest/dex/search`
- This prevents a flaky search endpoint from opening the same breaker that guards otherwise healthy exact-address recovery

---

## v4.0 - DexScreener request-budget walk-through for skipped fallback candidates (Apr 8, 2026)

**Commit:** `unreleased`

- DexScreener pass 4 now spends its `10`-request budget on actual outgoing DexScreener calls instead of pre-slicing the first ten missing assets
- Higher-rank addressless rows that are skipped because their symbol is not unique no longer crowd out later exact-target or unique-symbol fallback candidates such as `CHFAU` or `ctUSD`
- This reduces false `dexscreener-prices` breaker opens during bad network windows because the pass has more chances to observe a healthy DexScreener response before it gives up

---

## v3.99 - Native-peg live publication guard and fill lane for non-USD fiat assets (Apr 7, 2026)

**Commit:** `unreleased`

- Supported non-USD fiat assets can now replace materially divergent weak or mixed-source USD publications when a fresh direct native CoinGecko quote plus fresh FX reference implies a better live USD mark
- The same native lane can now fill a missing live price for supported non-USD fiat assets instead of falling straight to replay cache or `N/A`
- Native-implied live prices remain a fresh fallback-validation lane rather than a replay-safe consensus source, so they are not written into `price_cache` for later replay publication

---

## v3.98 - Daily-confirmed native-peg replay for non-USD fiat backfills (Apr 7, 2026)

**Commit:** `unreleased`

- Historical CoinGecko market-chart replay now carries the configured CoinGecko API key through the backfill/admin path so native-fiat history can use authenticated transport consistently during broad repairs
- Supported non-USD fiat backfills now replay native-fiat history at daily cadence with a two-point confirmation window across a 36-hour gap tolerance instead of opening on isolated thin hourly prints
- Extreme single-point native crashes of 5,000 bps or more are still preserved even when the normal historical confirmation rule would otherwise suppress the event

---

## v3.97 - Generalized native-peg safeguards for non-USD fiat replay and routing (Apr 7, 2026)

**Commit:** `unreleased`

- Supported non-USD fiat assets such as EUR, CHF, GBP, JPY, SGD, AUD, CAD, BRL, IDR, TRY, ZAR, PHP, MXN, RUB, and CNH/CNY can now consult fresh direct CoinGecko native-peg quotes before downstream depeg logic trusts `USD price / FX reference` on its own
- Historical backfill now prefers direct CoinGecko native-fiat history for those supported pegs and compares that series to the native `1.0` peg before it falls back to USD-denominated history
- The published cached USD price path still does not add a second CoinGecko-derived consensus source; this remains a downstream validation and historical replay hardening change

---

## v3.96 - Direct native-peg BRL corroboration for downstream depeg routing (Apr 7, 2026)

**Commit:** `unreleased`

- Supported fiat-pegged assets such as `BRZ` can now consult a fresh direct CoinGecko native-peg quote before downstream depeg logic trusts `USD price / FX reference` on its own
- Pending depeg confirmation now uses that direct native quote first when it exists, instead of relying only on a derived USD comparison
- The published cached USD price path does not change; this hardens downstream validation and depeg routing against BRL-style reference drift

---

## v3.95 - USDAI inherits PYUSD redemption pricing (Apr 6, 2026)

**Commit:** `unreleased`

- Base `usdai-usd-ai` now inherits tracked `pyusd-paypal` pricing in the authoritative override layer instead of trusting thin USDAI secondary-market prints
- Historical USDAI depeg backfills now replay the tracked PYUSD market series, so wrapper-specific CoinGecko/DefiLlama history no longer manufactures long false depeg streaks
- This keeps USDAI PegScore aligned with the token's documented instant-redemption semantics rather than with noise from sparse wrapper venues

---

## v3.94 - Blocked dead Bunni DEX inputs (Apr 3, 2026)

**Commit:** `unreleased`

- Bunni is now blocked from DEX crawl intake and DeFiLlama pool processing instead of being treated as a live venue
- Retained-pool filtering, challenger publication, and `dex_prices` publication all ignore Bunni even if stale or staged rows try to reintroduce it
- Pool-challenge replacement marks and promoted DEX bridge inputs can no longer be dragged back toward peg by dead-venue Bunni rows

---

## v3.93 - RedStone USR provider-config drift cleanup (Apr 3, 2026)

**Commit:** `unreleased`

- Removed `USR` from the exact-case RedStone tracked subset after the live RedStone API stopped returning that symbol
- The RedStone pricing lane no longer spends transport budget retrying a symbol the provider does not currently serve
- Provider-config audit and merge-gate validation now pass without masking real RedStone coverage drift

---

## v3.92 - Retained-pool DEX bridge publication (Apr 3, 2026)

**Commit:** `unreleased`

- `dex_prices` now publishes only from the final retained priced-pool set after the full liquidity scoring filters run
- Raw discovery observations that fail dedupe or retained-pool admission can no longer leak into promoted DEX bridge sources or `dexPriceCheck`
- Primary-pricing DEX bridge inputs now stay aligned with challenger publication and liquidity UI detail

---

## v3.91 - Protocol-level pool-challenge divergence gating (Apr 2, 2026)

**Commit:** `unreleased`

- Pool challenge divergence is now evaluated from one TVL-weighted median price per protocol, not from any single challenger pool
- A lone bad pool can no longer make an otherwise agreeing protocol count as independent corroboration for price replacement
- Replacement still requires at least two protocol-level challenger medians to diverge, and the final replacement price is still the TVL-weighted median across those corroborating protocol groups
- This prevents large but malformed pool prints from dragging severe depegs back toward peg on the published stablecoins snapshot

---

## v3.9 - Explicit source semantics, cluster-median publication, and fallback identity hardening (Mar 30, 2026)

**Commit:** `unreleased`

- Pricing sources now carry explicit freshness kind, max trusted age, upstream-timestamp support, single-source authority, and market-capability metadata in the canonical registry
- High-confidence consensus now publishes the winning cluster median instead of one agreeing member's raw price
- The internally selected best cluster member is still preserved for provenance and downstream policy, separate from the published cluster-median mark
- DefiLlama list quotes now enter primary pricing as typed inputs with explicit observed-time provenance
- DEX bridge freshness now preserves per-source timestamps from `price_sources_json` instead of flattening them to the row write time
- DefiLlama contract fallback now prefers canonical tracked deployment identities, validates quotes before claiming the asset, and can probe multiple exact tracked coin ids
- DexScreener fallback now prioritizes exact-target assets under the request cap and still keeps symbol search reserved for addressless assets only
- Pyth confidence weighting is now smoother across medium-confidence prints, RedStone now needs at least 60% venue agreement, and pricing provider audits now run in CI

---

## v3.8 - Validated DefiLlama fallback admission and exact-target DexScreener gating (Mar 30, 2026)

**Commit:** `unreleased`

- DefiLlama pass 1 and pass 1b now validate quotes against peg-aware bounds before marking an asset as resolved
- An unreasonable DL contract quote can no longer block later CoinMarketCap, Jupiter, or DexScreener fallbacks in the same run
- DexScreener symbol search is now disabled whenever the asset already has a canonical exact chain+address lookup path
- Symbol-only DexScreener recovery remains available only for addressless assets with a unique tracked symbol

---

## v3.7 - Protocol-aware DEX hardening estimators and provider-config cleanup (Mar 24, 2026)

**Commit:** `unreleased`

- GeckoTerminal probing now collapses pools to one TVL-weighted-median price per protocol before taking the cross-protocol weighted median
- Pool challenge replacement now uses corroborating divergent protocol groups instead of a raw all-pool weighted mean
- This makes DEX hardening less sensitive to repeated same-protocol pools and easier to explain operationally
- Provider-config audit tests now guard CEX and RedStone allowlists against duplicate or stale untracked entries
- The stale untracked `sUSDe` RedStone allowlist entry was removed

---

## v3.6 - Explicit source freshness provenance for live prices (Mar 24, 2026)

**Commit:** `unreleased`

- Stablecoin payloads, peg-summary outputs, and `price_cache` rows now preserve `priceObservedAtMode` alongside `priceObservedAt`
- Primary consensus now carries freshness provenance per source and resolves a conservative effective mode for the selected price
- Hard single-source prices remain depeg-authoritative only when they retain source-native freshness provenance
- Hard single-source prices whose freshness is only local fetch time now stay `confirm_required` downstream
- Older cached rows remain backward-compatible and do not automatically lose authority just because they predate explicit freshness-mode storage

---

## v3.5 - Independent FX recovery during cached fallback (Mar 23, 2026)

**Commit:** `unreleased`

- Cached-fallback FX runs now keep probing Open Exchange Rates, Chainlink reference feeds, and gold-api.com instead of freezing those recovery paths until Frankfurter recovers
- A single stale intraday peg can no longer trap the whole FX lane in repeated cached fallback when an independent overlay source can refresh it
- If those independent probes restore fresh full-set fiat coverage, the run exits cached fallback immediately and resets the fallback streak
- Operator metadata still records the failed Frankfurter / mirror transport path, but no longer exaggerates the duration of a recovered subset outage

---

## v3.4 - Replay-safe trusted-price continuity for confirmed depegs (Mar 23, 2026)

**Commit:** `unreleased`

- Previous-trusted severe-depeg continuity now also consults fresh replay-safe `price_cache` rows instead of relying only on the immediately previous stablecoins publication
- A temporarily `low` or unusable stablecoins run no longer causes the next fallback-validation pass to forget an already corroborated open depeg
- Cached replay can therefore keep publishing the last fresh authoritative depeg price through brief corroboration gaps instead of flapping to `N/A` on detail surfaces
- This specifically closes the intermittent USR-style gap where PSI could still explain the depeg from replay-safe state while the detail page lost its current price

---

## v3.3 - Source-aware trust, observed-time freshness, and weak-price jump quarantine (Mar 22, 2026)

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

## v3.2 - Identity-safe enrichment, severe-downside publication guards, and replay-safe DEX quote derivation (Mar 22, 2026)

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

## v3.1 - Canonical DEX token identity and non-overlapping DEX consensus (Mar 22, 2026)

**Commit:** `unreleased`

- Runtime DEX parsing no longer learns new token ownership from DeFiLlama or subgraph symbol strings
- Addressed unknown tokens are dropped instead of falling back to symbol matches in price-bearing DEX paths
- DeFiLlama pools with `underlyingTokens` now match tracked assets by canonical addresses only
- Promoted per-protocol DEX bridge sources now require corroboration, or the absence of non-DEX voices, before entering primary consensus
- The overlapping `dex-promoted` aggregate is now withheld whenever promoted per-protocol DEX bridge data exists for the same asset

---

## v3.0 - Cadence-valid FX carry-forward semantics (Mar 20, 2026)

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
- Live consensus and enrichment logic runs through `worker/src/lib/price-consensus.ts`, `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts`, and `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts`
