import {
  PRICING_PIPELINE_CHANGELOG_PATH,
  PRICING_PIPELINE_VERSION_LABEL,
} from "@shared/lib/pricing-pipeline-version";
import {
  MethodologyDetails,
  MethodologyDiagramArrow,
  MethodologyDiagramCard,
  MethodologyFacts,
  MethodologySectionShell,
  WorkedExample,
} from "../methodology-shared";

export function PricingPipelineMethodologySection() {
  return (
    <MethodologySectionShell
      id="pricing-pipeline-methodology"
      title="Pricing Pipeline Methodology"
      versionLabel={PRICING_PIPELINE_VERSION_LABEL}
      changelogPath={PRICING_PIPELINE_CHANGELOG_PATH}
      versionNote="Version increments when price sources, consensus algorithm, enrichment passes, or validation rules change."
      accentClassName="border-l-blue-500"
      badgeClassName="border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400"
      changelogClassName="hover:text-blue-700 dark:text-blue-400"
    >
        <p>
          Every score Pharos computes starts with a price. The pricing pipeline collects quotes from more than a dozen
          live voices, requires fully pairwise agreement inside each cluster, and publishes the highest-confidence result
          with explicit source-freshness semantics.
        </p>

        <p>
          <strong className="text-foreground">Source diversity.</strong>{" "}
          Kraken and Bitstamp extend the direct venue set. Fresh RedStone prices need timestamped multi-venue breakdowns.
          The protocol-level DEX bridge now spans Fluid, Balancer, Raydium, Orca, Meteora, PancakeSwap, Aerodrome
          Slipstream, and Velodrome Slipstream. DEX bridge identity is canonical-only at runtime, so addressed unknown
          tokens are dropped instead of being reinterpreted by symbol, promoted protocol DEX prices only enter consensus
          when they are corroborated or no non-DEX voices exist, and direct-API quote legs prefer tracked live stablecoin
          prices instead of unconditional{" "}
          <code className="mx-1 text-xs">$1</code> symbol assumptions.
        </p>

        <p>
          <strong className="text-foreground">Pool challenge.</strong>{" "}
          A pool challenge guard downgrades confidence and replaces the price with a protocol-aware TVL-weighted median
          only when large DEX pools from at least two independent protocols diverge from soft consensus, with divergence
          evaluated from one TVL-weighted median per protocol so a single rogue pool cannot make an otherwise agreeing
          protocol count as corroborating disagreement, including
          DEX-inclusive soft clusters unless an exempt hard source is present. Dead blocked DEX slugs such as Bunni are
          excluded upstream and never qualify as challenger or DEX-bridge inputs.
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
          supports upstream timestamps.
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
          A 5-pass enrichment pipeline fills gaps for long-tail coins. Each asset is tagged with a confidence level so
          downstream systems can react to data quality, and severe fixed-peg downside publication now requires corroboration
          unless it comes from an explicit protocol redemption or pool-challenge replacement mark. When a confirmed severe
          depeg briefly loses corroboration, the pipeline preserves trusted continuity from fresh replay-safe{" "}
          <code className="mx-1 text-xs">price_cache</code> rows instead of letting the asset flap to{" "}
          <code className="mx-1 text-xs">N/A</code>. DefiLlama contract fallbacks must now pass the same peg-aware
          plausibility gates before they can resolve an asset, and DexScreener symbol search is reserved for addressless
          assets rather than downgrading exact-token candidates to symbol-only identity.
        </p>
        <MethodologyFacts
          facts={[
            { label: "Update cadence", value: "15m refresh" },
            { label: "Sources", value: "14+ live voices" },
            { label: "Output", value: "Price + confidence tag per asset" },
          ]}
        />
        <div className="space-y-2">
          <h3 className="text-foreground font-medium">Preconditions &amp; Failure Modes</h3>
          <MethodologyFacts
            facts={[
              { label: "Minimum data", value: "At least 1 source must return a price; consensus requires 2+ for high confidence" },
              { label: "Circuit breakers", value: "Each source has its own breaker: opens after 3 failures, probes every 30 min" },
              {
                label: "Failure behavior",
                value: "Degraded sources are excluded from consensus; enrichment pipeline fills remaining gaps; stale cache used as last resort",
              },
            ]}
          />
        </div>
        <WorkedExample summary="Worked example: USDC price consensus across 7 sources">
          <p className="font-mono">
            Sources: CoinGecko=1.0001 (w2), DL-list=0.9999 (w1), Pyth=1.0002 (w2), Binance=1.0001 (w2),
            Kraken=1.0000 (w2), Coinbase=0.9998 (w2), Curve=1.0003 (w3)
          </p>
          <p className="font-mono">
            Peg ref=1.0, threshold=50 bps. All 7 within 50 bps of each other &rarr; single cluster of 7.
          </p>
          <p className="font-mono">
            Published price = cluster median = 1.0001. Internal selected source for provenance = Curve (highest-weight member).
          </p>
          <p>
            Result: <span className="text-foreground">price 1.0001, confidence &ldquo;high&rdquo;, source label from the full agreeing cluster</span>.
          </p>
        </WorkedExample>

        <MethodologyDetails
          defaultOpen
          primary
          summary="Technical details: source weights, consensus algorithm, overrides, enrichment, and validation"
        >
          <div className="hidden md:flex flex-col items-center gap-3">
            <div className="grid grid-cols-4 gap-3 w-full">
              <MethodologyDiagramCard title="Aggregators" subtitle={<><span>CoinGecko (w2)</span><br /><span>DL list (w1)</span></>} />
              <MethodologyDiagramCard title="Exchanges" subtitle={<><span>Binance (w2), Kraken (w2)</span><br /><span>Coinbase (w2), Bitstamp (w1)</span></>} />
              <MethodologyDiagramCard title="Oracles" subtitle={<><span>Pyth (w2)</span><br /><span>RedStone (w1)</span></>} />
              <MethodologyDiagramCard title="On-chain" subtitle={<><span>Curve (w3)</span><br /><span>DEX agg (w1), protocol DEX (w2-w3), GT (w1)</span></>} />
            </div>
            <MethodologyDiagramArrow />
            <MethodologyDiagramCard className="w-80" title="N-Source Consensus" subtitle="Pairwise clusters; publish cluster median, keep best member for provenance" />
            <MethodologyDiagramArrow />
            <MethodologyDiagramCard className="w-80 border-orange-500/40" title="Pool Challenge" subtitle="Soft-only consensus challenged; replacement uses protocol-aware weighted medians" />
            <MethodologyDiagramArrow />
            <MethodologyDiagramCard className="w-80 border-blue-500/40" title="Authoritative Overrides" subtitle="Protocol redemption (cUSD, iUSD) after market probes" />
            <MethodologyDiagramArrow />
            <MethodologyDiagramCard className="w-80" title="Enrichment Pipeline" subtitle="5-pass fallback with Solana-native Jupiter recovery" />
            <MethodologyDiagramArrow />
            <MethodologyDiagramCard className="w-80" title="Price Validation + Confidence" subtitle="high / single-source / low / fallback" />
          </div>

          <div className="flex flex-col items-center gap-3 md:hidden">
            <div className="grid grid-cols-2 gap-2 w-full">
              <MethodologyDiagramCard title="Aggregators" titleClassName="text-xs text-foreground font-medium" subtitle="CG (w2), DL-list (w1)" subtitleClassName="text-xs text-muted-foreground" />
              <MethodologyDiagramCard title="Exchanges" titleClassName="text-xs text-foreground font-medium" subtitle="BN (w2), KR (w2), CB (w2), BS (w1)" subtitleClassName="text-xs text-muted-foreground" />
              <MethodologyDiagramCard title="Oracles" titleClassName="text-xs text-foreground font-medium" subtitle="Pyth (w2), RS (w1)" subtitleClassName="text-xs text-muted-foreground" />
              <MethodologyDiagramCard title="On-chain" titleClassName="text-xs text-foreground font-medium" subtitle="Curve (w3), DEX agg (w1), protocol DEX (w2-w3), GT (w1)" subtitleClassName="text-xs text-muted-foreground" />
            </div>
            <MethodologyDiagramArrow />
            <MethodologyDiagramCard className="w-full" title="N-Source Consensus" subtitle="Pairwise clusters; publish cluster median, keep best member for provenance" />
            <MethodologyDiagramArrow />
            <MethodologyDiagramCard className="w-full border-orange-500/40" title="Pool Challenge" subtitle="Soft-only → replace with protocol-aware weighted medians" />
            <MethodologyDiagramArrow />
            <MethodologyDiagramCard className="w-full border-blue-500/40" title="Authoritative Overrides" subtitle="Protocol redemption (cUSD, iUSD) after market probes" />
            <MethodologyDiagramArrow />
            <MethodologyDiagramCard className="w-full" title="Enrichment Pipeline" subtitle="5-pass fallback with Jupiter before DexScreener" />
            <MethodologyDiagramArrow />
            <MethodologyDiagramCard className="w-full" title="Price Validation + Confidence" subtitle="high / single-source / low / fallback" />
          </div>

          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Source Weights</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th scope="col" className="py-2 pr-4 font-medium text-foreground">Source</th>
                    <th scope="col" className="py-2 pr-4 font-medium text-foreground">Weight</th>
                    <th scope="col" className="py-2 pr-4 font-medium text-foreground">Type</th>
                    <th scope="col" className="py-2 font-medium text-foreground">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  <tr className="hover:bg-muted/40 transition-colors"><td className="py-2 pr-4 text-foreground">CoinGecko</td><td className="py-2 pr-4">2</td><td className="py-2 pr-4">Aggregator</td><td className="py-2">Primary market data via <code className="text-xs">/simple/price</code></td></tr>
                  <tr className="hover:bg-muted/40 transition-colors"><td className="py-2 pr-4 text-foreground">CoinGecko ticker</td><td className="py-2 pr-4">2</td><td className="py-2 pr-4">Exchange ticker</td><td className="py-2">Curated ticker corroboration path for tracked exchange pairs</td></tr>
                  <tr className="hover:bg-muted/40 transition-colors"><td className="py-2 pr-4 text-foreground">DefiLlama (list)</td><td className="py-2 pr-4">1</td><td className="py-2 pr-4">Aggregator</td><td className="py-2">Independent stablecoins list price via <code className="text-xs">stablecoins.llama.fi</code></td></tr>
                  <tr className="hover:bg-muted/40 transition-colors"><td className="py-2 pr-4 text-foreground">Pyth Network</td><td className="py-2 pr-4">2</td><td className="py-2 pr-4">Oracle</td><td className="py-2">Hermes endpoint with confidence intervals</td></tr>
                  <tr className="hover:bg-muted/40 transition-colors"><td className="py-2 pr-4 text-foreground">Binance</td><td className="py-2 pr-4">2</td><td className="py-2 pr-4">CEX</td><td className="py-2">Single batch call for all spot tickers</td></tr>
                  <tr className="hover:bg-muted/40 transition-colors"><td className="py-2 pr-4 text-foreground">Kraken</td><td className="py-2 pr-4">2</td><td className="py-2 pr-4">CEX</td><td className="py-2">Explicit pair mapping with alias-safe response handling</td></tr>
                  <tr className="hover:bg-muted/40 transition-colors"><td className="py-2 pr-4 text-foreground">Bitstamp</td><td className="py-2 pr-4">1</td><td className="py-2 pr-4">CEX</td><td className="py-2">Lower-weight corroboration via the all-tickers endpoint</td></tr>
                  <tr className="hover:bg-muted/40 transition-colors"><td className="py-2 pr-4 text-foreground">Coinbase</td><td className="py-2 pr-4">2</td><td className="py-2 pr-4">CEX</td><td className="py-2">Per-symbol spot prices</td></tr>
                  <tr className="hover:bg-muted/40 transition-colors"><td className="py-2 pr-4 text-foreground">RedStone</td><td className="py-2 pr-4">1</td><td className="py-2 pr-4">Oracle</td><td className="py-2">Per-venue breakdown; requires at least 2 venues and 60% agreement</td></tr>
                  <tr className="hover:bg-muted/40 transition-colors"><td className="py-2 pr-4 text-foreground">Curve on-chain</td><td className="py-2 pr-4">3</td><td className="py-2 pr-4">On-chain</td><td className="py-2">StableSwap implied prices via <code className="text-xs">get_dy()</code></td></tr>
                  <tr className="hover:bg-muted/40 transition-colors"><td className="py-2 pr-4 text-foreground">Curve oracle</td><td className="py-2 pr-4">3</td><td className="py-2 pr-4">On-chain</td><td className="py-2">Additional primary-consensus voice for <code className="text-xs">crvusd-curve</code></td></tr>
                  <tr className="hover:bg-muted/40 transition-colors"><td className="py-2 pr-4 text-foreground">DEX pools</td><td className="py-2 pr-4">1</td><td className="py-2 pr-4">On-chain</td><td className="py-2">Aggregate DEX voice, but withheld when overlapping protocol-level DEX bridge data exists</td></tr>
                  <tr className="hover:bg-muted/40 transition-colors"><td className="py-2 pr-4 text-foreground">Protocol DEX APIs</td><td className="py-2 pr-4">2-3</td><td className="py-2 pr-4">On-chain / pool-state API</td><td className="py-2">One aggregated source per protocol from Fluid, Balancer, Raydium, Orca, Meteora, PancakeSwap, Aerodrome Slipstream, and Velodrome Slipstream; only promoted when corroborated or when no non-DEX voice exists</td></tr>
                  <tr className="hover:bg-muted/40 transition-colors"><td className="py-2 pr-4 text-foreground">GeckoTerminal</td><td className="py-2 pr-4">1</td><td className="py-2 pr-4">On-chain</td><td className="py-2">Pool-level cross-check for weak CG / DL-list soft-source outcomes (&ge;$10K TVL)</td></tr>
                </tbody>
              </table>
            </div>
          </div>

          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Consensus Algorithm</h3>
            <p>The consensus engine clusters all available source prices for an asset and picks the most reliable result:</p>
            <ol className="list-decimal list-inside space-y-1">
              <li>Collect all source prices with non-failed circuit breakers</li>
              <li>Find the largest fully pairwise cluster of sources that agree within <code className="text-xs">50 bps</code> (fixed pegs) or <code className="text-xs">500 bps</code> (NAV tokens)</li>
              <li>Break equal-size clusters by total weight, then tighter spread, then peg proximity when available</li>
              <li>If the winning cluster has 2+ members, publish its median price and separately keep the best cluster member for provenance</li>
              <li>Choose that internal selected source by weight, then trust tier, then peg proximity, then source key</li>
              <li>If no cluster of 2+ forms, fixed pegs stay on fixed-peg rules and fall back to the best trusted single source</li>
              <li><span className="text-foreground font-medium">Pool challenge:</span> if all agreeing sources are challenge-eligible (CG, DL-list, DEX average, or promoted protocol DEX sources without a hard-source corroborator), check each large priced DEX pool (&ge;$100K TVL) from the published challenger snapshot built from the full retained pool set. If any diverges &ge;500 bps from the weak result, downgrade to <code className="text-xs">low</code>, and only replace the price when at least two independent protocol-level medians corroborate that divergence &mdash; on-chain liquidity is a more honest signal when aggregators share upstream data, but a single protocol or a single rogue pool can still be wrong</li>
            </ol>
            <code className="block rounded-lg border border-l-[3px] border-l-sky-500 border-border/60 bg-muted/50 px-4 py-3 text-xs font-mono">
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
              <li><span className="text-foreground font-medium">crvUSD (Curve):</span> <code className="text-xs">PriceAggregator.price()</code> enters primary consensus as a live market voice, not a protocol override</li>
            </ul>
            <p>These overrides set <code className="text-xs">priceSource = &quot;protocol-redeem&quot;</code> and <code className="text-xs">priceConfidence = &quot;high&quot;</code> when the quote validates against peg bounds, and they are applied after the GeckoTerminal probe so later market checks cannot overwrite them.</p>
          </div>

          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Enrichment Pipeline (5-pass fallback)</h3>
            <p>Assets still missing prices after primary consensus go through a staged enrichment pipeline:</p>
            <ol className="list-decimal list-inside space-y-1">
              <li><span className="text-foreground font-medium">Pass 1:</span> Canonical tracked contract identity &rarr; DefiLlama coins API, but only prices that pass peg-aware validation can resolve the asset</li>
              <li><span className="text-foreground font-medium">Pass 1b:</span> Tracked alternate deployment fallback only (no synthetic same-address cross-chain probing; same validation gate as pass 1)</li>
              <li><span className="text-foreground font-medium">Pass 2:</span> CoinMarketCap batch listings (slug first; symbol fallback only when the tracked symbol is unique, rate-limited to 1 call/hour)</li>
              <li><span className="text-foreground font-medium">Pass 3:</span> Jupiter Price API for tracked Solana mints (liquidity-gated)</li>
              <li><span className="text-foreground font-medium">Pass 4:</span> DexScreener exact token-address pools first; unique-symbol search is reserved for addressless assets and stays filtered by &gt;$50K liquidity, capped at 10 requests per run with exact-target and larger-circulating assets prioritized first</li>
            </ol>
          </div>

          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Confidence Levels</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th scope="col" className="py-2 pr-4 font-medium text-foreground">Level</th>
                    <th scope="col" className="py-2 pr-4 font-medium text-foreground">Condition</th>
                    <th scope="col" className="py-2 font-medium text-foreground">Downstream effect</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  <tr className="hover:bg-muted/40 transition-colors"><td className="py-2 pr-4 text-green-700 dark:text-green-400 font-medium">high</td><td className="py-2 pr-4">&ge;2 sources agree within threshold</td><td className="py-2">Published as the agreeing cluster median; full trust for depeg detection and scoring</td></tr>
                  <tr className="hover:bg-muted/40 transition-colors"><td className="py-2 pr-4 text-yellow-700 dark:text-yellow-400 font-medium">single-source</td><td className="py-2 pr-4">Only 1 source returned a price</td><td className="py-2">Depeg detection requires pending confirmation</td></tr>
                  <tr className="hover:bg-muted/40 transition-colors"><td className="py-2 pr-4 text-orange-700 dark:text-orange-400 font-medium">low</td><td className="py-2 pr-4">Sources disagree beyond threshold, or pool challenge fired</td><td className="py-2">Pool challenge: TVL-weighted pool price used; otherwise closest to peg reference; depeg requires confirmation</td></tr>
                  <tr className="hover:bg-muted/40 transition-colors"><td className="py-2 pr-4 text-red-700 dark:text-red-400 font-medium">fallback</td><td className="py-2 pr-4">All primary sources down; enrichment or cache used</td><td className="py-2">Depeg mutations blocked; stale banner shown on frontend</td></tr>
                </tbody>
              </table>
            </div>
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
            <p>Commodity tokens (gold, silver) scale references by <code className="text-xs">commodityOunces</code> for gram- and 1/1000-ounce assets. NAV tokens use broad positive-price checks. Replay-safe cache storage is limited to strong, replayable prices and now expires after 6 hours.</p>
          </div>
        </MethodologyDetails>
    </MethodologySectionShell>
  );
}
