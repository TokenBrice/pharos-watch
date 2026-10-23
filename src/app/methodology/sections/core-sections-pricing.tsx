import Link from "next/link";
import { median } from "@shared/lib/stats";
import {
  PRICING_PIPELINE_METHODOLOGY_CHANGELOG_PATH,
  PRICING_PIPELINE_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/constants";
import { ContentTable } from "@/components/table";
import {
  METHODOLOGY_LINK_CLASS,
  MethodologyDetails,
  MethodologyDiagramFlow,
  MethodologyFacts,
  MethodologyPreconditions,
  MethodologySectionShell,
  WorkedExample,
} from "../methodology-shared";
import { PRICING_PIPELINE_SECTION_CONTENT } from "@/lib/methodology-content";
import { METHODOLOGY_SECTION_ACCENT_CLASSES, CONFIDENCE_LEVEL_COLORS, METHODOLOGY_TABLE_ACCENT_CLASSES } from "@shared/lib/classification";
import { PRICING_SOURCE_REGISTRY, type PricingSourceKey } from "@shared/lib/pricing-source-registry";

type AddressProviderAvailability = { key: PricingSourceKey; enabled: boolean };
// Public inventory only; runtime admission remains owned by the Worker resolver/config.
const ADDRESS_PROVIDER_AVAILABILITY: readonly AddressProviderAvailability[] = [
  { key: "coingecko-onchain-address", enabled: true },
];

const CONSENSUS_EXAMPLE_SOURCES = [
  { label: "CoinGecko", price: 1.0001, weight: 2 },
  { label: "DL-list", price: 0.9999, weight: 1 },
  { label: "Binance", price: 1.0001, weight: 2 },
  { label: "Kraken", price: 1.0000, weight: 2 },
  { label: "Coinbase", price: 0.9998, weight: 2 },
  { label: "Curve", price: 1.0003, weight: 3 },
];
const consensusExampleMedian = median(CONSENSUS_EXAMPLE_SOURCES.map(({ price }) => price));
if (consensusExampleMedian === null) {
  throw new Error("The pricing consensus worked example requires at least one source.");
}
const CONSENSUS_EXAMPLE_MEDIAN = consensusExampleMedian.toFixed(5);

export function PricingPipelineMethodologySection({
  addressProviderAvailability = ADDRESS_PROVIDER_AVAILABILITY,
}: {
  addressProviderAvailability?: readonly AddressProviderAvailability[];
} = {}) {
  return (
    <MethodologySectionShell
      id={PRICING_PIPELINE_SECTION_CONTENT.id}
      title={PRICING_PIPELINE_SECTION_CONTENT.title}
      versionBadge={{ label: PRICING_PIPELINE_METHODOLOGY_VERSION_LABEL }}
      changelogPath={PRICING_PIPELINE_METHODOLOGY_CHANGELOG_PATH}
      versionNote="Version increments when price sources, consensus algorithm, enrichment passes, or validation rules change."
      changelogClassName={METHODOLOGY_SECTION_ACCENT_CLASSES.pricing.changelogHover}
    >
        {PRICING_PIPELINE_SECTION_CONTENT.markdownParagraphs.slice(0, 4).map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
        <p className="text-xs text-muted-foreground">
          {PRICING_PIPELINE_SECTION_CONTENT.historyLinks.map(({ label, href }, index) => (
            <span key={href}>
              {index > 0 && " · "}
              <Link href={href} className={METHODOLOGY_LINK_CLASS}>{label}</Link>
            </span>
          ))}
        </p>
        <MethodologyFacts
          facts={[
            { label: "Update cadence", value: "15m refresh" },
            { label: "Sources", value: "20+ live voices" },
            { label: "Output", value: "Price + confidence tag per asset" },
          ]}
        />
        <MethodologyPreconditions
          facts={[
            { label: "Minimum data", value: "At least 1 source must return a price; consensus requires 2+ for high confidence" },
            { label: "Circuit breakers", value: "Most live upstream families are breaker-gated: opens after 3 failures, probes every 30 min" },
            {
              label: "Failure behavior",
              value: "Degraded sources are excluded from consensus; enrichment pipeline fills remaining gaps; stale cache used as last resort",
            },
          ]}
        />
        <WorkedExample summary="Worked example: USDC price consensus across 6 sources">
          <p className="pharos-numeric">
            Sources: {CONSENSUS_EXAMPLE_SOURCES.map(({ label, price, weight }) => (
              `${label}=${price.toFixed(4)} (w${weight})`
            )).join(", ")}
          </p>
          <p className="pharos-numeric">
            Peg ref=1.0, threshold=50 bps. All 6 within 50 bps of each other &rarr; single cluster of 6.
          </p>
          <p className="pharos-numeric">
            Published price = cluster median = {CONSENSUS_EXAMPLE_MEDIAN} (midpoint of 1.0000 and 1.0001, not a four-decimal display rounding). Internal selected source for provenance = Curve (highest-weight member).
          </p>
          <p>
            Result: <span className="text-foreground">price {CONSENSUS_EXAMPLE_MEDIAN}, confidence &ldquo;high&rdquo;, source label from the full agreeing cluster</span>.
          </p>
        </WorkedExample>

        <MethodologyDetails
          primary
          summary="Technical details: source weights, consensus algorithm, overrides, enrichment, and validation"
        >
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Current source admission and exceptions</h3>
            {PRICING_PIPELINE_SECTION_CONTENT.markdownParagraphs.slice(4).map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </div>
          <MethodologyDiagramFlow
            inputCols={4}
            inputs={[
              {
                title: "Aggregators",
                subtitle: (
                  <>
                    <span className="md:hidden">CG (w2), DL-list (w1)</span>
                    <span className="hidden md:inline"><span>CoinGecko (w2)</span><br /><span>DL list (w1)</span></span>
                  </>
                ),
              },
              {
                title: "Exchanges",
                subtitle: (
                  <>
                    <span className="md:hidden">BN (w2), KR (w2), CB (w2), BS (w1)</span>
                    <span className="hidden md:inline"><span>Binance (w2), Kraken (w2)</span><br /><span>Coinbase (w2), Bitstamp (w1)</span></span>
                  </>
                ),
              },
              {
                title: "Oracles",
                subtitle: (
                  <>
                    <span className="md:hidden">RS (w1)</span>
                    <span className="hidden md:inline"><span>RedStone (w1)</span></span>
                  </>
                ),
              },
              {
                title: "On-chain",
                subtitle: (
                  <>
                    <span className="md:hidden">Curve (w3), DEX/address (w1), protocol DEX (w2-w3), GT (w1)</span>
                    <span className="hidden md:inline"><span>Curve (w3)</span><br /><span>DEX agg/address (w1), protocol DEX (w2-w3), GT (w1)</span></span>
                  </>
                ),
              },
            ]}
            steps={[
              { title: "N-Source Consensus", subtitle: "Pairwise clusters; publish cluster median, keep best member for provenance" },
              {
                title: "Pool Challenge",
                className: METHODOLOGY_TABLE_ACCENT_CLASSES.pricingMarket,
                subtitle: (
                  <>
                    <span className="md:hidden">Soft-only → replace with protocol-aware weighted medians</span>
                    <span className="hidden md:inline">Soft-only consensus challenged; replacement uses protocol-aware weighted medians</span>
                  </>
                ),
              },
              { title: "Authoritative Overrides", className: METHODOLOGY_TABLE_ACCENT_CLASSES.pricingOverride, subtitle: "Protocol redemption (cUSD, iUSD) after market probes" },
              {
                title: "Enrichment Pipeline",
                subtitle: (
                  <>
                    <span className="md:hidden">5-pass fallback with Jupiter before DexScreener</span>
                    <span className="hidden md:inline">5-pass fallback with Solana-native Jupiter recovery</span>
                  </>
                ),
              },
              { title: "Price Validation + Confidence", subtitle: "high / single-source / low / fallback" },
            ]}
          />

          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Source weights</h3>
            <ContentTable
              tableId="methodology-pricing-source-weights"
              testId="methodology-pricing-source-weights-table"
              columns={[
                { id: "source", header: "Source", cellClassName: "text-foreground" },
                { id: "weight", header: "Weight" },
                { id: "type", header: "Type" },
                { id: "notes", header: "Notes", cellClassName: "whitespace-normal" },
              ]}
              rows={[
                ["CoinGecko", "2", "Aggregator", <>Primary market data via <code className="text-xs">/simple/price</code></>],
                ["CoinGecko ticker", "2", "Exchange ticker", "Curated ticker corroboration path for tracked exchange pairs"],
                ["DefiLlama (list)", "1", "Aggregator", <>Independent stablecoins list price via <code className="text-xs">stablecoins.llama.fi</code></>],
                ["Binance", "2", "CEX", "Single batch call for all spot tickers"],
                ["Kraken", "2", "CEX", "Explicit pair mapping with alias-safe response handling"],
                ["Bitstamp", "1", "CEX", "Lower-weight corroboration via the all-tickers endpoint"],
                ["Coinbase", "2", "CEX", "Per-symbol spot prices"],
                ["RedStone", "1", "Oracle", "Per-venue breakdown; requires at least 2 venues and 60% agreement"],
                ["Curve on-chain", "3", "On-chain", <>StableSwap implied prices via explicit direct, one-hop, and opt-in chained-hop <code className="text-xs">get_dy()</code> routes</>],
                ["Curve oracle", "3", "On-chain", <>Additional primary-consensus voice for <code className="text-xs">crvusd-curve</code></>],
                ["DEX pools", "1", "On-chain", "Aggregate DEX voice, withheld only when an overlapping protocol-level DEX bridge lane is admitted; the reviewed VUSD route may enter primary publication at the existing $250K UI floor while remaining soft and non-depeg-authoritative"],
                ["Protocol DEX APIs", "2-3", "On-chain / pool-state API", "Primary-consensus protocol promotion currently supports Fluid, Balancer, Curve, Uniswap V3, Uniswap V4, Raydium, Orca, Meteora, PancakeSwap, Aerodrome Slipstream, Velodrome Slipstream, and Aero when the protocol lane survives registry, TVL, freshness, and corroboration gates."],
                ["GeckoTerminal", "1", "On-chain", <>Pool-level cross-check for weak CG / DL-list soft-source outcomes (&ge;$10K TVL)</>],
                ...PRICING_SOURCE_REGISTRY
                  .filter(({ key }) => addressProviderAvailability.some((provider) => provider.key === key && provider.enabled))
                  .map(({ label, defaultWeight }) => [
                    label,
                    String(defaultWeight),
                    "Exact-address augmentation",
                    "Key-gated and allowlisted; canonical deployments only, targeting missing prices or below-target source depth. Hourly corroboration plus quarter-hour refresh of missing/address-priced rows retains freshness, liquidity and request-budget gates. DexScreener exact-pool fallback is separate.",
                  ]),
              ].map(([source, weight, type, notes]) => ({ id: String(source), cells: { source, weight, type, notes } }))}
            />
          </div>

          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Consensus algorithm</h3>
            <p>The consensus engine clusters all available source prices for an asset and picks the most reliable result:</p>
            <ol className="list-decimal list-inside space-y-1">
              <li>Collect all source prices with non-failed circuit breakers</li>
              <li>Collapse repeated quotes from one source to their median, then count each registered provider family as one independent voice by retaining its strongest representative</li>
              <li>Find the largest fully pairwise cluster of sources that agree within <code className="text-xs">50 bps</code> (fixed pegs) or <code className="text-xs">500 bps</code> (NAV tokens)</li>
              <li>Break equal-size clusters by total weight, then stronger trust tier, then tighter spread, then peg proximity when available</li>
              <li>If the winning cluster has 2+ members, publish its median price and separately keep the best cluster member for provenance</li>
              <li>Choose that internal selected source by weight, then trust tier, then peg proximity, then source key</li>
              <li>If no cluster of 2+ forms, fixed pegs stay on fixed-peg rules and fall back to the best trusted single source</li>
              <li><span className="text-foreground font-medium">Pool challenge:</span> if all agreeing sources are challenge-eligible (CG, DL-list, DEX average, or promoted protocol DEX sources without a hard-source corroborator), check each large priced DEX pool (&ge;$100K TVL) from the published challenger snapshot built from the full retained pool set. If any protocol-level median diverges beyond the peg-type-aware threshold (500 bps for USD pegs, <code className="text-xs">min(2 &times; depeg threshold, 500)</code> for non-USD pegs), downgrade to <code className="text-xs">low</code>, and replace the price when at least two independent protocol-level medians corroborate that divergence unless severe-downside preservation applies. A high-TVL multi-protocol replacement can also use the peg depeg threshold when the published price is inside that threshold and at least two $5M+ protocol medians are depeg-sized in the same direction and mutually coherent inside the pool-challenge bps band. A one-protocol replacement remains allowed only when the protocol median has at least $5M TVL, the DEX median crosses the peg depeg threshold, and a hard primary candidate agrees within the normal consensus threshold</li>
            </ol>
            <code className="block rounded-lg border border-border/60 bg-muted/50 px-4 py-3 text-xs pharos-numeric">
              agree(a,b) = |a.price &minus; b.price| / midpoint(a,b) &times; 10000 &le; thresholdBps
            </code>
          </div>

          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Authoritative price overrides</h3>
            <p>For wrapper-style assets whose executable value is set by direct protocol redemption, or by an instantly redeemable tracked base asset, rather than by secondary-market liquidity, the pipeline switches to an authoritative redemption-based mark:</p>
            <ul className="list-disc list-inside space-y-1">
              <li><span className="text-foreground font-medium">cUSD (Cap):</span> <code className="text-xs">getBurnAmount()</code> &mdash; cUSD &rarr; USDC redemption rate</li>
              <li><span className="text-foreground font-medium">iUSD (infiniFi):</span> <code className="text-xs">receiptToAsset()</code> &mdash; iUSD &rarr; USDC redemption rate</li>
              <li><span className="text-foreground font-medium">USDai:</span> inherits tracked <code className="text-xs">PYUSD</code> pricing because base USDAI is treated as an instantly redeemable PYUSD wrapper</li>
              <li><span className="text-foreground font-medium">iUSD (Initia) / USDCx:</span> inherit tracked <code className="text-xs">AUSD</code> or <code className="text-xs">USDC</code> pricing when the parent rail is fresh and replay-safe</li>
              <li><span className="text-foreground font-medium">M / USDK / XO / USDnr:</span> inherit tracked <code className="text-xs">wM</code> pricing because Pharos treats them as base-unit or instantly redeemable M0 extension paths rather than free-floating market-priced assets; M requires wM itself to report fresh replay-safe single-source confidence</li>
              <li><span className="text-foreground font-medium">ONED / PYUSDx:</span> reviewed one-for-one issuer-conversion references use tracked USDC or PYUSD. Fresh admitted own market prices win, including discounts; own market history is retained rather than replaced with parent history. These routes do not establish direct-wrapper classifications or guaranteed liquid market pegs</li>
              <li><span className="text-foreground font-medium">Nominal par references:</span> source-reviewed USD and FX redeemables with observable supply carry par as a separate <code className="text-xs">nominalPriceReference</code> (source <code className="text-xs">protocol-par</code>). Non-USD par is converted through a fresh or static FX reference, recorded on the reference as <code className="text-xs">fxReferenceType</code> and <code className="text-xs">fxObservedAt</code>. Par is never an observed price: a market quote wins only when the depeg detector would act on it without confirmation (fresh, not cached or fallback, and backed by depeg-authoritative exchange, oracle or on-chain sources). CoinGecko and DefiLlama agreement alone, thin, stale, cached or fallback marks never displace par. Otherwise the published price is par with <code className="text-xs">priceObservedAtMode = &quot;nominal_reference&quot;</code>, no observation time and no confidence, which cannot open depeg events, and replay preserves existing history instead of synthesizing par points. SoFiUSD has no nominal override and instead uses its contract-verified CoinGecko/Kraken market consensus; unavailable observed quotes remain missing, and the ordinary depeg-authority gates are unchanged</li>
              <li><span className="text-foreground font-medium">ERC-4626 NAV wrappers:</span> reviewed vaults such as Sky sUSDS, Ethena sUSDe, Spark Savings, Gauntlet, Steakhouse, Sentora, Falcon, Resupply, Frax, Keyrock, Wintermute, Galaxy, Clearstar, Hyperithm, Yearn, Avant, Noon, Yuzu, and Aave Umbrella use canonical-chain <code className="text-xs">convertToAssets()</code> reads multiplied by a fresh trusted tracked parent price, including EURCV for euro-denominated shares; without that parent price, the wrapper remains unpriced. Legacy Spark USDC is a separate 18-decimal-share deployment from 6-decimal-share Spark V2</li>
              <li><span className="text-foreground font-medium">sGHO / Idle tranches:</span> protocol-specific <code className="text-xs">previewRedeem()</code> or <code className="text-xs">virtualPrice()</code> reads price assets whose executable value is not represented by thin secondary markets</li>
              <li><span className="text-foreground font-medium">AZND thin-pool recovery:</span> the exact Curve AZND/USDC route must pass identity, freshness, balance-floor, and quote-impact guards; a guarded no-quote remains an explicit coverage gap, while a thrown provider failure counts against the route circuit</li>
              <li><span className="text-foreground font-medium">crvUSD (Curve):</span> <code className="text-xs">PriceAggregator.price()</code> enters primary consensus as a live market voice, not a protocol override</li>
            </ul>
            <p>Sentora pathUSD&apos;s exact Tempo vault route can use a fresh replay-safe single-source pathUSD parent. The resulting NAV retains the parent&apos;s market source, single-source confidence and original observation time; it does not gain protocol-authoritative confidence. Stale, fallback, cached and non-replay-safe single-source parents remain unavailable.</p>
            <p>Pre-intake NAV supply valuation uses the same reviewed vault allowlist and the configured Worker RPC map as live enrichment, including Robinhood&apos;s existing keyed Dwellir route. It adds no endpoint or nominal-par fallback; an unavailable route or untrusted parent leaves valuation unavailable.</p>
            <p>DEX pool discovery uses DexScreener&apos;s complete single-token <code className="text-xs">token-pairs/v1</code> endpoint; the bounded multi-address pricing fallback remains on the separate <code className="text-xs">tokens/v1</code> endpoint.</p>
            <p>Apart from nominal par references, these overrides set <code className="text-xs">priceSource = &quot;protocol-redeem&quot;</code> and <code className="text-xs">priceConfidence = &quot;high&quot;</code> when the quote validates against peg bounds, and they are applied after the GeckoTerminal probe so later market checks cannot overwrite them. Recovery scheduling treats a current price as usable only when it is positive and carries publishable source and observation-time provenance, and each live candidate has a bounded slice of the shared budget so one stalled wrapper cannot skip the remaining active gaps. Parent trust is judged on the composite&apos;s replay-safe core, so an agreeing non-replay-safe corroborator that joins a parent&apos;s consensus label can neither strip trust from a high-confidence parent nor upgrade one the gate would otherwise reject. Vault NAV routes persist their last-good on-chain rate, and a failed live read can publish that cached rate times the fresh trusted parent price as an explicit low-confidence <code className="text-xs">protocol-redeem-cached-rate</code> source — bounded to 24 hours, never replacing a live price, and never depeg-authoritative. Audited wrapper exceptions can use a fresh high-confidence same-run parent consensus for live pricing while keeping historical replay on replay-safe sources.</p>
          </div>

          <div className="space-y-2">
            <h3 className="text-foreground font-medium">CoinGecko Supply Gap-Fill Limits</h3>
            <p>DefiLlama list totals remain the canonical supply for DefiLlama-backed assets. When exactly one reviewed deployment is missing from DefiLlama&apos;s chain breakdown, a fresh CoinGecko market cap may raise the aggregate only while CoinGecko/DefiLlama stays inside a bounded band: a new fill needs a ratio above 1.05 and at most 1.45, an existing fill is kept above 1.02 (hysteresis), and no fill ever exceeds 1.50 at current or at any compared 1d/7d/30d point. All admitted aggregate buckets come from one CoinGecko series, and the row exposes <code className="text-xs">supplyGapFill</code> provenance with the retained DefiLlama total. Since v6.47, each historical remainder is attributed to the missing chain only when every existing chain has an observed bucket and their sum matches the DefiLlama baseline within max($0.01, baseline &times; 1e-6). Otherwise that missing-chain bucket is null and <code className="text-xs">withheldHistoricalBuckets</code> names the unavailable window; observed chain values are never scaled and admitted aggregates are unchanged. Aggregate admission still fails closed for out-of-band, incomplete or ambiguous supplemental evidence.</p>
          </div>

          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Enrichment Pipeline (6-pass fallback)</h3>
            <p>Assets still missing prices after primary consensus go through a staged enrichment pipeline:</p>
            <ol className="list-decimal list-inside space-y-1">
              <li><span className="text-foreground font-medium">Pass 1:</span> Canonical tracked contract identity &rarr; DefiLlama coins API, but only prices that pass peg-aware validation can resolve the asset</li>
              <li><span className="text-foreground font-medium">Pass 1b:</span> Tracked alternate deployment fallback only (no synthetic same-address cross-chain probing; same validation gate as pass 1)</li>
              <li><span className="text-foreground font-medium">Pass 2:</span> CoinMarketCap category plus exact-slug quotes; truncated category pages ignore returned rows until the exact targeted lane validates active status, contracts, volume, freshness, and peg bounds</li>
              <li><span className="text-foreground font-medium">Pass 3:</span> Jupiter Price API for tracked Solana mints (authenticated when configured, block-freshness checked, peg-aware, and able to add bounded soft evidence to agreeing low-depth Solana prices)</li>
              <li><span className="text-foreground font-medium">Pass 4:</span> DexScreener exact token-address pools only; the older unique-symbol search fallback is retired, and each run makes at most one same-chain batch of 30 exact addresses with rotating chain and within-chain coverage</li>
              <li><span className="text-foreground font-medium">Pass 5:</span> Allowlisted low-volume CoinGecko recovery, including reviewed NXUSD, Hermetica USDh, Crown BRLV and USDFC observations, published only with fallback confidence and the original observation clock inside the seven-day freshness budget</li>
            </ol>
            <p>Broad fallback collection runs hourly outside the primary publication invocation. Pricing v6.52 refreshes short-lived DefiLlama contract and Jupiter quotes every 15 minutes alongside the existing exact-address and exact-DEX refresh. Missing-price or source-owned rows qualify, but reviewed gaps stay hourly unless a publishable current quote is already source-owned; a stale source label is insufficient. The contract and Jupiter passes each have a separate 25-second budget. The same admission guards and original observation clocks apply; staged recovery retains fallback confidence and does not become a trusted parent price for another asset.</p>
            <p>Pricing v6.52 also requires a chain-dropout release review to fall between that quarantine&apos;s first detection and the current run. An observed list current is still required; an omitted chain or a later incident cannot inherit an older review. Reviewed releases do not add supply or override the DefiLlama aggregate.</p>
            <p>Pricing v6.55 stops one small quarantined chain from blanking a whole asset. Once the seven-day carry has expired, a quarantined deficit of at most 5% of the vetted whole-asset total publishes the observed remainder as partial coverage. Nothing is carried or added, the excluded chain stays unavailable and quarantined, and the stablecoin page labels its market cap &ldquo;Partial supply&rdquo; with the excluded chain names. A larger deficit keeps supply unavailable. Elapsed time still never accepts the collapse.</p>
            <p>DefiLlama-list consensus inputs must retain a DefiLlama origin or an absent legacy source label. Named supplemental prices cannot be relabeled as a second DefiLlama observation; CoinGecko-fallback supply rows remain excluded from this input.</p>
          </div>

          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Confidence levels</h3>
            <ContentTable
              tableId="methodology-pricing-confidence-levels"
              testId="methodology-pricing-confidence-levels-table"
              columns={[
                { id: "level", header: "Level" },
                { id: "condition", header: "Condition", cellClassName: "whitespace-normal" },
                { id: "effect", header: "Downstream effect", cellClassName: "whitespace-normal" },
              ]}
              rows={[
                { id: "high", cellClassNames: { level: `${CONFIDENCE_LEVEL_COLORS.high} font-medium` }, cells: {
                  level: "high", condition: "Independent agreeing cluster survives list-aggregator downgrade and pool challenge",
                  effect: "Published as the agreeing cluster median; depeg detection still checks authoritative-source trust before skipping confirmation",
                } },
                { id: "single-source", cellClassNames: { level: `${CONFIDENCE_LEVEL_COLORS["single-source"]} font-medium` }, cells: {
                  level: "single-source", condition: "One usable source, or a non-independent list-aggregator cluster treated as one source",
                  effect: "Depeg detection requires pending confirmation",
                } },
                { id: "low", cellClassNames: { level: `${CONFIDENCE_LEVEL_COLORS.low} font-medium` }, cells: {
                  level: "low", condition: "Sources disagree beyond threshold, or pool challenge fired",
                  effect: "Pool challenge: TVL-weighted pool price used; otherwise closest to peg reference; depeg requires confirmation",
                } },
                { id: "fallback", cellClassNames: { level: `${CONFIDENCE_LEVEL_COLORS.fallback} font-medium` }, cells: {
                  level: "fallback", condition: "All primary sources down; enrichment or cache used",
                  effect: "Depeg mutations blocked; stale banner shown on frontend",
                } },
              ]}
            />
          </div>

          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Price validation</h3>
            <p>Every price is validated before entering the replay cache. Validation is context-aware with four modes:</p>
            <ul className="list-disc list-inside space-y-1">
              <li><span className="text-foreground font-medium">Authoritative primary:</span> can admit deep downside for fixed pegs, but publication still requires corroboration unless the mark is protocol redemption or a pool-challenge replacement</li>
              <li><span className="text-foreground font-medium">Fallback enrichment:</span> rejects isolated bad prints below a lower bound</li>
              <li><span className="text-foreground font-medium">DEX pool observation:</span> requires the existing $50K TVL floor; independent ticker prices require at least $1,000 observed USD flow with zero TVL attribution and unchanged publication/trust guards</li>
              <li><span className="text-foreground font-medium">Historical backfill:</span> validates against per-timestamp peg references</li>
            </ul>
            <p>USD and fiat-FX pegs share the same upside tolerance ratio when a usable reference exists, while commodity tokens (gold, silver) keep the broader 2x reference band and scale references by <code className="text-xs">commodityOunces</code> for gram- and 1/1000-ounce assets. NAV tokens use broad positive-price checks. Replay-safe cache storage is limited to strong, replayable prices and now expires after 6 hours.</p>
          </div>
        </MethodologyDetails>
    </MethodologySectionShell>
  );
}
