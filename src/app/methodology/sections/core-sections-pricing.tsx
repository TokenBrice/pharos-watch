import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  PRICING_PIPELINE_CHANGELOG_PATH,
  PRICING_PIPELINE_VERSION_LABEL,
} from "@shared/lib/pricing-pipeline-version";
import { MethodologyDetails, MethodologyFacts, WorkedExample } from "../methodology-shared";

export function PricingPipelineMethodologySection() {
  return (
    <Card
      id="pricing-pipeline-methodology"
      className="scroll-mt-36 rounded-xl border border-border/70 border-l-[3px] border-l-blue-500 bg-card md:scroll-mt-28"
    >
      <CardHeader className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle as="h2">Pricing Pipeline Methodology</CardTitle>
          <span className="inline-flex items-center rounded-md border border-blue-500/30 bg-blue-500/10 px-2 py-0.5 text-xs font-mono font-semibold text-blue-700 dark:text-blue-400">
            {PRICING_PIPELINE_VERSION_LABEL}
          </span>
          <Link
            href={PRICING_PIPELINE_CHANGELOG_PATH}
            className="text-xs text-foreground underline underline-offset-4 hover:text-blue-700 dark:text-blue-400 transition-colors"
          >
            Version history &rarr;
          </Link>
        </div>
        <p className="text-xs text-muted-foreground">
          Version increments when price sources, consensus algorithm, enrichment passes, or validation rules change.
        </p>
      </CardHeader>
      <CardContent className="space-y-6 text-sm text-muted-foreground leading-relaxed">
        <p>
          Every score Pharos computes starts with a price. The pricing pipeline collects quotes from more than a dozen
          live voices, requires fully pairwise agreement inside each cluster, and selects the highest-confidence result.
        </p>

        <p>
          <strong className="text-foreground">Source diversity.</strong>{" "}
          Kraken and Bitstamp extend the direct venue set. Fresh RedStone prices need timestamped multi-venue breakdowns.
          DEX bridge identity is now canonical-only at runtime, so addressed unknown tokens are dropped instead of being
          reinterpreted by symbol, promoted protocol DEX prices only enter consensus when they are corroborated or no
          non-DEX voices exist, and direct-API quote legs prefer tracked live stablecoin prices instead of unconditional{" "}
          <code className="mx-1 text-xs">$1</code> symbol assumptions.
        </p>

        <p>
          <strong className="text-foreground">Pool challenge.</strong>{" "}
          A pool challenge guard downgrades confidence and replaces the price with a TVL-weighted pool average when large
          DEX pools diverge from aggregator consensus, including DEX-inclusive soft clusters unless an exempt hard source
          is present.
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
          depeg-authoritative when its freshness is source-native rather than inferred from local collection time.
        </p>

        <p>
          <strong className="text-foreground">Enrichment &amp; confidence.</strong>{" "}
          A 5-pass enrichment pipeline fills gaps for long-tail coins. Each asset is tagged with a confidence level so
          downstream systems can react to data quality, and severe fixed-peg downside publication now requires corroboration
          unless it comes from an explicit protocol redemption or pool-challenge replacement mark. When a confirmed severe
          depeg briefly loses corroboration, the pipeline preserves trusted continuity from fresh replay-safe{" "}
          <code className="mx-1 text-xs">price_cache</code> rows instead of letting the asset flap to{" "}
          <code className="mx-1 text-xs">N/A</code>.
        </p>
        <div className="grid gap-2 sm:grid-cols-3">
          <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
            <p className="text-xs uppercase tracking-wide">Update cadence</p>
            <p className="text-foreground">15m refresh</p>
          </div>
          <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
            <p className="text-xs uppercase tracking-wide">Sources</p>
            <p className="text-foreground">14+ live voices</p>
          </div>
          <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
            <p className="text-xs uppercase tracking-wide">Output</p>
            <p className="text-foreground">Price + confidence tag per asset</p>
          </div>
        </div>
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
        <WorkedExample summary="Worked example: USDC price consensus across 6 sources">
          <p className="font-mono">
            Sources: CoinGecko=1.0001 (w2), DL-list=0.9999 (w1), Pyth=1.0002 (w2), Binance=1.0001 (w2),
            Kraken=1.0000 (w2), Coinbase=0.9998 (w2), Curve=1.0003 (w3)
          </p>
          <p className="font-mono">
            Peg ref=1.0, threshold=50 bps. All 7 within 50 bps of each other &rarr; single cluster of 7.
          </p>
          <p className="font-mono">
            Highest weight in cluster: Curve (w3) &rarr; price=1.0003
          </p>
          <p>
            Result: <span className="text-foreground">price 1.0003, confidence &ldquo;high&rdquo;, source &ldquo;binance+coingecko+coinbase+curve+defillama+kraken+pyth&rdquo;</span>.
          </p>
        </WorkedExample>

        <MethodologyDetails
          defaultOpen
          primary
          summary="Technical details: source weights, consensus algorithm, overrides, enrichment, and validation"
        >
          <div className="hidden md:flex flex-col items-center gap-3">
            <div className="grid grid-cols-4 gap-3 w-full">
              <div className="rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium">Aggregators</p>
                <p className="text-xs text-muted-foreground mt-0.5">CoinGecko (w2)</p>
                <p className="text-xs text-muted-foreground">DL list (w1)</p>
              </div>
              <div className="rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium">Exchanges</p>
                <p className="text-xs text-muted-foreground mt-0.5">Binance (w2), Kraken (w2)</p>
                <p className="text-xs text-muted-foreground">Coinbase (w2), Bitstamp (w1)</p>
              </div>
              <div className="rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium">Oracles</p>
                <p className="text-xs text-muted-foreground mt-0.5">Pyth (w2)</p>
                <p className="text-xs text-muted-foreground">RedStone (w1)</p>
              </div>
              <div className="rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium">On-chain</p>
                <p className="text-xs text-muted-foreground mt-0.5">Curve (w3)</p>
                <p className="text-xs text-muted-foreground">DEX agg (w1), protocol DEX (w2-w3), GT (w1)</p>
              </div>
            </div>
            <div className="text-muted-foreground text-xl font-bold">&darr;</div>
            <div className="rounded-lg border p-3 text-center w-80">
              <p className="text-foreground font-medium">N-Source Consensus</p>
              <p className="text-xs text-muted-foreground mt-0.5">Pairwise clusters, then size/weight/spread tie-breaks</p>
            </div>
            <div className="text-muted-foreground text-xl font-bold">&darr;</div>
            <div className="rounded-lg border border-orange-500/40 p-3 text-center w-80">
              <p className="text-foreground font-medium">Pool Challenge</p>
              <p className="text-xs text-muted-foreground mt-0.5">Soft-only consensus challenged; replacement uses protocol-aware weighted medians</p>
            </div>
            <div className="text-muted-foreground text-xl font-bold">&darr;</div>
            <div className="rounded-lg border border-blue-500/40 p-3 text-center w-80">
              <p className="text-foreground font-medium">Authoritative Overrides</p>
              <p className="text-xs text-muted-foreground mt-0.5">Protocol redemption (cUSD, iUSD) after market probes</p>
            </div>
            <div className="text-muted-foreground text-xl font-bold">&darr;</div>
            <div className="rounded-lg border p-3 text-center w-80">
              <p className="text-foreground font-medium">Enrichment Pipeline</p>
              <p className="text-xs text-muted-foreground mt-0.5">5-pass fallback with Solana-native Jupiter recovery</p>
            </div>
            <div className="text-muted-foreground text-xl font-bold">&darr;</div>
            <div className="rounded-lg border p-3 text-center w-80">
              <p className="text-foreground font-medium">Price Validation + Confidence</p>
              <p className="text-xs text-muted-foreground mt-0.5">high / single-source / low / fallback</p>
            </div>
          </div>

          <div className="flex flex-col items-center gap-3 md:hidden">
            <div className="grid grid-cols-2 gap-2 w-full">
              <div className="rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium text-xs">Aggregators</p>
                <p className="text-xs text-muted-foreground">CG (w2), DL-list (w1)</p>
              </div>
              <div className="rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium text-xs">Exchanges</p>
                <p className="text-xs text-muted-foreground">BN (w2), KR (w2), CB (w2), BS (w1)</p>
              </div>
              <div className="rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium text-xs">Oracles</p>
                <p className="text-xs text-muted-foreground">Pyth (w2), RS (w1)</p>
              </div>
              <div className="rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium text-xs">On-chain</p>
                <p className="text-xs text-muted-foreground">Curve (w3), DEX agg (w1), protocol DEX (w2-w3), GT (w1)</p>
              </div>
            </div>
            <div className="text-muted-foreground text-xl font-bold">&darr;</div>
            <div className="w-full rounded-lg border p-3 text-center">
              <p className="text-foreground font-medium">N-Source Consensus</p>
              <p className="text-xs text-muted-foreground mt-0.5">Pairwise clusters, then size/weight/spread tie-breaks</p>
            </div>
            <div className="text-muted-foreground text-xl font-bold">&darr;</div>
            <div className="w-full rounded-lg border border-orange-500/40 p-3 text-center">
              <p className="text-foreground font-medium">Pool Challenge</p>
              <p className="text-xs text-muted-foreground mt-0.5">Soft-only &rarr; replace with protocol-aware weighted medians</p>
            </div>
            <div className="text-muted-foreground text-xl font-bold">&darr;</div>
            <div className="w-full rounded-lg border border-blue-500/40 p-3 text-center">
              <p className="text-foreground font-medium">Authoritative Overrides</p>
              <p className="text-xs text-muted-foreground mt-0.5">Protocol redemption (cUSD, iUSD) after market probes</p>
            </div>
            <div className="text-muted-foreground text-xl font-bold">&darr;</div>
            <div className="w-full rounded-lg border p-3 text-center">
              <p className="text-foreground font-medium">Enrichment Pipeline</p>
              <p className="text-xs text-muted-foreground mt-0.5">5-pass fallback with Jupiter before DexScreener</p>
            </div>
            <div className="text-muted-foreground text-xl font-bold">&darr;</div>
            <div className="w-full rounded-lg border p-3 text-center">
              <p className="text-foreground font-medium">Price Validation + Confidence</p>
              <p className="text-xs text-muted-foreground mt-0.5">high / single-source / low / fallback</p>
            </div>
          </div>

          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Source Weights</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="py-2 pr-4 font-medium text-foreground">Source</th>
                    <th className="py-2 pr-4 font-medium text-foreground">Weight</th>
                    <th className="py-2 pr-4 font-medium text-foreground">Type</th>
                    <th className="py-2 font-medium text-foreground">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  <tr className="hover:bg-muted/40 transition-colors"><td className="py-2 pr-4 text-foreground">CoinGecko</td><td className="py-2 pr-4">2</td><td className="py-2 pr-4">Aggregator</td><td className="py-2">Primary market data via <code className="text-xs">/simple/price</code></td></tr>
                  <tr className="hover:bg-muted/40 transition-colors"><td className="py-2 pr-4 text-foreground">DefiLlama (list)</td><td className="py-2 pr-4">1</td><td className="py-2 pr-4">Aggregator</td><td className="py-2">Independent stablecoins list price via <code className="text-xs">stablecoins.llama.fi</code></td></tr>
                  <tr className="hover:bg-muted/40 transition-colors"><td className="py-2 pr-4 text-foreground">Pyth Network</td><td className="py-2 pr-4">2</td><td className="py-2 pr-4">Oracle</td><td className="py-2">Hermes endpoint with confidence intervals</td></tr>
                  <tr className="hover:bg-muted/40 transition-colors"><td className="py-2 pr-4 text-foreground">Binance</td><td className="py-2 pr-4">2</td><td className="py-2 pr-4">CEX</td><td className="py-2">Single batch call for all spot tickers</td></tr>
                  <tr className="hover:bg-muted/40 transition-colors"><td className="py-2 pr-4 text-foreground">Kraken</td><td className="py-2 pr-4">2</td><td className="py-2 pr-4">CEX</td><td className="py-2">Explicit pair mapping with alias-safe response handling</td></tr>
                  <tr className="hover:bg-muted/40 transition-colors"><td className="py-2 pr-4 text-foreground">Bitstamp</td><td className="py-2 pr-4">1</td><td className="py-2 pr-4">CEX</td><td className="py-2">Lower-weight corroboration via the all-tickers endpoint</td></tr>
                  <tr className="hover:bg-muted/40 transition-colors"><td className="py-2 pr-4 text-foreground">Coinbase</td><td className="py-2 pr-4">2</td><td className="py-2 pr-4">CEX</td><td className="py-2">Per-symbol spot prices</td></tr>
                  <tr className="hover:bg-muted/40 transition-colors"><td className="py-2 pr-4 text-foreground">RedStone</td><td className="py-2 pr-4">1</td><td className="py-2 pr-4">Oracle</td><td className="py-2">Per-venue breakdown with agreement %</td></tr>
                  <tr className="hover:bg-muted/40 transition-colors"><td className="py-2 pr-4 text-foreground">Curve on-chain</td><td className="py-2 pr-4">3</td><td className="py-2 pr-4">On-chain</td><td className="py-2">StableSwap implied prices via <code className="text-xs">get_dy()</code></td></tr>
                  <tr className="hover:bg-muted/40 transition-colors"><td className="py-2 pr-4 text-foreground">DEX pools</td><td className="py-2 pr-4">1</td><td className="py-2 pr-4">On-chain</td><td className="py-2">Aggregate DEX voice, but withheld when overlapping protocol-level DEX bridge data exists</td></tr>
                  <tr className="hover:bg-muted/40 transition-colors"><td className="py-2 pr-4 text-foreground">Protocol DEX APIs</td><td className="py-2 pr-4">2-3</td><td className="py-2 pr-4">On-chain / pool-state API</td><td className="py-2">One aggregated source per protocol from Fluid, Balancer, Raydium, and Orca; only promoted when corroborated or when no non-DEX voice exists</td></tr>
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
              <li>Within the winning cluster, select the best trusted source, then break ties by weight and peg proximity</li>
              <li>If no cluster of 2+ forms, fixed pegs stay on fixed-peg rules and fall back to the best trusted single source</li>
              <li><span className="text-foreground font-medium">Pool challenge:</span> if all agreeing sources are challenge-eligible (CG, DL-list, DEX average, or promoted protocol DEX sources without a hard-source corroborator), check each large priced DEX pool (&ge;$100K TVL) from the published challenger snapshot built from the full retained pool set. If any diverges &ge;500 bps from the weak result, downgrade to <code className="text-xs">low</code>, and only replace the price when at least two independent protocols corroborate that divergence &mdash; on-chain liquidity is a more honest signal when aggregators share upstream data, but a single protocol can still be wrong</li>
            </ol>
            <code className="block rounded-lg border border-l-[3px] border-l-sky-500 border-border/60 bg-muted/50 px-4 py-3 text-xs font-mono">
              agree(a,b) = |a.price &minus; b.price| / midpoint(a,b) &times; 10000 &le; thresholdBps
            </code>
          </div>

          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Authoritative Price Overrides</h3>
            <p>For wrapper-style assets whose executable value is set by direct protocol redemption rather than secondary-market liquidity, the pipeline queries on-chain contracts to get the true redemption rate:</p>
            <ul className="list-disc list-inside space-y-1">
              <li><span className="text-foreground font-medium">cUSD (Cap):</span> <code className="text-xs">getBurnAmount()</code> &mdash; cUSD &rarr; USDC redemption rate</li>
              <li><span className="text-foreground font-medium">iUSD (infiniFi):</span> <code className="text-xs">receiptToAsset()</code> &mdash; iUSD &rarr; USDC redemption rate</li>
              <li><span className="text-foreground font-medium">crvUSD (Curve):</span> <code className="text-xs">PriceAggregator.price()</code> enters primary consensus as a live market voice, not a protocol override</li>
            </ul>
            <p>These overrides set <code className="text-xs">priceSource = &quot;protocol-redeem&quot;</code> and <code className="text-xs">priceConfidence = &quot;high&quot;</code> when the quote validates against peg bounds, and they are applied after the GeckoTerminal probe so later market checks cannot overwrite them.</p>
          </div>

          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Enrichment Pipeline (5-pass fallback)</h3>
            <p>Assets still missing prices after primary consensus go through a staged enrichment pipeline:</p>
            <ol className="list-decimal list-inside space-y-1">
              <li><span className="text-foreground font-medium">Pass 1:</span> Contract address &rarr; DefiLlama coins API</li>
              <li><span className="text-foreground font-medium">Pass 1b:</span> Tracked alternate deployment fallback only (no synthetic same-address cross-chain probing)</li>
              <li><span className="text-foreground font-medium">Pass 2:</span> CoinMarketCap batch listings (slug first; symbol fallback only when the tracked symbol is unique, rate-limited to 1 call/hour)</li>
              <li><span className="text-foreground font-medium">Pass 3:</span> Jupiter Price API for tracked Solana mints (liquidity-gated)</li>
              <li><span className="text-foreground font-medium">Pass 4:</span> DexScreener exact token-address pools first, then unique-symbol search (filtered by &gt;$50K liquidity, capped at 10 requests per run)</li>
            </ol>
          </div>

          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Confidence Levels</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="py-2 pr-4 font-medium text-foreground">Level</th>
                    <th className="py-2 pr-4 font-medium text-foreground">Condition</th>
                    <th className="py-2 font-medium text-foreground">Downstream effect</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  <tr className="hover:bg-muted/40 transition-colors"><td className="py-2 pr-4 text-green-700 dark:text-green-400 font-medium">high</td><td className="py-2 pr-4">&ge;2 sources agree within threshold</td><td className="py-2">Full trust for depeg detection and scoring</td></tr>
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
      </CardContent>
    </Card>
  );
}
