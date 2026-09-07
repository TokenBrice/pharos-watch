import {
  PRICING_PIPELINE_METHODOLOGY_CHANGELOG_PATH,
  PRICING_PIPELINE_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/constants";
import {
  TableBody,
  TableCell,
  TableFrame,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/table";
import {
  MethodologyDetails,
  MethodologyDiagramFlow,
  MethodologyFacts,
  MethodologyPreconditions,
  MethodologySectionShell,
  WorkedExample,
} from "../methodology-shared";
import { PRICING_PIPELINE_SECTION_CONTENT } from "@/lib/methodology-content";
export function PricingPipelineMethodologySection() {
  return (
    <MethodologySectionShell
      id={PRICING_PIPELINE_SECTION_CONTENT.id}
      title={PRICING_PIPELINE_SECTION_CONTENT.title}
      versionBadge={{ label: PRICING_PIPELINE_METHODOLOGY_VERSION_LABEL }}
      changelogPath={PRICING_PIPELINE_METHODOLOGY_CHANGELOG_PATH}
      versionNote="Version increments when price sources, consensus algorithm, enrichment passes, or validation rules change."
      changelogClassName="hover:text-blue-700 dark:hover:text-blue-400"
    >
        <p>
          Every score Pharos computes starts with a price. The pricing pipeline collects quotes from more than a dozen
          live voices, requires fully pairwise agreement inside each cluster, and publishes the highest-confidence result
          with explicit source-freshness semantics.
        </p>

        <p>
          <strong className="text-foreground">Source diversity.</strong>{" "}
          Kraken and Bitstamp extend the direct venue set. Fresh RedStone prices need timestamped multi-venue breakdowns
          and are attributed only to configured canonical stablecoin IDs.
          The primary promoted DEX bridge now spans Fluid, Balancer, Curve, Uniswap V3, Uniswap V4, Raydium, Orca,
          Meteora, PancakeSwap, Aerodrome Slipstream, and Velodrome Slipstream, with structured source-filter telemetry and DEX lane confidence
          profiles attached when those lanes participate. Targeted exact-address augmentation can add DexScreener,
          DexPaprika, CoinGecko Onchain, Alchemy Prices, Moralis, and Solana Birdeye quotes for assets with missing prices or
          below-target source depth or weak confidence. DEX bridge and address-provider identity are canonical-only at runtime, so
          addressed unknown tokens are dropped instead of being reinterpreted by symbol. Reviewed provider-specific
          deployment narrowing applies only while the exact address remains in current metadata; stale configuration
          produces no target, and eligible exact reviewed CoinGecko Onchain overrides reserve one bounded network request
          before ordinary network round-robin. Promoted protocol DEX prices only enter consensus when they are corroborated or no non-DEX
          voices exist, rejected protocol lanes no longer suppress a valid aggregate DEX fallback, and direct-API quote legs prefer
          tracked live stablecoin prices instead of unconditional{" "}
          <code className="mx-1 text-xs">$1</code> symbol assumptions.
        </p>

        <p>
          <strong className="text-foreground">Pool challenge.</strong>{" "}
          A pool challenge guard downgrades confidence and replaces the price with a protocol-aware TVL-weighted median
          only when large DEX pools from at least two independent protocols diverge from soft consensus, with divergence
          evaluated from one TVL-weighted median per protocol so a single rogue pool cannot make an otherwise agreeing
          protocol count as corroborating disagreement. A high-TVL multi-protocol path can also replace a near-peg soft
          price when at least two protocol medians each carry $5M+ TVL, are depeg-sized in the same direction, and agree
          with each other inside the pool-challenge bps band. A narrow one-protocol exception remains limited to cases
          where that protocol median is depeg-sized, carries at least $5M TVL, and agrees with a hard primary candidate
          within the normal consensus threshold, including
          DEX-inclusive soft clusters unless an exempt hard source is present. NAV tokens are excluded because their
          wide clustering threshold makes pool-level divergence a poor signal for redeemable-at-NAV assets. When the guard
          replaces a price, the replacement is now also reflected in the per-source candidate list so downstream
          corroboration continuity uses the replacement mark rather than the superseded candidate. Corroborated severe
          downside from multiple candidate sources including a depeg-authoritative source can be downgraded by pool
          challenge, but its price is preserved and the same evidence satisfies the temporal-jump guard. Dead blocked DEX
          slugs such as Bunni are excluded upstream and never qualify as challenger or DEX-bridge inputs.
        </p>

        <p>
          <strong className="text-foreground">Overrides &amp; FX.</strong>{" "}
          Protocol-level redemption prices override market data for wrapper assets. Chainlink refreshes supported FX and
          commodity reference rates, and the dated secondary FX mirror can temporarily carry the wider fiat reference stack
          when Frankfurter is unavailable, with ExchangeRate-API as a tertiary daily fallback if both primary FX paths are
          down. If those live FX fetches still fail but the last published daily references remain within cadence, Pharos
          carries those dated references forward as a healthy refresh. Even cached-fallback FX runs keep probing the
          independent OXR, Chainlink, and metals paths, so a recovered intraday subset can promote the lane back to live
          without waiting for the full Frankfurter stack.
        </p>

        <p>
          <strong className="text-foreground">Freshness tracking.</strong>{" "}
          The live payload distinguishes true upstream observation timestamps from locally stamped fetch-time freshness via{" "}
          <code className="mx-1 text-xs">priceObservedAtMode</code>, so a hard single-source print only becomes
          depeg-authoritative when its freshness is source-native rather than inferred from local collection time. The
          source registry now also records each provider&apos;s freshness kind, maximum trusted age, and whether it truly
          supports upstream timestamps. CoinGecko simple-price requests use <code className="mx-1 text-xs">precision=full</code> and rows use upstream <code className="mx-1 text-xs">last_updated_at</code>
          when it is present, so threshold logic receives the unrounded quote and rejects it when that timestamp is outside the trusted freshness window. Bitstamp,
          Coinbase, and Curve on-chain reads now publish upstream-observed freshness provenance rather than stamping rows
          at local fetch time, and the <code className="mx-1 text-xs">crvUSD</code> Curve oracle feed enforces a 5-minute
          on-chain staleness guard using the aggregator block timestamp and records against its own dedicated circuit
          breaker. Replay cache now enforces each source&apos;s native max trusted age alongside the composite 6-hour cap.
        </p>

        <p>
          <strong className="text-foreground">Recovery scope.</strong> Live protocol-override work is limited to the exact
          active registry, so frozen and quarantined assets cannot consume the shared recovery budget. Optional
          already-priced refresh failures do not poison a route-specific recovery circuit while a usable incumbent
          price exists, and unresolved assets remain fail-closed until an admitted pricing lane resolves them.
        </p>

        <p>
          <strong className="text-foreground">Native-peg corroboration.</strong>{" "}
          For supported non-USD fiat assets with a reliable native-market quote, the pipeline now derives a fresh{" "}
          <code className="mx-1 text-xs">native quote × FX reference</code> USD mark during post-enrichment. That lane can
          correct materially divergent weak or mixed-source live USD publications, fill a missing live price for supported
          assets, and still veto or resolve downstream depeg mutations when the direct native pair disagrees with a derived{" "}
          <code className="mx-1 text-xs">USD price / FX reference</code> move. It remains a fresh validation lane rather
          than a replay-safe primary consensus voice, so it does not become cached continuity on later runs.
        </p>

        <p>
          <strong className="text-foreground">Historical replay parity.</strong>{" "}
          Supported non-USD fiat backfills now prefer direct CoinGecko native-fiat history and compare that series to the
          native <code className="mx-1 text-xs">1.0</code> peg before falling back to USD-denominated market history. That
          removes long synthetic depeg streaks created only by replay-time <code className="mx-1 text-xs">USD / FX</code> mismatch.
        </p>

        <p>
          <strong className="text-foreground">Enrichment &amp; confidence.</strong>{" "}
          A 6-pass enrichment pipeline fills gaps for long-tail coins. Each asset is tagged with a confidence level so
          downstream systems can react to data quality, and severe fixed-peg downside publication now requires corroboration
          unless it comes from an explicit protocol redemption or pool-challenge replacement mark. Two-source clusters
          composed only of list-style aggregators (CoinGecko, DefiLlama, DefiLlama-list) are now downgraded to
          single-source regardless of which two combine, closing the CoinGecko + DefiLlama-detail tautology alongside the
          existing CG + DL-list downgrade. Cluster tiebreak also prefers hard-tier clusters over equal-weight soft-tier
          clusters before falling through to spread and peg-proximity rules. A lone promoted DEX protocol is admitted
          only when no non-DEX source exists, or when a hard market/oracle/protocol source agrees within threshold.
          Corroborating candidate prices now stay
          attached through later validation when the selected primary result is unchanged, so a real severe depeg is not
          cleared as a single-source mark. When a confirmed severe depeg briefly loses corroboration, the pipeline
          preserves trusted continuity from fresh replay-safe{" "}
          <code className="mx-1 text-xs">price_cache</code> rows instead of letting the asset flap to{" "}
          <code className="mx-1 text-xs">N/A</code>. DefiLlama contract fallbacks must now pass the same peg-aware
          plausibility gates before they can resolve an asset, and weak fallback/search-family address-provider quotes
          must stay within 500 bps of a fixed peg unless a stronger source corroborates the move, so a noisy address
          print falls through to exact-contract enrichment instead of publishing a false depeg. DexScreener symbol search
          is retired so addressless assets are not probed through noisy symbol-only identity. DefiLlama{" "}
          <code className="mx-1 text-xs">/coins</code> contract-price fallback and DexScreener dex-liquidity and
          dex-discovery paths now record against their own dedicated circuit breakers instead of reusing unrelated
          breaker state, and the same provider diagnostics and GeckoTerminal probe statistics collected during each run
          are now surfaced on <code className="mx-1 text-xs">/api/status</code> for operator visibility.
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
            Sources: CoinGecko=1.0001 (w2), DL-list=0.9999 (w1), Binance=1.0001 (w2),
            Kraken=1.0000 (w2), Coinbase=0.9998 (w2), Curve=1.0003 (w3)
          </p>
          <p className="pharos-numeric">
            Peg ref=1.0, threshold=50 bps. All 6 within 50 bps of each other &rarr; single cluster of 6.
          </p>
          <p className="pharos-numeric">
            Published price = cluster median = 1.0001. Internal selected source for provenance = Curve (highest-weight member).
          </p>
          <p>
            Result: <span className="text-foreground">price 1.0001, confidence &ldquo;high&rdquo;, source label from the full agreeing cluster</span>.
          </p>
        </WorkedExample>

        <MethodologyDetails
          primary
          summary="Technical details: source weights, consensus algorithm, overrides, enrichment, and validation"
        >
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
                className: "border-orange-500/40",
                subtitle: (
                  <>
                    <span className="md:hidden">Soft-only → replace with protocol-aware weighted medians</span>
                    <span className="hidden md:inline">Soft-only consensus challenged; replacement uses protocol-aware weighted medians</span>
                  </>
                ),
              },
              { title: "Authoritative Overrides", className: "border-blue-500/40", subtitle: "Protocol redemption (cUSD, iUSD) after market probes" },
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
            <h3 className="text-foreground font-medium">Source Weights</h3>
            <TableFrame
              chrome="content"
              density="compact"
              tableId="methodology-pricing-source-weights"
              testId="methodology-pricing-source-weights-table"
              viewportProps={{ mobileScrollHint: false }}
            >
              <TableHeader>
                <TableRow className="text-left">
                  <TableHead scope="col" className="py-2 pr-4 text-foreground">Source</TableHead>
                  <TableHead scope="col" className="py-2 pr-4 text-foreground">Weight</TableHead>
                  <TableHead scope="col" className="py-2 pr-4 text-foreground">Type</TableHead>
                  <TableHead scope="col" className="py-2 text-foreground">Notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow><TableCell className="py-2 pr-4 text-foreground">CoinGecko</TableCell><TableCell className="py-2 pr-4">2</TableCell><TableCell className="py-2 pr-4">Aggregator</TableCell><TableCell className="py-2 whitespace-normal">Primary market data via <code className="text-xs">/simple/price</code></TableCell></TableRow>
                <TableRow><TableCell className="py-2 pr-4 text-foreground">CoinGecko ticker</TableCell><TableCell className="py-2 pr-4">2</TableCell><TableCell className="py-2 pr-4">Exchange ticker</TableCell><TableCell className="py-2 whitespace-normal">Curated ticker corroboration path for tracked exchange pairs</TableCell></TableRow>
                <TableRow><TableCell className="py-2 pr-4 text-foreground">DefiLlama (list)</TableCell><TableCell className="py-2 pr-4">1</TableCell><TableCell className="py-2 pr-4">Aggregator</TableCell><TableCell className="py-2 whitespace-normal">Independent stablecoins list price via <code className="text-xs">stablecoins.llama.fi</code></TableCell></TableRow>
                <TableRow><TableCell className="py-2 pr-4 text-foreground">Binance</TableCell><TableCell className="py-2 pr-4">2</TableCell><TableCell className="py-2 pr-4">CEX</TableCell><TableCell className="py-2 whitespace-normal">Single batch call for all spot tickers</TableCell></TableRow>
                <TableRow><TableCell className="py-2 pr-4 text-foreground">Kraken</TableCell><TableCell className="py-2 pr-4">2</TableCell><TableCell className="py-2 pr-4">CEX</TableCell><TableCell className="py-2 whitespace-normal">Explicit pair mapping with alias-safe response handling</TableCell></TableRow>
                <TableRow><TableCell className="py-2 pr-4 text-foreground">Bitstamp</TableCell><TableCell className="py-2 pr-4">1</TableCell><TableCell className="py-2 pr-4">CEX</TableCell><TableCell className="py-2 whitespace-normal">Lower-weight corroboration via the all-tickers endpoint</TableCell></TableRow>
                <TableRow><TableCell className="py-2 pr-4 text-foreground">Coinbase</TableCell><TableCell className="py-2 pr-4">2</TableCell><TableCell className="py-2 pr-4">CEX</TableCell><TableCell className="py-2 whitespace-normal">Per-symbol spot prices</TableCell></TableRow>
                <TableRow><TableCell className="py-2 pr-4 text-foreground">RedStone</TableCell><TableCell className="py-2 pr-4">1</TableCell><TableCell className="py-2 pr-4">Oracle</TableCell><TableCell className="py-2 whitespace-normal">Per-venue breakdown; requires at least 2 venues and 60% agreement</TableCell></TableRow>
                <TableRow><TableCell className="py-2 pr-4 text-foreground">Curve on-chain</TableCell><TableCell className="py-2 pr-4">3</TableCell><TableCell className="py-2 pr-4">On-chain</TableCell><TableCell className="py-2 whitespace-normal">StableSwap implied prices via explicit direct, one-hop, and opt-in chained-hop <code className="text-xs">get_dy()</code> routes</TableCell></TableRow>
                <TableRow><TableCell className="py-2 pr-4 text-foreground">Curve oracle</TableCell><TableCell className="py-2 pr-4">3</TableCell><TableCell className="py-2 pr-4">On-chain</TableCell><TableCell className="py-2 whitespace-normal">Additional primary-consensus voice for <code className="text-xs">crvusd-curve</code></TableCell></TableRow>
                <TableRow><TableCell className="py-2 pr-4 text-foreground">DEX pools</TableCell><TableCell className="py-2 pr-4">1</TableCell><TableCell className="py-2 pr-4">On-chain</TableCell><TableCell className="py-2 whitespace-normal">Aggregate DEX voice, withheld only when an overlapping protocol-level DEX bridge lane is admitted; the reviewed VUSD route may enter primary publication at the existing $250K UI floor while remaining soft and non-depeg-authoritative</TableCell></TableRow>
                <TableRow><TableCell className="py-2 pr-4 text-foreground">Protocol DEX APIs</TableCell><TableCell className="py-2 pr-4">2-3</TableCell><TableCell className="py-2 pr-4">On-chain / pool-state API</TableCell><TableCell className="py-2 whitespace-normal">Primary-consensus protocol promotion currently supports Fluid, Balancer, Curve, Uniswap V3, Uniswap V4, Raydium, Orca, Meteora, PancakeSwap, Aerodrome Slipstream, and Velodrome Slipstream when the protocol lane survives registry, TVL, freshness, and corroboration gates.</TableCell></TableRow>
                <TableRow><TableCell className="py-2 pr-4 text-foreground">GeckoTerminal</TableCell><TableCell className="py-2 pr-4">1</TableCell><TableCell className="py-2 pr-4">On-chain</TableCell><TableCell className="py-2 whitespace-normal">Pool-level cross-check for weak CG / DL-list soft-source outcomes (&ge;$10K TVL)</TableCell></TableRow>
                <TableRow><TableCell className="py-2 pr-4 text-foreground">Exact-address providers</TableCell><TableCell className="py-2 pr-4">1</TableCell><TableCell className="py-2 pr-4">Market / on-chain</TableCell><TableCell className="py-2 whitespace-normal">Optional targeted DexScreener, DexPaprika, CoinGecko Onchain, Alchemy Prices, Moralis, and Solana Birdeye quotes; currently disabled in production Worker config for quarter-hour sync headroom</TableCell></TableRow>
              </TableBody>
            </TableFrame>
          </div>

          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Consensus Algorithm</h3>
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
            <h3 className="text-foreground font-medium">Authoritative Price Overrides</h3>
            <p>For wrapper-style assets whose executable value is set by direct protocol redemption, or by an instantly redeemable tracked base asset, rather than by secondary-market liquidity, the pipeline switches to an authoritative redemption-based mark:</p>
            <ul className="list-disc list-inside space-y-1">
              <li><span className="text-foreground font-medium">cUSD (Cap):</span> <code className="text-xs">getBurnAmount()</code> &mdash; cUSD &rarr; USDC redemption rate</li>
              <li><span className="text-foreground font-medium">iUSD (infiniFi):</span> <code className="text-xs">receiptToAsset()</code> &mdash; iUSD &rarr; USDC redemption rate</li>
              <li><span className="text-foreground font-medium">USDai:</span> inherits tracked <code className="text-xs">PYUSD</code> pricing because base USDAI is treated as an instantly redeemable PYUSD wrapper</li>
              <li><span className="text-foreground font-medium">iUSD (Initia) / USDCx:</span> inherit tracked <code className="text-xs">AUSD</code> or <code className="text-xs">USDC</code> pricing when the parent rail is fresh and replay-safe</li>
              <li><span className="text-foreground font-medium">M / USDK / XO / USDnr:</span> inherit tracked <code className="text-xs">wM</code> pricing because Pharos treats them as base-unit or instantly redeemable M0 extension paths rather than free-floating market-priced assets; M requires wM itself to report fresh replay-safe single-source confidence</li>
              <li><span className="text-foreground font-medium">Scoped par references:</span> source-reviewed USD and FX redeemables can use fresh/static FX references when active supply is observable</li>
              <li><span className="text-foreground font-medium">ERC-4626 NAV wrappers:</span> audited vaults such as Sky sUSDS, Ethena sUSDe, Spark Savings, Gauntlet, Steakhouse, Yearn, Avant, Noon, Yuzu, and Aave Umbrella use canonical-chain <code className="text-xs">convertToAssets()</code> reads multiplied by a fresh trusted tracked parent price; without that parent price, the wrapper remains unpriced</li>
              <li><span className="text-foreground font-medium">sGHO / Idle tranches:</span> protocol-specific <code className="text-xs">previewRedeem()</code> or <code className="text-xs">virtualPrice()</code> reads price assets whose executable value is not represented by thin secondary markets</li>
              <li><span className="text-foreground font-medium">AZND thin-pool recovery:</span> the exact Curve AZND/USDC route must pass identity, freshness, balance-floor, and quote-impact guards; a guarded no-quote remains an explicit coverage gap, while a thrown provider failure counts against the route circuit</li>
              <li><span className="text-foreground font-medium">crvUSD (Curve):</span> <code className="text-xs">PriceAggregator.price()</code> enters primary consensus as a live market voice, not a protocol override</li>
            </ul>
            <p>DEX pool discovery uses DexScreener&apos;s complete single-token <code className="text-xs">token-pairs/v1</code> endpoint; the bounded multi-address pricing fallback remains on the separate <code className="text-xs">tokens/v1</code> endpoint.</p>
            <p>These overrides set <code className="text-xs">priceSource = &quot;protocol-redeem&quot;</code> and <code className="text-xs">priceConfidence = &quot;high&quot;</code> when the quote validates against peg bounds, and they are applied after the GeckoTerminal probe so later market checks cannot overwrite them. Recovery scheduling treats a current price as usable only when it is positive and carries publishable source and observation-time provenance, and each live candidate has a bounded slice of the shared budget so one stalled wrapper cannot skip the remaining active gaps. Parent trust is judged on the composite&apos;s replay-safe core, so an agreeing non-replay-safe corroborator that joins a parent&apos;s consensus label can neither strip trust from a high-confidence parent nor upgrade one the gate would otherwise reject. Vault NAV routes persist their last-good on-chain rate, and a failed live read can publish that cached rate times the fresh trusted parent price as an explicit low-confidence <code className="text-xs">protocol-redeem-cached-rate</code> source — bounded to 24 hours, never replacing a live price, and never depeg-authoritative. Audited wrapper exceptions can use a fresh high-confidence same-run parent consensus for live pricing while keeping historical replay on replay-safe sources.</p>
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
              <li><span className="text-foreground font-medium">Pass 5:</span> Allowlisted low-volume CoinGecko recovery for selected DefiLlama-listed assets, published only with fallback confidence</li>
            </ol>
          </div>

          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Confidence Levels</h3>
            <TableFrame
              chrome="content"
              density="compact"
              tableId="methodology-pricing-confidence-levels"
              testId="methodology-pricing-confidence-levels-table"
              viewportProps={{ mobileScrollHint: false }}
            >
              <TableHeader>
                <TableRow className="text-left">
                  <TableHead scope="col" className="py-2 pr-4 text-foreground">Level</TableHead>
                  <TableHead scope="col" className="py-2 pr-4 text-foreground">Condition</TableHead>
                  <TableHead scope="col" className="py-2 text-foreground">Downstream effect</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow><TableCell className="py-2 pr-4 text-green-700 dark:text-green-400 font-medium">high</TableCell><TableCell className="py-2 pr-4 whitespace-normal">Independent agreeing cluster survives list-aggregator downgrade and pool challenge</TableCell><TableCell className="py-2 whitespace-normal">Published as the agreeing cluster median; depeg detection still checks authoritative-source trust before skipping confirmation</TableCell></TableRow>
                <TableRow><TableCell className="py-2 pr-4 text-yellow-700 dark:text-yellow-400 font-medium">single-source</TableCell><TableCell className="py-2 pr-4 whitespace-normal">One usable source, or a non-independent list-aggregator cluster treated as one source</TableCell><TableCell className="py-2 whitespace-normal">Depeg detection requires pending confirmation</TableCell></TableRow>
                <TableRow><TableCell className="py-2 pr-4 text-orange-700 dark:text-orange-400 font-medium">low</TableCell><TableCell className="py-2 pr-4 whitespace-normal">Sources disagree beyond threshold, or pool challenge fired</TableCell><TableCell className="py-2 whitespace-normal">Pool challenge: TVL-weighted pool price used; otherwise closest to peg reference; depeg requires confirmation</TableCell></TableRow>
                <TableRow><TableCell className="py-2 pr-4 text-red-700 dark:text-red-400 font-medium">fallback</TableCell><TableCell className="py-2 pr-4 whitespace-normal">All primary sources down; enrichment or cache used</TableCell><TableCell className="py-2 whitespace-normal">Depeg mutations blocked; stale banner shown on frontend</TableCell></TableRow>
              </TableBody>
            </TableFrame>
          </div>

          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Price Validation</h3>
            <p>Every price is validated before entering the replay cache. Validation is context-aware with four modes:</p>
            <ul className="list-disc list-inside space-y-1">
              <li><span className="text-foreground font-medium">Authoritative primary:</span> can admit deep downside for fixed pegs, but publication still requires corroboration unless the mark is protocol redemption or a pool-challenge replacement</li>
              <li><span className="text-foreground font-medium">Fallback enrichment:</span> rejects isolated bad prints below a lower bound</li>
              <li><span className="text-foreground font-medium">DEX observation:</span> requires consistent $50K post-confidence TVL floor</li>
              <li><span className="text-foreground font-medium">Historical backfill:</span> validates against per-timestamp peg references</li>
            </ul>
            <p>USD and fiat-FX pegs share the same upside tolerance ratio when a usable reference exists, while commodity tokens (gold, silver) keep the broader 2x reference band and scale references by <code className="text-xs">commodityOunces</code> for gram- and 1/1000-ounce assets. NAV tokens use broad positive-price checks. Replay-safe cache storage is limited to strong, replayable prices and now expires after 6 hours.</p>
          </div>
        </MethodologyDetails>
    </MethodologySectionShell>
  );
}
