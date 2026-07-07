# Pricing Pipeline Methodology - Version Timeline - Archive

Older entries moved from [pricing-pipeline-timeline.md](./pricing-pipeline-timeline.md) to keep routed reads small; the live file keeps the most recent entries.

---

## v6.08 - Scoped live-parent wrapper price repair (May 24, 2026)

- sBOLD and yBOLD can publish ERC-4626 NAV prices from BOLD when BOLD's same-run consensus is fresh and high-confidence
- KAST USDK and XO Cash can inherit fresh high-confidence wM pricing as scoped M0 extension units

---

## v6.07 - Curated production price-gap closure (May 24, 2026)

- `mnee-mnee` and `veur-vnx` now use the allowlisted CoinGecko low-volume fallback when DefiLlama supplies circulation but no usable price
- `cadd-cad-digital`, `jpym-mento`, `zarm-mento`, and `xofm-mento` can publish scoped `protocol-redeem` FX-par prices when the relevant CAD/JPY/ZAR/XOF reference is fresh or static
- CADD and the Mento JPY/ZAR/XOF stables can repair DefiLlama zero-supply rows from verified deployments and current FX references when DL chart history is absent or below the tracked repair floor

---

## v6.06 - DexScreener symbol-search retirement (May 22, 2026)

- The last-resort DexScreener symbol-search fallback no longer calls `/latest/dex/search`
- Production probes showed Worker-side upstream refusals while the lane resolved zero prices in recent stablecoin sync runs
- DexScreener exact-address fallback remains available through `dexscreener-prices`; addressless assets without another usable fallback remain explicitly missing

---

## v6.05 - DexScreener address breaker hardening (May 20, 2026)

- DexScreener exact-address primary augmentation is now explicit opt-in through `ADDRESS_PRICE_PROVIDERS_ENABLED`
- Unset address-provider configuration defaults to DexPaprika plus configured key-backed providers, avoiding quarter-hourly calls to DexScreener's Cloudflare/WAF-protected public token endpoint
- Blocked or locally skipped address-provider runs are neutral for circuit-breaker state; only actual upstream attempts can fail the provider breaker

---

## v6.04 - DexScreener address augmentation throttle (May 18, 2026)

- DexScreener exact-address primary augmentation is now capped at one 30-address batch per stablecoin sync
- The address augmentation run stops immediately when DexScreener returns a hard upstream refusal such as `429` / Cloudflare 1015 instead of continuing through the remaining optional batches
- Valid empty DexScreener token-batch responses still count as healthy coverage misses, preserving sparse-address breaker semantics while reducing repeated rate-limit opens

---

## v6.03 - XOF secondary FX peg support (May 14, 2026)

- West African CFA franc pegs now have explicit XOF metadata, secondary daily FX references, chart reconciliation, and deterministic validation bounds
- `xofm-mento` can be tracked as an active XOF-pegged stablecoin instead of being forced into OTHER or rejected by peg metadata validation
- `peggedXOF` uses the same dated `fawazahmed0/currency-api` secondary FX cadence as CNH, RUB, UAH, ARS, KGS, NGN, and VND for live sync, realtime fallbacks, and historical backfills
- Price validation now classifies XOF as `fiat_fx` with explicit USD/XOF hardcoded bounds for no-reference guardrails
- The CoinGecko native-peg lane remains disabled for XOF because CoinGecko does not currently expose a usable `xof` simple-price quote

---

## v6.02 - Derivative and redemption-par gap closure (May 13, 2026)

- Active assets with observable supply but missing market prices can now resolve through guarded parent inheritance, fee-adjusted redemption inheritance, or scoped redemption-par references
- `m-m0` inherits the tracked `wm-m0` live price through the same trusted-parent gate used by downstream M0 extension units
- `weusd-picwe` inherits tracked `usdc-circle` pricing with the documented 1% redemption-fee haircut, so market cap reflects the bounded USDC exit rather than a missing secondary-market quote
- `sofid-sofi`, `usbd-bima`, and `usdq-quill` can publish nominal `protocol-redeem` USD parity when active supply is observable and the redemption path is already source-reviewed in the backstop registry
- `chfau-allunity` can publish `protocol-redeem` CHF parity only when the current CHF/USD FX reference is fresh or static; stale or absent FX data fails closed

---

## v6.01 - Composite-parent NAV inheritance freshness (May 13, 2026)

- Protocol-backed NAV wrappers can inherit from fresh same-run high-confidence composite parent prices even when the composite's oldest displayed component timestamp is older than one short-window source
- `gtusdc-gauntlet` recovers its ERC-4626 `protocol-redeem` price from on-chain `convertToAssets(1 share)` times the tracked `usdc-circle` parent instead of publishing a DEX/GeckoTerminal market price
- The fallback applies only to replay-safe composite parents with a fresh `priceSyncedAt`; low-confidence, stale-sync, cached, single-source, or non-replay-safe parent prices still cannot upgrade into child `protocol-redeem` prices
- The CoinGecko drift status comparison ignores frozen archive rows, so discontinued assets such as BUCK do not dominate the active price-drift watchlist

---

## v6.0 - Moralis quota-bounded exact-address augmentation (May 13, 2026)

- Moralis exact-address augmentation now uses 100-token batches and is capped at 3 batch requests per 15-minute sync, reducing worst-case daily usage from about 96k CUs/day to about 28.8k CUs/day at the current cadence
- `moralis-address` remains an optional weight-1 soft primary-consensus candidate controlled by `ADDRESS_PRICE_PROVIDERS_ENABLED`
- CoinGecko-only detail pages now record circuit health from upstream transport success instead of stale or empty per-asset history, so expected history gaps fall back to local supply history without opening the source-wide `coingecko-detail-platforms` breaker

---

## Operator research - DIA audit-only provider probe (May 12, 2026)

- Added a manual DIA exact-address probe for below-target source-depth rows; it records hit rate, freshness, source metadata, and agreement against Pharos prices without publishing prices or changing source-depth counts
- DIA remains research-only pending false-positive review, capacity/circuit approval, and a separate methodology decision before any consensus or depeg-authority use

---

## v5.99 - Free exact-address price augmentation (May 12, 2026)

- Added targeted exact-address primary augmentation for assets whose previous publication had fewer than 3 consensus sources or no price
- Current provider set is DexScreener exact token endpoint, DexPaprika, GeckoTerminal simple token price, Alchemy Prices, Moralis token prices, and Birdeye for Solana
- Targets come only from canonical `asset.address`, `contracts`, or `tradedContracts` metadata and require exact chain+address identity; symbol search remains confined to the existing final DexScreener fallback pass
- The new sources are weight-1 soft fallback/search-family voices: they can improve source depth and normal corroboration but are non-replay-safe and cannot single-source confirm depegs
- `ADDRESS_PRICE_PROVIDERS_ENABLED` can restrict the provider set or disable it with `none`; unset auto-enables no-key providers plus configured key-backed providers

---

## v5.98 - Live-reserve NAV primary pricing (May 12, 2026)

- Matched live-reserve NAV snapshots can now enter primary consensus as hard protocol price sources
- `chainlink-nav` and `superstate-liquidity` read authoritative `reserve_composition` rows matched to `reserve_sync_state.last_success_at`
- USD NAV rows publish directly, while non-USD NAV rows such as EUTBL convert through fresh/static FX references before entering USD consensus
- `curve-dex` joins promoted DEX protocol lanes from `dex_prices.price_sources_json`
- Binance `BFUSDUSDT` and `BFUSDUSDC` markets convert through tracked USDT/USDC USD pairs, with overlapping Binance-derived DEX aggregate promotion suppressed
- `usyc-hashnote` and `ustb-superstate` now have verified Pyth feed metadata, and `syrupusdc-maple` includes Maple's verified Solana syrupUSDC mint for DEX discovery coverage

---

## v5.97 - Registry source-family normalization (May 12, 2026)

- Pricing source registry entries now carry explicit `depegSourceFamily` metadata, and downstream policy expands composite source labels before applying replay-safety, pool-challenge, fallback-only, depeg-authority, and severe-downside corroboration checks
- CoinGecko-family and DefiLlama-family variants collapse for independence checks; CoinMarketCap and DefiLlama contract fallback are treated as list aggregators, while fallback/search lanes remain non-authoritative
- Promoted DEX protocol lanes keep protocol-specific `dex:*` families instead of being collapsed into one generic DEX family, so source-depth reporting and depeg confirmation can distinguish independent protocol evidence
- Seven verified `pythFeedId` metadata additions expand coverage through the existing Pyth Hermes hard-oracle lane; this does not add a new provider, source family, or trust tier
- The source-depth audit script is an operator measurement harness for candidate, agreeing, and depeg-authoritative source distributions; it does not change live pricing selection

---

## v5.96 - Yearn yBOLD NAV wrapper pricing (May 12, 2026)

- Yearn yBOLD is now tracked as a first-class BOLD strategy-vault variant and prices through the existing guarded ERC-4626 NAV lane
- `ybold-yearn` is admitted through Ethereum on-chain total supply and publishes `protocol-redeem` pricing from `convertToAssets(1 share)` multiplied by the tracked `bold-liquity` parent price
- `sbold-k3-capital` and `ybold-yearn` are both covered by regression tests for BOLD-derived ERC-4626 NAV pricing
- The parent-trust gate, parent provenance metadata, and 0.5-10.0 share-to-asset bounds remain unchanged

---

## v5.95 - Low-volume CoinGecko fallback for DL-listed gaps (May 12, 2026)

- Selected DefiLlama-listed stablecoins with null DL prices can now recover through the existing relaxed CoinGecko low-volume lane while keeping DefiLlama as the supply source
- `usp-pareto-credit` and `tryb-bilira` can use `coingecko-low-volume` fallback pricing when CoinGecko has a positive row inside the relaxed low-volume freshness window and all earlier missing-price passes fail
- The recovery is explicitly allowlisted, keeps `priceConfidence: fallback`, and does not change the strict primary CoinGecko freshness gate
- DefiLlama supply rows remain authoritative; the new pass only fills missing price provenance and cannot overwrite an already-published primary price

---

## v5.94 - Zephyr Scanner supplemental pricing (May 12, 2026)

- ZSD and ZYS now use Zephyr Scanner live-stats telemetry for official native-chain supply
- `zsd-zephyr-protocol` keeps CoinGecko as the preferred market price when available, but no longer relies on CoinGecko market cap for supply
- `zys-zephyr-protocol` uses official ZYS circulation and share price because neither CoinGecko nor DefiLlama exposes the yield-share wrapper
- `zephyr-scanner` is registered as an explicit pricing source with no dedicated breaker; the fetch remains scoped to the supplemental Zephyr asset path

---

## v5.93 - Jupiter sparse response breaker accounting (May 12, 2026)

- Jupiter V3 sparse no-quote rows now count as healthy empty coverage instead of malformed provider responses
- The `jupiter-prices` breaker still records failures for non-OK responses and malformed envelopes, but a decimals-only row for an unsupported mint no longer opens the circuit
- Quoted rows still require `usdPrice`, `decimals`, fresh `blockId`, optional liquidity gating, and peg-aware validation before a price can be accepted

---

## v5.92 - Expanded NAV-wrapper authoritative pricing (May 12, 2026)

- Expanded protocol-backed authoritative pricing to newly tracked NAV wrappers, added tracked-base inheritance for Initia iUSD and Movement USDCx, and admitted Spark Savings USDC through curated on-chain supplemental supply before pricing overrides run
- `susdc-spark`, `gtusdcp-gauntlet`, `steakusdt-steakhouse`, `steakusdc-steakhouse`, `srusde-strata`, `savusd-avant`, `susn-noon`, and `syzusd-yuzu` now use guarded ERC-4626 `convertToAssets(1 share)` pricing when their tracked parent assets are fresh and replay-safe
- `iusd-initia` now inherits tracked `ausd-agora` pricing, `usdcx-movement` inherits tracked `usdc-circle` pricing, and `sgho-aave` uses a protocol-specific `previewRedeem(uint256)` quote against tracked `gho-aave`
- `susdc-spark` can now appear in the stablecoins sync even without a DefiLlama or CoinGecko market row by using curated Ethereum vault supply, after which the authoritative NAV override supplies the live price
- Existing parent-trust gates, parent provenance metadata, and NAV ratio bounds are unchanged

## v5.91 - Post-probe authoritative override refresh (May 12, 2026)

- Protocol-backed authoritative price overrides are recomputed after fallback enrichment and GeckoTerminal probing instead of reusing the pre-enrichment override map
- `usdk-kast` and `xo-exodus` can recover from `priceSource: missing` when `wm-m0` becomes a fresh high-confidence parent during the same sync run
- The parent-trust guard remains unchanged: low-confidence, stale, cached, or non-replay-safe parent prices still cannot upgrade into `protocol-redeem` child prices
- The earlier pre-enrichment override pass is retained so assets with already trusted parents still avoid unnecessary fallback probing

---

## v5.09 - Addressless DexScreener exact fallback from tracked metadata (May 12, 2026)

- DexScreener exact fallback can now use curated tracked contract metadata when a DefiLlama stablecoin row has no address
- `usx-dforce` can recover from `priceSource: missing` through its tracked Base USX contract when DexScreener publishes a sufficiently liquid exact-address market
- The change does not use stale CoinGecko rows and does not enable symbol search when exact tracked contracts exist
- Metadata-derived DexScreener targets require the matched pool token symbol to equal the asset symbol, preventing wrapper quotes such as `cUSDO` from being accepted for `USDO`
- Existing upstream-provided addresses still take precedence; tracked metadata contracts are only used for addressless rows

---

## v5.08 - DefiLlama EVM contract fallback casing normalization (May 12, 2026)

- Normalized EVM address casing before DefiLlama `/coins` contract fallback lookups so checksummed metadata addresses match lower-case upstream price keys
- `usg-tangent` can now recover from `priceSource: missing` when DefiLlama publishes the live USG contract quote under a lower-case EVM address
- The exact-symbol guard remains in place, so `stkGHO` is still not accepted for `sgho-aave`
- Non-EVM identifiers, including Solana mints, keep their original case because those addresses are case-sensitive

---

## v5.07 - Idle CDO virtualPrice authoritative price provider (May 12, 2026)

- Added an Idle Perpetual Yield Tranches authoritative price provider that reads `virtualPrice(address tranche)` on the CDO contract and multiplies the underlying-denominated NAV by the tracked parent asset's live price
- `aa-falconx-mev-capital` now publishes a `protocol-redeem` high-confidence NAV from the CDO `virtualPrice` reading and the tracked `usdc-circle` parent price
- The provider reuses parent-trust gating, parent provenance metadata, and the 0.5-10.0 NAV bound from the ERC-4626 NAV lane

---

## v5.06 - ERC-4626 NAV authoritative price provider (May 12, 2026)

- Added a generic ERC-4626 NAV authoritative price provider that prices wrapper vault tokens from on-chain `convertToAssets(1 share)` times the tracked parent's live price
- `susdt-spark`, `gtusdc-gauntlet`, `yvusdc-yearn`, `stkgho-umbrella-aave`, and `sbold-k3-capital` now publish `protocol-redeem` high-confidence prices when their parents already price through consensus
- Each vault override carries parent provenance metadata and rejects degenerate quotes outside the 0.5-10.0 share-to-asset bound

---

## v5.05 - Authenticated Jupiter gateway support (May 11, 2026)

- `sync-stablecoins` can now pass `JUPITER_API_KEY` through the Solana fallback pass so official Jupiter Price API V3 requests include the `x-api-key` header
- The change does not promote Jupiter in source ordering: it remains a bounded fallback for tracked Solana mints that are still missing after primary consensus, authoritative overrides, DefiLlama contract lookup, and CoinMarketCap enrichment
- Jupiter responses still require the documented V3 quote fields, a fresh Solana block reference, and peg-aware validation before any fallback price is accepted

---

## v5.04 - Source freshness and independent corroboration hardening (May 10, 2026)

- Primary candidate admission now uses a registry-backed freshness gate for timestamped sources, including stale and future-skew rejection for Bitstamp, Coinbase, oracles, Curve, CoinGecko-derived rows, and promoted DEX protocol lanes
- Promoted DEX protocol lanes are freshness-checked per source before admission, so a fresh parent `dex_prices` row cannot carry a stale protocol-level price into consensus
- Severe fixed-peg downside publication now counts independent source families instead of raw candidates; correlated CoinGecko plus DefiLlama-list downside evidence no longer satisfies corroboration on its own
- Tracked-base authoritative inheritance now requires a fresh, replay-safe, high-confidence or explicitly authoritative parent and preserves parent provenance on accepted inherited overrides
- DefiLlama contract fallback and CoinMarketCap category fallback now preserve upstream quote timestamps and validate response shape before recording provider success; stale, low-confidence, wrong-symbol, malformed, or apparently truncated fallback responses no longer look like healthy empty coverage
- Jupiter fallback now accepts documented Price API V3 payloads without relying on undocumented liquidity fields, validates `blockId` against Solana current slot freshness, and treats malformed OK responses as provider failures
- DexScreener fallback now separates exact-address provenance from last-resort symbol-search provenance and restricts symbol search to configured chains with USD-like quotes, minimum pair age, 24h volume, and liquidity
- The methodology now documents the intentional trust-tier-first low-confidence selection policy and the midpoint-average estimator used for even-sized consensus clusters

---

## v5.03 - DEX source telemetry and direct-API fetch hardening (May 5, 2026)

- DEX source admission now emits structured skip reasons for stale bridge rows, malformed source snapshots, missing pricing-source registry mappings, below-threshold protocol TVL, and promoted DEX candidates rejected for lacking corroboration
- DEX-inclusive stablecoin prices can expose `priceSourceConfidenceProfile`, summarizing accepted protocol DEX lane count, freshest DEX lane age, and aggregate-only reliance
- Direct DEX API fetches now share a bounded `15 s` request policy, run independent protocol fetches with concurrency `2`, and use deterministic pagination caps with resume markers instead of silent truncation
- Direct-API and staged-pool merge metadata now count accepted protocol-chain lanes and exclusions by reason, protocol, chain, threshold, and identity-conflict dimension for operator diagnostics

---

## v5.02 - ARS, KGS, and NGN non-USD peg hardening (May 5, 2026)

- WARS (ARS) and cNGN (NGN) can validate weak live USD marks against direct native-peg and daily FX references; KGST (KGS) uses daily FX references plus deterministic bounds because CoinGecko does not expose a native `kgs` quote
- KGS and NGN use the same `fawazahmed0` secondary FX cadence semantics as CNH, RUB, UAH, and ARS for live sync and historical backfills
- MYR, KRW, KGS, and NGN now retain deterministic fallback price bounds even during no-reference validation paths
- Direct-API protocol DEX bridges (`meteora-dex`, `pancakeswap-dex`, `aerodrome-dex`, `velodrome-dex`) are registered as first-class soft-DEX pricing families so they can contribute directly to primary consensus when promoted

---

## v5.01 - MYR and KRW peg-currency support (Apr 29, 2026)

- FX cron requests MYR and KRW from Frankfurter and validates them against per-peg bounds
- Native-peg implied-price lane corroborates MYR / KRW depegs via direct CoinGecko `myr` / `krw` quotes
- Stablecoin charts reconciliation, price-validation `classifyPegClass`, and FX cadence metadata cover the new pegs so MYRC and KRWQ can be tracked through the existing Frankfurter / `fawazahmed0` / ExchangeRate-API FX lane and the CoinGecko native-peg corroboration lane

---

## v5.0 - Pricing pipeline comprehensive hardening (Apr 17, 2026)

- Pool challenge replacement now updates `allPrices` so severe-downside corroboration carry-through uses the replacement source instead of stale pre-replacement candidates
- `curve-oracle` now enforces a 5-minute on-chain staleness guard using the aggregator block timestamp and records against its own dedicated circuit breaker
- `curve-onchain`, Bitstamp, and Coinbase now publish upstream-observed freshness provenance rather than stamping rows as local-fetch time
- NAV tokens are excluded from pool-challenge downgrade and replacement because their wide clustering threshold makes pool-level divergence a poor signal
- Cluster tiebreak now prefers hard-tier clusters over equal-weight soft-tier clusters before falling through to spread and peg-proximity rules
- Two-source clusters composed only of list-style aggregators (CoinGecko, DefiLlama, DefiLlama-list) are now downgraded to `single-source` regardless of which two combine, closing the CoinGecko + DefiLlama-detail tautology in addition to the previously-downgraded CG + DL-list combination
- Replay cache now enforces per-source max trusted age alongside the composite 6-hour cap so replay cannot keep a source active beyond its native freshness window
- DefiLlama `/coins` contract-price fallback and DexScreener dex-liquidity / dex-discovery fallbacks now gate on and record against their own dedicated circuit breakers instead of reusing unrelated breaker state
- A lone promoted DEX protocol is admitted only when no non-DEX source exists, or when a hard market/oracle/protocol source agrees within threshold. Two or more promoted DEX protocols are admitted as candidate sources; consensus then determines agreement.
- Binance short-circuits to the secondary host on HTTP 5xx / 429 responses instead of retrying the first host, shortening outage detection latency
- RedStone solo-retry is bounded to 5 requests per run and spaced to respect the Worker's per-trigger connection budget
- GT-probe evidence rejection now downgrades the pre-GT primary to low-confidence when divergence was significant, rather than silently discarding the probe
- Provider diagnostics and GT-probe statistics are now surfaced on `/api/status` for operator visibility into the same fields `sync-stablecoins` already persists

---

## v4.38 - Corroborated severe-depeg pool challenge protection (Apr 15, 2026)

- Pool challenge still downgrades confidence when large DEX protocol groups disagree with a selected severe-depeg primary price
- Pool challenge no longer replaces that selected price when at least two live candidate sources independently corroborate severe downside and at least one of them is depeg-authoritative
- The same severe-downside candidate evidence satisfies the temporal-jump guard when the previous trusted price was near peg
- This prevents near-peg or stale DEX liquidity from overwriting a USR-style severe depeg already confirmed by CoinGecko, DefiLlama-list, and Pyth

---

## v4.37 - Severe-depeg corroboration continuity through validation (Apr 15, 2026)

- Primary severe-downside corroboration evidence is now preserved through the later prevalidation and post-enrichment validation passes when the selected primary price remains unchanged
- Low-confidence severe depeg prices can stay published when multiple live candidate sources independently confirm the downside even if they do not form a tight high-confidence cluster
- The severe-downside guardrail is unchanged for genuinely single-source prices because candidate evidence is reused only when the current asset price, source, and confidence still match the primary result
- This prevents USR-style `N/A` flapping after primary pricing accepted a corroborated severe depeg and a later generic validation pass lost the candidate-price evidence

---

## v4.36 - Blocked Binance host accounting (Apr 15, 2026)

- Binance all-host 403/451 blocks from Worker egress are now recorded as no-contribution provider blocks rather than source outages
- Diagnostics still persist every attempted Binance endpoint, status, and snippet so operators can see the provider-edge block
- Binance contributes zero prices in this state; consensus continues through the remaining hard venue/oracle/protocol inputs

---

## v4.35 - No-candidate Jupiter breaker recovery (Apr 15, 2026)

- Jupiter no-candidate runs now close stale-open breaker state without making an external provider health request
- This reflects that authoritative pricing removed all current Jupiter fallback candidates, so a provider-edge block is not part of the active pricing path
- Future eligible Solana fallback candidates still use the normal Jupiter circuit breaker and provider diagnostics path

---

## v4.34 - Binance host failover for Worker egress (Apr 15, 2026)

- Binance ticker fetches now try `data-api.binance.vision` first and fall back to `api.binance.com` before recording a failed source outcome
- The fallback was added after production Worker diagnostics showed HTTP 403 from the market-data mirror while local provider audits still saw healthy `USDTUSD` and `USDCUSD` Binance markets
- Binance diagnostics preserve each attempted endpoint so operators can distinguish mirror-specific blocks from parser/config problems

---

## v4.33 - Jupiter official gateway fallback (Apr 15, 2026)

- Jupiter fallback and health probes now use `https://api.jup.ag/price/v3` instead of the Lite gateway
- This follows repeated Worker-side Cloudflare 403 block pages from `lite-api.jup.ag` while the official V3 gateway continued returning the same response shape
- Jupiter remains a best-effort Solana fallback behind primary consensus, authoritative protocol-backed prices, liquidity gates, and peg-aware validation

---

## v4.32 - Provider diagnostics and authoritative fallback gating (Apr 14, 2026)

- Binance and Jupiter price attempts now persist compact diagnostics into `sync-stablecoins` cron metadata, including endpoint, status, candidate counts, parsed/response counts, matched counts, and sanitized non-OK snippets
- Protocol-backed live overrides are pre-applied before fallback enrichment and re-applied after GeckoTerminal probing, so known redeemable wrappers and extension assets do not hit fallback sources before their authoritative price is available
- Jupiter can run a bounded health probe when a previously open circuit has no remaining fallback candidates, allowing a stale-open breaker to recover once the provider is reachable

---

## v4.31 - Curated-contract price fallback and USDnr M0 inheritance (Apr 13, 2026)

- DefiLlama contract-price fallback now tries curated tracked `contracts` metadata when the upstream stablecoin row has no `address`
- `ctusd-citrea` can resolve through its fresh DefiLlama `citrea:<contract>` quote without relying on stale CoinGecko rows or symbol search
- `usdnr-nerona` now inherits tracked `wm-m0` live pricing and historical replay through the existing authoritative `protocol-redeem` lane used by other M0 extension assets

---

## v4.3 - CoinGecko simple-price upstream freshness gate (Apr 11, 2026)

- CoinGecko `/simple/price` requests now include `last_updated_at`
- Rows with a CoinGecko upstream timestamp older than the source trust window are excluded from primary consensus instead of being stamped as fresh local fetches
- When CoinGecko omits the timestamp despite the request, the row remains local-fetch provenance for backwards compatibility with partial responses

---

## v4.2 - Inherited wM pricing for M0 extension assets (Apr 10, 2026)

- `usdk-kast` and `xo-exodus` now inherit tracked `wm-m0` pricing through the authoritative `protocol-redeem` lane when the parent rail is available
- Historical depeg backfills for those extension assets replay the tracked `wm-m0` market series instead of relying on missing or thin child-market history
- This extends the tracked-base inheritance pattern already used for `usdai-usd-ai -> pyusd-paypal`

---

## v4.1 - Split DexScreener exact-vs-search breaker accounting (Apr 8, 2026)

- DexScreener pass 4 now keeps separate breaker state for exact token-address lookups and the last-resort symbol-search endpoint
- `dexscreener-prices` now reflects `/tokens/v1/{chainId}/{address}` availability only, while `dexscreener-search` tracks `/latest/dex/search`
- This prevents a flaky search endpoint from opening the same breaker that guards otherwise healthy exact-address recovery

---

## v4.0 - DexScreener request-budget walk-through for skipped fallback candidates (Apr 8, 2026)

- DexScreener pass 4 now spends its `10`-request budget on actual outgoing DexScreener calls instead of pre-slicing the first ten missing assets
- Higher-rank addressless rows that are skipped because their symbol is not unique no longer crowd out later exact-target or unique-symbol fallback candidates such as `CHFAU` or `ctUSD`
- This reduces false `dexscreener-prices` breaker opens during bad network windows because the pass has more chances to observe a healthy DexScreener response before it gives up

---

## v3.99 - Native-peg live publication guard and fill lane for non-USD fiat assets (Apr 7, 2026)

- Supported non-USD fiat assets can now replace materially divergent weak or mixed-source USD publications when a fresh direct native CoinGecko quote plus fresh FX reference implies a better live USD mark
- The same native lane can now fill a missing live price for supported non-USD fiat assets instead of falling straight to replay cache or `N/A`
- Native-implied live prices remain a fresh fallback-validation lane rather than a replay-safe consensus source, so they are not written into `price_cache` for later replay publication

---

## v3.98 - Daily-confirmed native-peg replay for non-USD fiat backfills (Apr 7, 2026)

- Historical CoinGecko market-chart replay now carries the configured CoinGecko API key through the backfill/admin path so native-fiat history can use authenticated transport consistently during broad repairs
- Supported non-USD fiat backfills now replay native-fiat history at daily cadence with a two-point confirmation window across a 36-hour gap tolerance instead of opening on isolated thin hourly prints
- Extreme single-point native crashes of 5,000 bps or more are still preserved even when the normal historical confirmation rule would otherwise suppress the event

---

## v3.97 - Generalized native-peg safeguards for non-USD fiat replay and routing (Apr 7, 2026)

- Supported non-USD fiat assets such as EUR, CHF, GBP, JPY, SGD, AUD, CAD, BRL, IDR, TRY, ZAR, PHP, MXN, RUB, and CNH/CNY can now consult fresh direct CoinGecko native-peg quotes before downstream depeg logic trusts `USD price / FX reference` on its own
- Historical backfill now prefers direct CoinGecko native-fiat history for those supported pegs and compares that series to the native `1.0` peg before it falls back to USD-denominated history
- The published cached USD price path still does not add a second CoinGecko-derived consensus source; this remains a downstream validation and historical replay hardening change

---

## v3.96 - Direct native-peg BRL corroboration for downstream depeg routing (Apr 7, 2026)

- Supported fiat-pegged assets such as `BRZ` can now consult a fresh direct CoinGecko native-peg quote before downstream depeg logic trusts `USD price / FX reference` on its own
- Pending depeg confirmation now uses that direct native quote first when it exists, instead of relying only on a derived USD comparison
- The published cached USD price path does not change; this hardens downstream validation and depeg routing against BRL-style reference drift

---

## v3.95 - USDAI inherits PYUSD redemption pricing (Apr 6, 2026)

- Base `usdai-usd-ai` now inherits tracked `pyusd-paypal` pricing in the authoritative override layer instead of trusting thin USDAI secondary-market prints
- Historical USDAI depeg backfills now replay the tracked PYUSD market series, so wrapper-specific CoinGecko/DefiLlama history no longer manufactures long false depeg streaks
- This keeps USDAI PegScore aligned with the token's documented instant-redemption semantics rather than with noise from sparse wrapper venues

---

## v3.94 - Blocked dead Bunni DEX inputs (Apr 3, 2026)

- Bunni is now blocked from DEX crawl intake and DeFiLlama pool processing instead of being treated as a live venue
- Retained-pool filtering, challenger publication, and `dex_prices` publication all ignore Bunni even if stale or staged rows try to reintroduce it
- Pool-challenge replacement marks and promoted DEX bridge inputs can no longer be dragged back toward peg by dead-venue Bunni rows

---

## v3.93 - RedStone USR provider-config drift cleanup (Apr 3, 2026)

- Removed `USR` from the exact-case RedStone tracked subset after the live RedStone API stopped returning that symbol
- The RedStone pricing lane no longer spends transport budget retrying a symbol the provider does not currently serve
- Provider-config audit and merge-gate validation now pass without masking real RedStone coverage drift

---

## v3.92 - Retained-pool DEX bridge publication (Apr 3, 2026)

- `dex_prices` now publishes only from the final retained priced-pool set after the full liquidity scoring filters run
- Raw discovery observations that fail dedupe or retained-pool admission can no longer leak into promoted DEX bridge sources or `dexPriceCheck`
- Primary-pricing DEX bridge inputs now stay aligned with challenger publication and liquidity UI detail

---

## v3.91 - Protocol-level pool-challenge divergence gating (Apr 2, 2026)

- Pool challenge divergence is now evaluated from one TVL-weighted median price per protocol, not from any single challenger pool
- A lone bad pool can no longer make an otherwise agreeing protocol count as independent corroboration for price replacement
- Replacement still requires at least two protocol-level challenger medians to diverge, and the final replacement price is still the TVL-weighted median across those corroborating protocol groups
- This prevents large but malformed pool prints from dragging severe depegs back toward peg on the published stablecoins snapshot

---

## v3.9 - Explicit source semantics, cluster-median publication, and fallback identity hardening (Mar 30, 2026)

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

- DefiLlama pass 1 and pass 1b now validate quotes against peg-aware bounds before marking an asset as resolved
- An unreasonable DL contract quote can no longer block later CoinMarketCap, Jupiter, or DexScreener fallbacks in the same run
- DexScreener symbol search is now disabled whenever the asset already has a canonical exact chain+address lookup path
- Symbol-only DexScreener recovery remains available only for addressless assets with a unique tracked symbol

---

## v3.7 - Protocol-aware DEX hardening estimators and provider-config cleanup (Mar 24, 2026)

- GeckoTerminal probing now collapses pools to one TVL-weighted-median price per protocol before taking the cross-protocol weighted median
- Pool challenge replacement now uses corroborating divergent protocol groups instead of a raw all-pool weighted mean
- This makes DEX hardening less sensitive to repeated same-protocol pools and easier to explain operationally
- Provider-config audit tests now guard CEX and RedStone allowlists against duplicate or stale untracked entries
- The stale untracked `sUSDe` RedStone allowlist entry was removed

---

## v3.6 - Explicit source freshness provenance for live prices (Mar 24, 2026)

- Stablecoin payloads, peg-summary outputs, and `price_cache` rows now preserve `priceObservedAtMode` alongside `priceObservedAt`
- Primary consensus now carries freshness provenance per source and resolves a conservative effective mode for the selected price
- Hard single-source prices remain depeg-authoritative only when they retain source-native freshness provenance
- Hard single-source prices whose freshness is only local fetch time now stay `confirm_required` downstream
- Older cached rows remain backward-compatible and do not automatically lose authority just because they predate explicit freshness-mode storage

---

## v3.5 - Independent FX recovery during cached fallback (Mar 23, 2026)

- Cached-fallback FX runs now keep probing Open Exchange Rates, Chainlink reference feeds, and gold-api.com instead of freezing those recovery paths until Frankfurter recovers
- A single stale intraday peg can no longer trap the whole FX lane in repeated cached fallback when an independent overlay source can refresh it
- If those independent probes restore fresh full-set fiat coverage, the run exits cached fallback immediately and resets the fallback streak
- Operator metadata still records the failed Frankfurter / mirror transport path, but no longer exaggerates the duration of a recovered subset outage

---

## v3.4 - Replay-safe trusted-price continuity for confirmed depegs (Mar 23, 2026)

- Previous-trusted severe-depeg continuity now also consults fresh replay-safe `price_cache` rows instead of relying only on the immediately previous stablecoins publication
- A temporarily `low` or unusable stablecoins run no longer causes the next fallback-validation pass to forget an already corroborated open depeg
- Cached replay can therefore keep publishing the last fresh authoritative depeg price through brief corroboration gaps instead of flapping to `N/A` on detail surfaces
- This specifically closes the intermittent USR-style gap where PSI could still explain the depeg from replay-safe state while the detail page lost its current price

---

## v3.3 - Source-aware trust, observed-time freshness, and weak-price jump quarantine (Mar 22, 2026)

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

- Runtime DEX parsing no longer learns new token ownership from DeFiLlama or subgraph symbol strings
- Addressed unknown tokens are dropped instead of falling back to symbol matches in price-bearing DEX paths
- DeFiLlama pools with `underlyingTokens` now match tracked assets by canonical addresses only
- Promoted per-protocol DEX bridge sources now require corroboration, or the absence of non-DEX voices, before entering primary consensus
- The overlapping `dex-promoted` aggregate is now withheld whenever promoted per-protocol DEX bridge data exists for the same asset

---

## v3.0 - Cadence-valid FX carry-forward semantics (Mar 20, 2026)

- FX refreshes now treat already-current daily references as a successful live carry-forward when they are still within expected source cadence
- Failed Frankfurter or mirror transports no longer automatically mark the published FX state as cached fallback when the underlying daily reference is still current
- Per-peg metadata preserves source dates and cadence semantics during carry-forward runs
- Status still degrades once the underlying daily references genuinely age out, rather than on transport failure alone

---

## v2.9 - Jupiter V3 freshness fix and exact DexScreener address fallback (Mar 20, 2026)

- Jupiter fallback no longer rejects V3 quotes solely because optional `createdAt` metadata is old
- Jupiter recovery continues to rely on liquidity gating and peg-aware validation
- DexScreener enrichment now prefers exact chain+address pool lookups before falling back to symbol search
- DexScreener search remains as the last fallback path under the same bounded request budget

---

## v2.8 - Tertiary full-set FX fallback for multi-source outages (Mar 20, 2026)

- Added ExchangeRate-API as a tertiary live full-set FX fallback
- Frankfurter remains preferred for the core fiat set
- The secondary `fawazahmed0/currency-api` mirrors still cover CNH/RUB/UAH/ARS and can backstop the wider fiat set
- Pricing methodology and About page now disclose ExchangeRate-API as an externally visible FX reference source

---

## v2.7 - Secondary FX full-set live fallback for Frankfurter outages (Mar 20, 2026)

- Expanded the dated secondary FX mirror path so it can backstop the wider fiat reference set
- Prevents immediate cached-only FX runs during Frankfurter outages when the secondary feed is healthy
- Preserves daily source-date semantics in per-peg FX metadata during that live fallback path

---

## v2.6 - Published DEX challenger snapshots and durable FX freshness metadata (Mar 19, 2026)

- Pool challenge and depeg confirmation now read dedicated challenger snapshots instead of depending on the visible top-pools subset
- Challenger coverage is persisted per stablecoin and falls back safely during migration gaps
- FX fallback runs now preserve source timestamps and source modes instead of implicitly refreshing them
- Health and status surfaces now distinguish usable FX freshness from underlying source freshness

---

## v2.5 - Kraken and Bitstamp primary pricing, Jupiter Solana fallback, Chainlink reference overlays (Mar 19, 2026)

- Added Kraken and Bitstamp as additional primary CEX pricing voices
- Added a Jupiter Price API fallback pass for unresolved Solana assets
- Added curated Chainlink EUR/USD, GBP/USD, JPY/USD, XAU/USD, and XAG/USD overlays for FX and commodity validation
- Status reporting now exposes Kraken, Bitstamp, and Jupiter participation explicitly

---

## v2.4 - Pairwise consensus hardening, RedStone freshness gate, authoritative override ordering (Mar 19, 2026)

- Consensus agreement now requires pairwise clustering instead of allowing transitive-source chains
- Fixed-peg assets stay on fixed-peg rules when peg references are temporarily unavailable
- Stale or aggregate-only RedStone rows are excluded before consensus
- Protocol-backed redeem-price overrides remain final after GeckoTerminal probing

---

## v2.3 - Per-protocol DEX bridge aggregation and top-pool challenge source split (Mar 18, 2026)

- DEX bridge persistence now stores one aggregated price source per protocol instead of repeating individual pools
- Pool challenge reads large current pools from `dex_liquidity.top_pools_json` instead of the consensus bridge payload
- Non-USD tracked stablecoin pairs now use peg-reference-aware conversion in direct-API DEX pricing

---

## v2.2 - Pool confirmation fix, peg-type-aware challenge, source quality gating (Mar 17, 2026)

- Added pool-level individual prices as a fourth depeg-confirmation source
- Made the pool-challenge threshold peg-type-aware
- Added Pyth-confidence and RedStone venue-agreement gating
- Downgraded CoinGecko-plus-DefiLlama-only agreement to `single-source`
- Preserved the full consensus source list in labels

---

## v2.1 - Consensus honesty: independent DL list price, GeckoTerminal probe, pool challenge (Mar 16, 2026)

- Removed the DefiLlama coins API from primary consensus because it mirrored CoinGecko data
- Added DefiLlama stablecoins-list pricing as an independent aggregator voice
- Added a GeckoTerminal pool probe for CoinGecko-only single-source assets
- Added a pool-challenge guard that can downgrade soft consensus and replace price with a TVL-weighted pool mean

---

## v2.0 - Multi-source consensus with oracle, CEX, and on-chain pricing (Mar 14, 2026)

- Replaced 2-source cross-validation with an 8-source weighted consensus system
- Added Pyth, Binance, Coinbase, RedStone, Curve on-chain pricing, and promoted DEX observations
- Introduced clustering-based consensus, price-confidence tagging, and the 4-pass enrichment pipeline

---

## v1.0 - Initial 2-source price cross-validation (Feb 1, 2026)

- Launched baseline pricing with CoinGecko as primary and DefiLlama as cross-validation
- Used simple comparison logic instead of clustering
- Added a basic DexScreener enrichment path for missing prices

---

## Notes

- Canonical machine-readable source: `shared/lib/pricing-pipeline-version.ts`
- Live consensus and enrichment logic runs through `worker/src/lib/price-consensus.ts`, `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts`, and `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts`
