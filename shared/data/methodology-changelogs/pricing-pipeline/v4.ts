import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const PRICING_PIPELINE_V4: readonly MethodologyChangelogEntry[] = [
    {
      version: "4.38",
      title: "Corroborated severe-depeg pool challenge protection",
      date: "2026-04-15",
      effectiveAt: 1776267900,
      summary:
        "Pool challenge and temporal-jump validation can still downgrade or scrutinize a selected severe-depeg primary price, but they no longer replace or reject that price when multiple live candidate sources corroborate severe downside and at least one is depeg-authoritative.",
      impact: [
        "Near-peg or stale DEX liquidity can no longer overwrite a severe depeg already corroborated by independent live candidates such as CoinGecko, DefiLlama-list, and Pyth",
        "The same severe-downside candidate evidence satisfies the temporal-jump guard when the previous trusted price was near peg",
        "The pool challenge remains active for weak or uncorroborated soft-source prices, and still replaces prices when independent DEX protocol medians are the only corroborating disagreement",
        "USR now preserves the market price near the live CoinGecko/DefiLlama/Pyth severe-depeg level while marking the result low-confidence when DEX pools disagree",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "4.37",
      title: "Severe-depeg corroboration continuity through validation",
      date: "2026-04-15",
      effectiveAt: 1776264600,
      summary:
        "Primary severe-downside corroboration evidence is now preserved through the later prevalidation and post-enrichment validation passes when the selected primary price remains unchanged.",
      impact: [
        "Low-confidence severe depeg prices can stay published when multiple live candidate sources independently confirm the downside even if they do not form a tight high-confidence cluster",
        "The severe-downside guardrail is unchanged for genuinely single-source prices because candidate evidence is reused only when the current asset price, source, and confidence still match the primary result",
        "Assets such as USR no longer flap to `N/A` after primary pricing accepted a corroborated severe depeg and a later generic validation pass lost the candidate-price evidence",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "4.36",
      title: "Blocked Binance host accounting",
      date: "2026-04-15",
      effectiveAt: 1776216000,
      summary:
        "Binance all-host 403/451 blocks from Worker egress are now treated as no-contribution provider blocks rather than source outages, while diagnostics keep the blocked endpoints visible.",
      impact: [
        "When every attempted Binance host returns 403 or 451, the run records diagnostics but closes the source-wide breaker instead of escalating a persistent false outage",
        "Binance contributes zero prices in that state, so consensus continues through Kraken, Bitstamp, Coinbase, Pyth, RedStone, Curve, DEX, CoinGecko, and DefiLlama inputs",
        "Transport errors, server errors, malformed responses, or successful responses with zero tracked matches still follow the normal failure diagnostics path",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "4.35",
      title: "No-candidate Jupiter breaker recovery",
      date: "2026-04-15",
      effectiveAt: 1776214200,
      summary:
        "Jupiter no-candidate runs now close stale-open breaker state without making an external health probe, reflecting that no eligible Solana fallback work remains after authoritative gating.",
      impact: [
        "If authoritative pricing removes all Jupiter fallback candidates, the stale `jupiter-prices` breaker can recover without spending a provider request",
        "The change prevents irrelevant provider-edge blocks from keeping the public circuit list open when Jupiter is not part of the current pricing path",
        "Future eligible Jupiter fallback candidates still go through the normal circuit breaker and provider diagnostics path",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "4.34",
      title: "Binance host failover for Worker egress",
      date: "2026-04-15",
      effectiveAt: 1776213300,
      summary:
        "Added a Binance ticker host failover after production Worker diagnostics showed the market-data mirror returning HTTP 403 while local audits still saw healthy Binance USD pairs.",
      impact: [
        "Binance pricing now tries `data-api.binance.vision` first and falls back to `api.binance.com` before recording the source as failed",
        "Provider diagnostics preserve each attempted Binance endpoint so operators can see which host succeeded or failed",
        "The change keeps the same tracked `USDTUSD` and `USDCUSD` market mappings and does not alter consensus weighting",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "4.33",
      title: "Jupiter official gateway fallback",
      date: "2026-04-15",
      effectiveAt: 1776212400,
      summary:
        "Moved Jupiter fallback probes from the Lite gateway to the official Price API V3 gateway after Worker egress repeatedly received Cloudflare 403 block pages from the Lite host.",
      impact: [
        "Jupiter fallback and health probes now use `https://api.jup.ag/price/v3` instead of the Lite gateway",
        "The source-level circuit can recover through the same official V3 response shape already used by the fallback parser",
        "The fallback remains best-effort, liquidity-gated, and downstream of authoritative protocol-backed prices",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "4.32",
      title: "Provider diagnostics and authoritative fallback gating",
      date: "2026-04-14",
      effectiveAt: 1776207600,
      summary:
        "Pricing provider attempts now emit durable diagnostics, and authoritative live overrides are applied before fallback enrichment so known redeemable wrappers do not poison fallback-source circuit breakers.",
      impact: [
        "`sync-stablecoins` cron metadata now records Binance and Jupiter attempt status, endpoint, candidate counts, response counts, matched counts, and sanitized snippets for non-OK responses",
        "Protocol-backed live overrides are pre-applied before fallback enrichment and re-applied after GeckoTerminal probing, preserving final authoritative price semantics while keeping inherited-price assets out of unnecessary fallback probes",
        "The Jupiter breaker can run a bounded health probe when no fallback candidates remain, allowing a previously open breaker to recover once the provider is reachable instead of staying stale-open indefinitely",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "4.31",
      title: "Curated-contract price fallback and USDnr M0 inheritance",
      date: "2026-04-13",
      effectiveAt: 1776082800,
      summary:
        "DefiLlama contract-price fallback now starts from curated tracked deployments when an upstream stablecoin row is addressless, and USDnr joins the M0 tracked-parent price inheritance path.",
      impact: [
        "Addressless DefiLlama stablecoin rows can now recover prices through exact curated `contracts` metadata instead of requiring the upstream row to carry its own `address` field",
        "`ctusd-citrea` can publish the fresh DefiLlama `citrea:<contract>` quote surfaced by the coins API without relying on symbol search or stale CoinGecko rows",
        "`usdnr-nerona` now inherits tracked `wm-m0` live pricing and historical replay through the existing authoritative `protocol-redeem` lane used by other M0 extension assets",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "4.3",
      title: "CoinGecko simple-price upstream freshness gate",
      date: "2026-04-11",
      effectiveAt: 1775901000,
      summary:
        "CoinGecko simple-price inputs now use the provider's upstream observation timestamp when available and drop stale rows instead of stamping them as fresh local fetches.",
      impact: [
        "Primary pricing requests `last_updated_at` from CoinGecko `/simple/price` and records it as upstream freshness when present",
        "CoinGecko simple-price rows older than the source trust window are excluded from primary consensus rather than being treated as current",
        "Downstream consumers such as PegScore and DEWS now see missing, lower-confidence, or non-CoinGecko corroborated inputs instead of replaying stale CoinGecko marks as fresh",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "4.2",
      title: "Inherited wM pricing for M0 extension assets",
      date: "2026-04-10",
      effectiveAt: 1775822400,
      summary:
        "Added authoritative tracked-base inheritance for M0 extension assets whose exact child-token market coverage is absent or too thin, " +
        "so price publication follows the executable parent rail instead of staying missing or trusting weak child-market prints.",
      impact: [
        "Live pricing now publishes `usdk-kast` and `xo-exodus` from the authoritative `protocol-redeem` lane by inheriting tracked `wm-m0` pricing when that parent rail is available",
        "Historical depeg backfills for those assets now replay the tracked `wm-m0` market series instead of relying on missing or thin child-market history",
        "This extends the same tracked-base inheritance pattern already used for `usdai-usd-ai -> pyusd-paypal`, keeping wrapper-style M0 extension assets aligned with their executable parent value",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "4.1",
      title: "Split DexScreener exact-vs-search breaker accounting",
      date: "2026-04-08",
      effectiveAt: 1775671200,
      summary:
        "The DexScreener fallback now records exact token-address lookups and last-resort symbol search under separate circuit breakers, " +
        "so a flaky search endpoint cannot suppress otherwise healthy exact-address recovery.",
      impact: [
        "`dexscreener-prices` now reflects only `/tokens/v1/{chainId}/{address}` availability in the late-stage stablecoin pricing fallback",
        "The symbol-search recovery path now records independently under `dexscreener-search`, which keeps search-specific failures visible without poisoning exact-address availability",
        "Public-health grouping excludes the search-only breaker so a best-effort addressless fallback issue does not count as a separate top-level availability circuit group",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "4.0",
      title: "DexScreener request-budget walk-through for skipped fallback candidates",
      date: "2026-04-08",
      effectiveAt: 1775665290,
      summary:
        "The DexScreener fallback budget now applies to actual outgoing requests instead of the first ten missing assets, " +
        "so high-rank addressless rows that are skipped for identity reasons cannot crowd out later valid fallback candidates.",
      impact: [
        "Pass 4 still prioritizes exact-target assets first and then larger circulating names, but it now walks the full sorted missing set until it spends the 10-request DexScreener budget",
        "Addressless non-unique symbols that are skipped without making a request no longer consume one of the candidate slots that can reach lower-rank unique-symbol recoveries such as CHFAU or ctUSD",
        "This reduces false `dexscreener-prices` breaker opens during bad network windows because the pass has more chances to record at least one healthy DexScreener response before giving up",
      ],
      commits: [],
      reconstructed: false,
    },
];
