import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH,
  BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/blacklist-tracker-version";
import {
  DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
  DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/depeg-dews-version";
import { LIQUIDITY_METHODOLOGY_VERSION_LABEL } from "@shared/lib/liquidity-score-version";
import {
  MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH,
  MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/mint-burn-flow-version";
import { SAFETY_SCORE_VERSION_LABEL } from "@shared/lib/safety-score-version";
import { PSI_METHODOLOGY_VERSION_LABEL } from "@shared/lib/stability-index-version";
import {
  PRICING_PIPELINE_CHANGELOG_PATH,
  PRICING_PIPELINE_VERSION_LABEL,
} from "@shared/lib/pricing-pipeline-version";
import {
  YIELD_METHODOLOGY_CHANGELOG_PATH,
  YIELD_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/yield-methodology-version";
import {
  CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH,
  CHAIN_HEALTH_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/chain-health-version";
import { MethodologyDetails, MethodologyFacts, WorkedExample } from "./methodology-shared";

export function MethodologySections() {
  return (
    <>
      {/* Pricing Pipeline */}
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
            live voices, clusters them into agreement groups, and selects the highest-confidence result. A pool challenge
            guard downgrades confidence and replaces the price with a TVL-weighted pool average when large DEX pools
            diverge from aggregator consensus. Protocol-level redemption prices override market data for wrapper assets,
            and a 4-pass enrichment pipeline fills gaps for long-tail coins. Each asset is tagged with a confidence level
            so downstream systems can react to data quality.
          </p>
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <p className="text-xs uppercase tracking-wide">Update cadence</p>
              <p className="text-foreground">15m refresh</p>
            </div>
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <p className="text-xs uppercase tracking-wide">Sources</p>
              <p className="text-foreground">12+ live voices</p>
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
              Coinbase=0.9998 (w2), Curve=1.0003 (w3)
            </p>
            <p className="font-mono">
              Peg ref=1.0, threshold=50 bps. All 6 within 50 bps of each other &rarr; single cluster of 6.
            </p>
            <p className="font-mono">
              Highest weight in cluster: Curve (w3) &rarr; price=1.0003
            </p>
            <p>
              Result: <span className="text-foreground">price 1.0003, confidence &ldquo;high&rdquo;, source &ldquo;curve+5more&rdquo;</span>.
            </p>
          </WorkedExample>

          <MethodologyDetails
            defaultOpen
            primary
            summary="Technical details: source weights, consensus algorithm, overrides, enrichment, and validation"
          >
            {/* Pricing pipeline diagram — desktop */}
            <div className="hidden md:flex flex-col items-center gap-3">
              <div className="grid grid-cols-4 gap-3 w-full">
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium">Aggregators</p>
                  <p className="text-xs text-muted-foreground mt-0.5">CoinGecko (w2)</p>
                  <p className="text-xs text-muted-foreground">DL list (w1)</p>
                </div>
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium">Exchanges</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Binance (w2)</p>
                  <p className="text-xs text-muted-foreground">Coinbase (w2)</p>
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
                <p className="text-xs text-muted-foreground mt-0.5">Cluster within 50 bps, pick highest-weight</p>
              </div>
              <div className="text-muted-foreground text-xl font-bold">&darr;</div>
              <div className="rounded-lg border border-orange-500/40 p-3 text-center w-80">
                <p className="text-foreground font-medium">Pool Challenge</p>
                <p className="text-xs text-muted-foreground mt-0.5">Soft-only consensus challenged; price replaced by TVL-weighted pools</p>
              </div>
              <div className="text-muted-foreground text-xl font-bold">&darr;</div>
              <div className="rounded-lg border border-blue-500/40 p-3 text-center w-80">
                <p className="text-foreground font-medium">Authoritative Overrides</p>
                <p className="text-xs text-muted-foreground mt-0.5">Protocol redemption (cUSD, iUSD, crvUSD)</p>
              </div>
              <div className="text-muted-foreground text-xl font-bold">&darr;</div>
              <div className="rounded-lg border p-3 text-center w-80">
                <p className="text-foreground font-medium">Enrichment Pipeline</p>
                <p className="text-xs text-muted-foreground mt-0.5">4-pass fallback for remaining gaps</p>
              </div>
              <div className="text-muted-foreground text-xl font-bold">&darr;</div>
              <div className="rounded-lg border p-3 text-center w-80">
                <p className="text-foreground font-medium">Price Validation + Confidence</p>
                <p className="text-xs text-muted-foreground mt-0.5">high / single-source / low / fallback</p>
              </div>
            </div>

            {/* Pricing pipeline diagram — mobile */}
            <div className="flex flex-col items-center gap-3 md:hidden">
              <div className="grid grid-cols-2 gap-2 w-full">
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium text-xs">Aggregators</p>
                  <p className="text-xs text-muted-foreground">CG (w2), DL-list (w1)</p>
                </div>
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium text-xs">Exchanges</p>
                  <p className="text-xs text-muted-foreground">BN (w2), CB (w2)</p>
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
                <p className="text-xs text-muted-foreground mt-0.5">Cluster within 50 bps, pick highest-weight</p>
              </div>
              <div className="text-muted-foreground text-xl font-bold">&darr;</div>
              <div className="w-full rounded-lg border border-orange-500/40 p-3 text-center">
                <p className="text-foreground font-medium">Pool Challenge</p>
                <p className="text-xs text-muted-foreground mt-0.5">Soft-only &rarr; replace with TVL-weighted pools</p>
              </div>
              <div className="text-muted-foreground text-xl font-bold">&darr;</div>
              <div className="w-full rounded-lg border border-blue-500/40 p-3 text-center">
                <p className="text-foreground font-medium">Authoritative Overrides</p>
                <p className="text-xs text-muted-foreground mt-0.5">Protocol redemption (cUSD, iUSD, crvUSD)</p>
              </div>
              <div className="text-muted-foreground text-xl font-bold">&darr;</div>
              <div className="w-full rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium">Enrichment Pipeline</p>
                <p className="text-xs text-muted-foreground mt-0.5">4-pass fallback for remaining gaps</p>
              </div>
              <div className="text-muted-foreground text-xl font-bold">&darr;</div>
              <div className="w-full rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium">Price Validation + Confidence</p>
                <p className="text-xs text-muted-foreground mt-0.5">high / single-source / low / fallback</p>
              </div>
            </div>

            {/* Source weights table */}
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
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-2 pr-4 text-foreground">CoinGecko</td>
                      <td className="py-2 pr-4">2</td>
                      <td className="py-2 pr-4">Aggregator</td>
                      <td className="py-2">Primary market data via <code className="text-xs">/simple/price</code></td>
                    </tr>
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-2 pr-4 text-foreground">DefiLlama (list)</td>
                      <td className="py-2 pr-4">1</td>
                      <td className="py-2 pr-4">Aggregator</td>
                      <td className="py-2">Independent stablecoins list price via <code className="text-xs">stablecoins.llama.fi</code></td>
                    </tr>
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-2 pr-4 text-foreground">Pyth Network</td>
                      <td className="py-2 pr-4">2</td>
                      <td className="py-2 pr-4">Oracle</td>
                      <td className="py-2">Hermes endpoint with confidence intervals</td>
                    </tr>
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-2 pr-4 text-foreground">Binance</td>
                      <td className="py-2 pr-4">2</td>
                      <td className="py-2 pr-4">CEX</td>
                      <td className="py-2">Single batch call for all spot tickers</td>
                    </tr>
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-2 pr-4 text-foreground">Coinbase</td>
                      <td className="py-2 pr-4">2</td>
                      <td className="py-2 pr-4">CEX</td>
                      <td className="py-2">Per-symbol spot prices</td>
                    </tr>
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-2 pr-4 text-foreground">RedStone</td>
                      <td className="py-2 pr-4">1</td>
                      <td className="py-2 pr-4">Oracle</td>
                      <td className="py-2">Per-venue breakdown with agreement %</td>
                    </tr>
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-2 pr-4 text-foreground">Curve on-chain</td>
                      <td className="py-2 pr-4">3</td>
                      <td className="py-2 pr-4">On-chain</td>
                      <td className="py-2">StableSwap implied prices via <code className="text-xs">get_dy()</code></td>
                    </tr>
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-2 pr-4 text-foreground">DEX pools</td>
                      <td className="py-2 pr-4">1</td>
                      <td className="py-2 pr-4">On-chain</td>
                      <td className="py-2">Promoted from depeg-only to primary voice</td>
                    </tr>
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-2 pr-4 text-foreground">Protocol DEX APIs</td>
                      <td className="py-2 pr-4">2-3</td>
                      <td className="py-2 pr-4">On-chain / pool-state API</td>
                      <td className="py-2">One aggregated source per protocol from Fluid, Balancer, Raydium, and Orca</td>
                    </tr>
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-2 pr-4 text-foreground">GeckoTerminal</td>
                      <td className="py-2 pr-4">1</td>
                      <td className="py-2 pr-4">On-chain</td>
                      <td className="py-2">Pool-level cross-check for single-source CG-only assets (&ge;$10K TVL)</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            {/* Consensus algorithm */}
            <div className="space-y-2">
              <h3 className="text-foreground font-medium">Consensus Algorithm</h3>
              <p>
                The consensus engine clusters all available source prices for an asset and picks the most reliable result:
              </p>
              <ol className="list-decimal list-inside space-y-1">
                <li>Collect all source prices with non-failed circuit breakers</li>
                <li>
                  Find the largest cluster of sources that agree pairwise within <code className="text-xs">50 bps</code>{" "}
                  (fixed pegs) or <code className="text-xs">500 bps</code> (NAV tokens)
                </li>
                <li>Within the winning cluster, select the source with the highest weight</li>
                <li>If no cluster of 2+ forms, pick the source closest to the canonical peg reference</li>
                <li>
                  <span className="text-foreground font-medium">Pool challenge:</span> if all agreeing sources are soft aggregators
                  (CG, DL-list, DEX average), check each large priced DEX pool (&ge;$100K TVL) from the current liquidity
                  snapshot. If any diverges &ge;500 bps from consensus, downgrade to <code className="text-xs">low</code> and
                  replace the price with a TVL-weighted mean of all qualifying individual pool prices &mdash; on-chain liquidity is a more honest signal
                  when aggregators share upstream data
                </li>
              </ol>
              <code className="block rounded-lg border border-l-[3px] border-l-sky-500 border-border/60 bg-muted/50 px-4 py-3 text-xs font-mono">
                agree(a,b) = |a.price &minus; b.price| / midpoint(a,b) &times; 10000 &le; thresholdBps
              </code>
            </div>

            {/* Authoritative overrides */}
            <div className="space-y-2">
              <h3 className="text-foreground font-medium">Authoritative Price Overrides</h3>
              <p>
                For wrapper-style assets whose executable value is set by direct protocol redemption rather than
                secondary-market liquidity, the pipeline queries on-chain contracts to get the true redemption rate:
              </p>
              <ul className="list-disc list-inside space-y-1">
                <li><span className="text-foreground font-medium">cUSD (Cap):</span> <code className="text-xs">getBurnAmount()</code> &mdash; cUSD &rarr; USDC redemption rate</li>
                <li><span className="text-foreground font-medium">iUSD (infiniFi):</span> <code className="text-xs">receiptToAsset()</code> &mdash; iUSD &rarr; USDC redemption rate</li>
                <li><span className="text-foreground font-medium">crvUSD (Curve):</span> <code className="text-xs">PriceAggregator.price()</code> &mdash; crvUSD oracle price</li>
              </ul>
              <p>
                These overrides set <code className="text-xs">priceSource = &quot;protocol-redeem&quot;</code> and{" "}
                <code className="text-xs">priceConfidence = &quot;high&quot;</code> when the quote validates against peg bounds.
              </p>
            </div>

            {/* Enrichment pipeline */}
            <div className="space-y-2">
              <h3 className="text-foreground font-medium">Enrichment Pipeline (4-pass fallback)</h3>
              <p>
                Assets still missing prices after primary consensus go through a staged enrichment pipeline:
              </p>
              <ol className="list-decimal list-inside space-y-1">
                <li><span className="text-foreground font-medium">Pass 1:</span> Contract address &rarr; DefiLlama coins API</li>
                <li><span className="text-foreground font-medium">Pass 1b:</span> Multi-chain contract fallback (alternate chain addresses via DefiLlama)</li>
                <li><span className="text-foreground font-medium">Pass 2:</span> CoinMarketCap batch listings (symbol match, rate-limited to 1 call/hour)</li>
                <li><span className="text-foreground font-medium">Pass 3:</span> DexScreener search (filtered by &gt;$50K liquidity, capped at 10 searches per run)</li>
              </ol>
            </div>

            {/* Confidence levels */}
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
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-2 pr-4 text-green-700 dark:text-green-400 font-medium">high</td>
                      <td className="py-2 pr-4">&ge;2 sources agree within threshold</td>
                      <td className="py-2">Full trust for depeg detection and scoring</td>
                    </tr>
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-2 pr-4 text-yellow-700 dark:text-yellow-400 font-medium">single-source</td>
                      <td className="py-2 pr-4">Only 1 source returned a price</td>
                      <td className="py-2">Depeg detection requires pending confirmation</td>
                    </tr>
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-2 pr-4 text-orange-700 dark:text-orange-400 font-medium">low</td>
                      <td className="py-2 pr-4">Sources disagree beyond threshold, or pool challenge fired</td>
                      <td className="py-2">Pool challenge: TVL-weighted pool price used; otherwise closest to peg reference; depeg requires confirmation</td>
                    </tr>
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-2 pr-4 text-red-700 dark:text-red-400 font-medium">fallback</td>
                      <td className="py-2 pr-4">All primary sources down; enrichment or cache used</td>
                      <td className="py-2">Depeg mutations blocked; stale banner shown on frontend</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            {/* Validation */}
            <div className="space-y-2">
              <h3 className="text-foreground font-medium">Price Validation</h3>
              <p>
                Every price is validated before entering the 24-hour cache. Validation is context-aware with four modes:
              </p>
              <ul className="list-disc list-inside space-y-1">
                <li><span className="text-foreground font-medium">Authoritative primary:</span> allows deep downside for fixed pegs (genuine crash detection)</li>
                <li><span className="text-foreground font-medium">Fallback enrichment:</span> rejects isolated bad prints below a lower bound</li>
                <li><span className="text-foreground font-medium">DEX observation:</span> requires consistent $50K post-confidence TVL floor</li>
                <li><span className="text-foreground font-medium">Historical backfill:</span> validates against per-timestamp peg references</li>
              </ul>
              <p>
                Commodity tokens (gold, silver) scale references by <code className="text-xs">commodityOunces</code> for
                gram- and 1/1000-ounce assets. NAV tokens use broad positive-price checks.
              </p>
            </div>
          </MethodologyDetails>
        </CardContent>
      </Card>

      <Card
        id="stability-index-methodology"
        className="scroll-mt-36 rounded-xl border border-border/70 border-l-[3px] border-l-cyan-500 bg-card md:scroll-mt-28"
      >
        <CardHeader className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle as="h2">Stability Index Methodology</CardTitle>
            <span className="inline-flex items-center rounded-md border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 text-xs font-mono font-semibold text-cyan-700 dark:text-cyan-400">
              {PSI_METHODOLOGY_VERSION_LABEL}
            </span>
            <Link
              href="/methodology/stability-index-changelog"
              className="text-xs text-foreground underline underline-offset-4 hover:text-cyan-700 dark:text-cyan-400 transition-colors"
            >
              Version history &rarr;
            </Link>
          </div>
          <p className="text-xs text-muted-foreground">
            Version increments when PSI formula, caps, bands, or component definitions change.
          </p>
        </CardHeader>
        <CardContent className="space-y-6 text-sm text-muted-foreground leading-relaxed">
          <p>
            The Pharos Stability Index (PSI) is a market-level 0&ndash;100 health score for the stablecoin ecosystem. It
            is recomputed every 15 minutes from live depeg conditions and stress signals, then aggregated into daily
            history snapshots.
          </p>
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <p className="text-xs uppercase tracking-wide">Update cadence</p>
              <p className="text-foreground">15m refresh</p>
            </div>
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <p className="text-xs uppercase tracking-wide">Score range</p>
              <p className="text-foreground">0-100 market health</p>
            </div>
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <p className="text-xs uppercase tracking-wide">Main use</p>
              <p className="text-foreground">Bands: BEDROCK to MELTDOWN</p>
            </div>
          </div>
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Preconditions &amp; Failure Modes</h3>
            <MethodologyFacts
              facts={[
                { label: "Minimum data", value: "Scorer accepts empty depeg sets, but requires total market cap > 0" },
                { label: "Required sources", value: "Market-cap totals + active depeg inputs (DEWS breadth optional)" },
                {
                  label: "Failure behavior",
                  value:
                    "Returns null when market-cap input is missing/<=0; cron skips that sample and API serves last valid value",
                },
              ]}
            />
          </div>
          <WorkedExample summary="Worked example (verified against computeStabilityIndex)">
            <p className="font-mono">
              Inputs: bps=-120, depegMcap=$2B, totalMcap=$200B, age=10d, trend=+1.2, stressBreadth=1.5
            </p>
            <p className="font-mono">severity=1.141, breadth=4.243, score=100-1.141-4.243-1.5+1.2=94.316&rarr;94.3</p>
            <p>
              Result: <span className="text-foreground">PSI 94.3 (BEDROCK)</span>.
            </p>
          </WorkedExample>

          <MethodologyDetails
            defaultOpen
            primary
            summary="Technical details: formula, component math, depeg handling, and condition bands"
          >
            <div className="space-y-2">
              <h3 className="text-foreground font-medium">Scoring Formula</h3>
              <code className="block rounded-lg border border-l-[3px] border-l-sky-500 border-border/60 bg-muted/50 px-4 py-3 text-xs font-mono">
                Score = 100 &minus; severity &minus; breadth &minus; stressBreadth + trend
              </code>
              <p className="text-xs">The final value is clamped to [0, 100] and rounded to one decimal.</p>
            </div>

            {/* PSI pipeline — desktop */}
            <div className="hidden md:flex flex-col items-center gap-3">
              <div className="grid grid-cols-4 gap-3 w-full">
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium">Severity</p>
                  <p className="text-xs text-muted-foreground mt-0.5">0&ndash;68</p>
                </div>
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium">Breadth</p>
                  <p className="text-xs text-muted-foreground mt-0.5">0&ndash;17</p>
                </div>
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium">Stress Breadth</p>
                  <p className="text-xs text-muted-foreground mt-0.5">0&ndash;5</p>
                </div>
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium">Trend</p>
                  <p className="text-xs text-muted-foreground mt-0.5">&minus;5 to +5</p>
                </div>
              </div>
              <div className="text-muted-foreground text-xl font-bold">&darr;</div>
              <div className="rounded-lg border p-3 text-center w-80">
                <p className="text-foreground font-medium">Compute PSI</p>
                <p className="text-xs text-muted-foreground mt-0.5">100 &minus; penalties + trend</p>
              </div>
              <div className="text-muted-foreground text-xl font-bold">&darr;</div>
              <div className="rounded-lg border border-cyan-500/40 p-3 text-center w-80">
                <p className="text-foreground font-medium">Condition Band</p>
                <p className="text-xs text-muted-foreground mt-0.5">BEDROCK through MELTDOWN</p>
              </div>
            </div>

            {/* PSI pipeline — mobile */}
            <div className="flex flex-col items-center gap-3 md:hidden">
              <div className="grid grid-cols-2 gap-2 w-full">
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium text-xs">Severity</p>
                  <p className="text-xs text-muted-foreground">0&ndash;68</p>
                </div>
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium text-xs">Breadth</p>
                  <p className="text-xs text-muted-foreground">0&ndash;17</p>
                </div>
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium text-xs">Stress Breadth</p>
                  <p className="text-xs text-muted-foreground">0&ndash;5</p>
                </div>
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium text-xs">Trend</p>
                  <p className="text-xs text-muted-foreground">&minus;5 to +5</p>
                </div>
              </div>
              <div className="text-muted-foreground text-xl font-bold">&darr;</div>
              <div className="w-full rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium">Compute PSI</p>
                <p className="text-xs text-muted-foreground mt-0.5">100 &minus; penalties + trend</p>
              </div>
              <div className="text-muted-foreground text-xl font-bold">&darr;</div>
              <div className="w-full rounded-lg border border-cyan-500/40 p-3 text-center">
                <p className="text-foreground font-medium">Condition Band</p>
                <p className="text-xs text-muted-foreground mt-0.5">BEDROCK through MELTDOWN</p>
              </div>
            </div>

            <div className="space-y-2">
              <h3 className="text-foreground font-medium">Components</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <th className="py-2 pr-4 font-medium text-foreground">Component</th>
                      <th className="py-2 pr-4 font-medium text-foreground">Range</th>
                      <th className="py-2 pr-4 font-medium text-foreground">Formula</th>
                      <th className="py-2 font-medium text-foreground">Purpose</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-2 pr-4 text-foreground">Severity</td>
                      <td className="py-2 pr-4">0&ndash;68</td>
                      <td className="py-2 pr-4 font-mono text-xs">
                        min(68, &Sigma;(abs(bps)/100 &times; share &times; log2(1+mcap/1B) &times; 60 &times; factor))
                      </td>
                      <td className="py-2">
                        Magnitude-weighted depeg damage with extra emphasis on mega-cap instability
                      </td>
                    </tr>
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-2 pr-4 text-foreground">Breadth</td>
                      <td className="py-2 pr-4">0&ndash;17</td>
                      <td className="py-2 pr-4 font-mono text-xs">
                        min(17, &Sigma;(sqrt(mcap/1B) &times; 3 &times; factor))
                      </td>
                      <td className="py-2">How widely depegs are spreading across unique coins</td>
                    </tr>
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-2 pr-4 text-foreground">Stress Breadth</td>
                      <td className="py-2 pr-4">0&ndash;5</td>
                      <td className="py-2 pr-4 font-mono text-xs">min(5, dewsStressBreadth)</td>
                      <td className="py-2">Early-warning pressure from DEWS stress signals before full depegs</td>
                    </tr>
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-2 pr-4 text-foreground">Trend</td>
                      <td className="py-2 pr-4">&minus;5 to +5</td>
                      <td className="py-2 pr-4 font-mono text-xs">clamp(-5, 5, mcap7dChangePct)</td>
                      <td className="py-2">7-day stablecoin market-cap momentum (supports or offsets penalties)</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div className="space-y-2">
              <h3 className="text-foreground font-medium">Depeg Handling Rules</h3>
              <ul className="list-disc list-inside space-y-1">
                <li>
                  <span className="text-foreground font-medium">Per-coin deduplication:</span> active events are grouped
                  by coin; each coin contributes once using the worst current deviation.
                </li>
                <li>
                  <span className="text-foreground font-medium">Age-aware depreciation:</span> fresh depegs get full
                  weight for 30 days, then decay linearly to a 25% floor over 120 days.
                </li>
              </ul>
              <code className="block rounded-lg border border-l-[3px] border-l-sky-500 border-border/60 bg-muted/50 px-4 py-3 text-xs font-mono">
                factor = ageDays &le; 30 ? 1.0 : max(0.25, 1.0 &minus; (ageDays &minus; 30)/120)
              </code>
            </div>

            <div className="space-y-2">
              <h3 className="text-foreground font-medium">Condition Bands</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <th className="py-2 pr-4 font-medium text-foreground">Range</th>
                      <th className="py-2 pr-4 font-medium text-foreground">Band</th>
                      <th className="py-2 font-medium text-foreground">Meaning</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-2 pr-4">90&ndash;100</td>
                      <td className="py-2 pr-4 text-green-700 dark:text-green-400 font-medium">BEDROCK</td>
                      <td className="py-2">Near-ideal market stability</td>
                    </tr>
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-2 pr-4">75&ndash;89</td>
                      <td className="py-2 pr-4 text-teal-700 dark:text-teal-400 font-medium">STEADY</td>
                      <td className="py-2">Normal conditions with minor stress</td>
                    </tr>
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-2 pr-4">60&ndash;74</td>
                      <td className="py-2 pr-4 text-yellow-700 dark:text-yellow-400 font-medium">TREMOR</td>
                      <td className="py-2">Meaningful instability emerging</td>
                    </tr>
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-2 pr-4">40&ndash;59</td>
                      <td className="py-2 pr-4 text-orange-700 dark:text-orange-400 font-medium">FRACTURE</td>
                      <td className="py-2">Broad, significant market stress</td>
                    </tr>
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-2 pr-4">20&ndash;39</td>
                      <td className="py-2 pr-4 text-red-700 dark:text-red-400 font-medium">CRISIS</td>
                      <td className="py-2">Contagion-level instability</td>
                    </tr>
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-2 pr-4">0&ndash;19</td>
                      <td className="py-2 pr-4 text-red-800 font-medium">MELTDOWN</td>
                      <td className="py-2">Systemic peg failure conditions</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </MethodologyDetails>
        </CardContent>
      </Card>

      {/* Grading Methodology */}
      <Card
        id="safety-scores-methodology"
        className="scroll-mt-36 rounded-xl border border-border/70 border-l-[3px] border-l-amber-500 bg-card md:scroll-mt-28"
      >
        <CardHeader className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle as="h2">Safety Scores Grading Methodology</CardTitle>
            <span className="inline-flex items-center rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs font-mono font-semibold text-amber-700 dark:text-amber-400">
              {SAFETY_SCORE_VERSION_LABEL}
            </span>
            <Link
              href="/methodology/scoring-changelog"
              className="text-xs text-foreground underline underline-offset-4 hover:text-amber-700 dark:text-amber-400 transition-colors"
            >
              Version history &rarr;
            </Link>
          </div>
          <p className="text-xs text-muted-foreground">
            Version increments when weights, thresholds, or dimension definitions change.
          </p>
        </CardHeader>
        <CardContent className="space-y-6 text-sm text-muted-foreground leading-relaxed">
          <p>
            Pharos synthesizes multiple data signals into a single transparent grade per stablecoin. The overall score
            is computed in two steps: first, a weighted average of four base dimensions (exit liquidity, resilience,
            decentralization, dependency risk), then a peg stability multiplier that penalizes coins with poor pegs
            while barely affecting well-pegged ones. The exit-liquidity dimension blends raw DEX liquidity with
            redemption-backstop quality when a direct exit path exists. When some base dimensions lack data (NR), their
            weight is redistributed proportionally among rated ones.
          </p>
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <p className="text-xs uppercase tracking-wide">Model shape</p>
              <p className="text-foreground">4 dimensions + peg multiplier</p>
            </div>
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <p className="text-xs uppercase tracking-wide">Grade output</p>
              <p className="text-foreground">A+ to F, with NR</p>
            </div>
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <p className="text-xs uppercase tracking-wide">Key caveat</p>
              <p className="text-foreground">No exit signal = 10% penalty</p>
            </div>
          </div>
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Preconditions &amp; Failure Modes</h3>
            <MethodologyFacts
              facts={[
                { label: "Minimum data", value: "At least 2 rated non-peg dimensions" },
                { label: "Required sources", value: "Peg summary, DEX liquidity/redemption data, and dependency/metadata inputs" },
                {
                  label: "Failure behavior",
                  value: "NR if peg is missing on non-NAV coins; 0.9 penalty applies when exit liquidity is NR (no DEX data and no redemption backstop signal available)",
                },
              ]}
            />
          </div>
          <WorkedExample summary="Worked example (verified against computeOverallGrade)">
            <p className="font-mono">Inputs: DEX 30, Redemption 88, Exit 56, Res 70, Decen 60, Dep 75, Peg 92</p>
            <p className="font-mono">base=(56*0.30+70*0.20+60*0.15+75*0.25)/0.90=65.06</p>
            <p className="font-mono">final=round(base*(92/100)^0.20)=round(65.06*0.9835)=64</p>
            <p>
              Result: <span className="text-foreground">Score 64 (grade C+)</span>.
            </p>
          </WorkedExample>

          <MethodologyDetails summary="Technical details: full pipeline, dimension formulas, thresholds, and caveats">
            {/* Scoring pipeline diagram — desktop: horizontal dimension row then vertical flow */}
            <div className="hidden md:flex flex-col items-center gap-3">
              <div className="grid grid-cols-4 gap-3 w-full">
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium">Exit Liquidity</p>
                  <p className="text-xs text-muted-foreground mt-0.5">30%</p>
                </div>
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium">Resilience</p>
                  <p className="text-xs text-muted-foreground mt-0.5">20%</p>
                </div>
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium">Decentralization</p>
                  <p className="text-xs text-muted-foreground mt-0.5">15%</p>
                </div>
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium">Dependency Risk</p>
                  <p className="text-xs text-muted-foreground mt-0.5">25%</p>
                </div>
              </div>
              <div className="text-muted-foreground text-xl font-bold">&darr;</div>
              <div className="rounded-lg border p-3 text-center w-64">
                <p className="text-foreground font-medium">Weighted Average</p>
                <p className="text-xs text-muted-foreground mt-0.5">base score</p>
              </div>
              <div className="text-muted-foreground text-xl font-bold">&darr;</div>
              <div className="rounded-lg border p-3 text-center w-64">
                <p className="text-foreground font-medium">&times; Peg Multiplier</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  (pegScore / 100)<sup>0.20</sup>
                </p>
              </div>
              <div className="text-muted-foreground text-xl font-bold">&darr;</div>
              <div className="rounded-lg border border-amber-500/40 p-3 text-center w-64">
                <p className="text-foreground font-medium">&times; No-Liquidity Penalty</p>
                <p className="text-xs text-muted-foreground mt-0.5">0.9&times; if no DEX or redemption signal</p>
              </div>
              <div className="text-muted-foreground text-xl font-bold">&darr;</div>
              <div className="rounded-lg border p-3 text-center w-64">
                <p className="text-foreground font-medium">Final Grade</p>
                <p className="text-xs text-muted-foreground mt-0.5">A+ through F</p>
              </div>
            </div>

            {/* Scoring pipeline diagram — mobile: vertical stack */}
            <div className="flex flex-col items-center gap-3 md:hidden">
              <div className="grid grid-cols-2 gap-2 w-full">
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium text-xs">Exit Liquidity</p>
                  <p className="text-xs text-muted-foreground">30%</p>
                </div>
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium text-xs">Resilience</p>
                  <p className="text-xs text-muted-foreground">20%</p>
                </div>
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium text-xs">Decentralization</p>
                  <p className="text-xs text-muted-foreground">15%</p>
                </div>
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium text-xs">Dep. Risk</p>
                  <p className="text-xs text-muted-foreground">25%</p>
                </div>
              </div>
              <div className="text-muted-foreground text-xl font-bold">&darr;</div>
              <div className="w-full rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium">Weighted Average</p>
                <p className="text-xs text-muted-foreground mt-0.5">base score</p>
              </div>
              <div className="text-muted-foreground text-xl font-bold">&darr;</div>
              <div className="w-full rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium">&times; Peg Multiplier</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  (pegScore / 100)<sup>0.20</sup>
                </p>
              </div>
              <div className="text-muted-foreground text-xl font-bold">&darr;</div>
              <div className="w-full rounded-lg border border-amber-500/40 p-3 text-center">
                <p className="text-foreground font-medium">&times; No-Liquidity Penalty</p>
                <p className="text-xs text-muted-foreground mt-0.5">0.9&times; if no DEX or redemption signal</p>
              </div>
              <div className="text-muted-foreground text-xl font-bold">&darr;</div>
              <div className="w-full rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium">Final Grade</p>
                <p className="text-xs text-muted-foreground mt-0.5">A+ through F</p>
              </div>
            </div>

            {/* Dimensions table */}
            <div className="space-y-2">
              <h3 className="text-foreground font-medium">Base Dimensions (weighted average)</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <th className="py-2 pr-4 font-medium text-foreground">Dimension</th>
                      <th className="py-2 pr-4 font-medium text-foreground">Weight</th>
                      <th className="py-2 pr-4 font-medium text-foreground">Source</th>
                      <th className="py-2 font-medium text-foreground">Description</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-2 pr-4 text-foreground">Exit Liquidity</td>
                      <td className="py-2 pr-4">30%</td>
                      <td className="py-2 pr-4">DEX liquidity + redemption backstop</td>
                      <td className="py-2">Uses effective exit: DEX liquidity stays the floor, redemption can improve the dimension when a direct exit path exists</td>
                    </tr>
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-2 pr-4 text-foreground">Resilience</td>
                      <td className="py-2 pr-4">20%</td>
                      <td className="py-2 pr-4">Collateral, custody, blacklist</td>
                      <td className="py-2">Structural resilience across 3 equally-weighted sub-factors</td>
                    </tr>
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-2 pr-4 text-foreground">Decentralization</td>
                      <td className="py-2 pr-4">15%</td>
                      <td className="py-2 pr-4">Governance type, chain risk</td>
                      <td className="py-2">Governance structure with chain-risk penalty</td>
                    </tr>
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-2 pr-4 text-foreground">Dependency Risk</td>
                      <td className="py-2 pr-4">25%</td>
                      <td className="py-2 pr-4">Upstream grades, collateral weights</td>
                      <td className="py-2">Inherited risk from upstream stablecoins, weighted by exposure</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div className="space-y-2">
              <h3 className="text-foreground font-medium">Redemption Backstop and Effective Exit</h3>
              <p>
                The standalone Liquidity Score remains a pure DEX market-depth metric. Safety Scores now use an
                <span className="text-foreground font-medium"> effective exit score</span> for the Liquidity dimension:
                DEX liquidity is preserved as the floor, while redeemable assets can gain uplift from protocol or
                issuer redemption quality.
              </p>
              <p className="font-mono">
                effectiveExit = max(liquidity, liquidity * 0.55 + redemption * 0.45), with redemption-only capped at 70
              </p>
              <p>
                Redemption backstops are scored across access, settlement, execution certainty, immediate capacity,
                output-asset quality, and cost. Queue-based and offchain issuer routes are capped so they do not look
                unrealistically liquid.
              </p>
            </div>

            {/* Peg multiplier */}
            <div className="space-y-2">
              <h3 className="text-foreground font-medium">Peg Stability Multiplier</h3>
              <p>
                After computing the base score, peg stability is applied as a power-curve multiplier:
                final&nbsp;=&nbsp;base&nbsp;&times;&nbsp;(pegScore&nbsp;/&nbsp;100)<sup>0.20</sup>. Coins with strong
                pegs (90+) are barely affected (~2% penalty), while coins with broken pegs are properly penalized (e.g.
                pegScore&nbsp;10 &rarr; 37% penalty). NAV tokens (pegScore&nbsp;=&nbsp;NR) receive multiplier&nbsp;1.0
                since peg tracking does not apply to them.
              </p>
            </div>

            {/* No-liquidity penalty */}
            <div className="space-y-2">
              <h3 className="text-foreground font-medium">No-Liquidity-Data Penalty</h3>
              <p>
                A further 0.9&times; multiplier is applied when a coin has no exit-liquidity signal at all —
                neither DEX liquidity nor redemption-backstop coverage. Weights are redistributed across available 
                dimensions; this 0.9&times; multiplier is then applied to the final score to correct for the missing 
                liquidity data by applying a flat 10% penalty.
              </p>
            </div>

            {/* Resilience sub-factors */}
            <div className="space-y-2">
              <h3 className="text-foreground font-medium">Resilience Scoring</h3>
              <p>
                Average of three equally-weighted sub-factors (~33% each). Chain infrastructure is scored exclusively in
                the Decentralization dimension.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <th className="py-2 pr-4 font-medium text-foreground">Sub-factor</th>
                      <th className="py-2 pr-4 font-medium text-foreground">What it measures</th>
                      <th className="py-2 font-medium text-foreground">Scoring</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-2 pr-4 text-foreground">Collateral Quality</td>
                      <td className="py-2 pr-4">Reserve composition risk</td>
                      <td className="py-2">
                        Weighted avg of curated reserve slices: Very&nbsp;Low&nbsp;(100), Low&nbsp;(75),
                        Medium&nbsp;(50), High&nbsp;(25), Very&nbsp;High&nbsp;(5). Falls back to enum scoring for coins
                        without curated reserves.
                      </td>
                    </tr>
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-2 pr-4 text-foreground">Custody Model</td>
                      <td className="py-2 pr-4">Who holds the collateral?</td>
                      <td className="py-2">
                        Fully&nbsp;on&#8209;chain&nbsp;(100), Institutional&nbsp;custodian&nbsp;(50),
                        CEX/off&#8209;exchange&nbsp;(0)
                      </td>
                    </tr>
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-2 pr-4 text-foreground">Blacklist Capability</td>
                      <td className="py-2 pr-4">Can the issuer freeze holder funds?</td>
                      <td className="py-2">
                        No&nbsp;(100), Possible&nbsp;(mutable&nbsp;contract)&nbsp;(66),
                        Possible&nbsp;(inherited&nbsp;&mdash;&nbsp;&ge;25%&nbsp;of&nbsp;reserves&nbsp;backed&nbsp;by&nbsp;blacklistable&nbsp;coins&nbsp;such&nbsp;as&nbsp;USDC/USDT)&nbsp;(66),
                        Yes&nbsp;(33)
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p>
                Collateral quality is derived from curated reserve compositions when available &mdash; each reserve
                slice is classified into one of five risk tiers and the score is their weighted average. Direct ETH
                and canonical WETH slices share the same Very Low tier, while ETH liquid staking tokens remain Low.
                For coins without curated reserves, a coarser enum-based fallback is used. Explicit overrides exist
                for coins where defaults are incorrect (e.g., protocols on Solana, coins with CEX custody).
              </p>
            </div>

            {/* Decentralization scoring */}
            <div className="space-y-2">
              <h3 className="text-foreground font-medium">Decentralization Scoring</h3>
              <p>
                Base score from governance quality tier, then a chain-risk penalty for protocols on less decentralized
                chains &mdash; governance decentralization is undermined when the underlying chain has centralisation
                concerns:
              </p>
              <ul className="list-disc list-inside space-y-1">
                <li>
                  <span className="text-foreground">Immutable code</span> &mdash; 100 (no admin keys, no upgrade path
                  &mdash; e.g.&nbsp;LUSD, BOLD). Exempt from chain-risk penalty
                </li>
                <li>
                  <span className="text-foreground">DAO governance</span> &mdash; 85 (e.g.&nbsp;DAI)
                </li>
                <li>
                  <span className="text-foreground">Multisig</span> &mdash; 55 (e.g.&nbsp;GHO, FRAX)
                </li>
                <li>
                  <span className="text-foreground">Regulated entity</span> &mdash; 40 (named regulator, license, and
                  independent audit &mdash; e.g.&nbsp;USDC, USDT)
                </li>
                <li>
                  <span className="text-foreground">Single entity</span> &mdash; 20 (unregulated or unverified issuer)
                </li>
                <li>
                  <span className="text-foreground">Wrapper</span> &mdash; 10 (inherits upstream governance)
                </li>
              </ul>
              <p className="font-medium text-foreground mt-2">
                Chain-risk penalty (DAO, multisig, and wrapper governance &mdash; exempt for immutable-code,
                regulated-entity, single-entity):
              </p>
              <ul className="list-disc list-inside space-y-1">
                <li>Ethereum &mdash; no penalty</li>
                <li>Stage 1+ L2 &mdash; &minus;15</li>
                <li>Established alt-L1 &mdash; &minus;50</li>
                <li>Unproven chain &mdash; &minus;65</li>
              </ul>
              <p className="text-xs">
                Example: hyUSD (DAO governance, Solana) = 85 &minus; 50 = <span className="text-foreground">35</span>.
                USDB (multisig, Blast L2) = 55 &minus; 15 = <span className="text-foreground">40</span>.
              </p>
            </div>

            {/* Dependency Risk scoring */}
            <div className="space-y-2">
              <h3 className="text-foreground font-medium">Dependency Risk Scoring</h3>
              <p>
                Two-phase computation ensures upstream scores are available before dependent coins are graded. Phase 1
                grades independent coins (centralized &amp; decentralized), then Phase 2 grades CeFi-Dependent coins
                using Phase 1 results.
              </p>
              <ul className="list-disc list-inside space-y-1">
                <li>
                  <span className="text-foreground">Non-dependent coins</span> &mdash; score 95 (no upstream risk)
                </li>
                <li>
                  <span className="text-foreground">With mapped dependencies</span> &mdash; blended score: each
                  upstream&apos;s grade is weighted by its collateral fraction, and the self-backed portion
                  (non-stablecoin collateral) scores vary by governance type (decentralized&nbsp;90,
                  centralized-dependent&nbsp;75, centralized&nbsp;95). A &minus;10 penalty applies if any upstream
                  dependency scores below 75
                </li>
                <li>
                  <span className="text-foreground">Unmapped dependencies</span> &mdash; falls back to 70 when
                  dependencies aren&apos;t mapped or scores are unavailable
                </li>
              </ul>
              <p className="mt-2">
                <span className="text-foreground font-medium">Dependency type ceilings</span> &mdash; each dependency is
                classified as <em>wrapper</em>, <em>mechanism-critical</em>, or <em>collateral</em> (default). Wrappers
                (e.g., syrupUSDC &rarr; USDC) are thin layers around the upstream &mdash; their score is capped at{" "}
                <code className="text-xs">upstream &minus; 3</code>. Mechanism-critical dependencies (e.g., DAI &rarr;
                USDC via PSM) are essential to the peg &mdash; score is capped at the upstream&apos;s score. Collateral
                dependencies use the blended formula with no ceiling.
              </p>
              <p className="text-xs">
                Self-backed scores vary by governance type: centralized-dependent coins score 75 (systemic coupling
                risk), decentralized coins 90, and centralized coins 95. Centralized-dependent coins score lower because
                their peg mechanisms depend on upstream stablecoin infrastructure even for non-stablecoin collateral.
              </p>
            </div>

            {/* Grade thresholds */}
            <div className="space-y-2">
              <h3 className="text-foreground font-medium">Grade Thresholds</h3>
              <div className="overflow-x-auto">
                <table className="text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <th className="py-2 pr-8 font-medium text-foreground">Grade</th>
                      <th className="py-2 font-medium text-foreground">Score Range</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-1.5 pr-8 text-foreground">A+</td>
                      <td className="py-1.5">87&ndash;100</td>
                    </tr>
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-1.5 pr-8 text-foreground">A</td>
                      <td className="py-1.5">83&ndash;86</td>
                    </tr>
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-1.5 pr-8 text-foreground">A&minus;</td>
                      <td className="py-1.5">80&ndash;82</td>
                    </tr>
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-1.5 pr-8 text-foreground">B+</td>
                      <td className="py-1.5">75&ndash;79</td>
                    </tr>
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-1.5 pr-8 text-foreground">B</td>
                      <td className="py-1.5">70&ndash;74</td>
                    </tr>
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-1.5 pr-8 text-foreground">B&minus;</td>
                      <td className="py-1.5">65&ndash;69</td>
                    </tr>
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-1.5 pr-8 text-foreground">C+</td>
                      <td className="py-1.5">60&ndash;64</td>
                    </tr>
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-1.5 pr-8 text-foreground">C</td>
                      <td className="py-1.5">55&ndash;59</td>
                    </tr>
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-1.5 pr-8 text-foreground">C&minus;</td>
                      <td className="py-1.5">50&ndash;54</td>
                    </tr>
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-1.5 pr-8 text-foreground">D</td>
                      <td className="py-1.5">40&ndash;49</td>
                    </tr>
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-1.5 pr-8 text-foreground">F</td>
                      <td className="py-1.5">0&ndash;39</td>
                    </tr>
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-1.5 pr-8 text-foreground">NR</td>
                      <td className="py-1.5">Not enough data</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            {/* Key design decisions */}
            <div className="space-y-2">
              <h3 className="text-foreground font-medium">Key Design Decisions</h3>
              <ul className="list-disc list-inside space-y-1">
                <li>
                  <span className="text-foreground font-medium">NR (Not Rated)</span> is used when fewer than 2 base
                  dimensions have data &mdash; no misleading partial grades
                </li>
                <li>Weight is redistributed proportionally among rated base dimensions when some are NR</li>
                <li>
                  Peg stability acts as a multiplier, not a base dimension &mdash; maintaining a peg is table stakes,
                  not a differentiator
                </li>
                <li>Cemetery (defunct) coins receive a permanent F</li>
                <li>Decentralization score is structural, not a value judgment</li>
                <li>
                  Blacklist inheritance: stablecoins where &ge;25% of reserves (by weight) are backed by first-order
                  blacklistable coins are flagged as &ldquo;possible-inherited&rdquo; blacklist risk
                </li>
              </ul>
            </div>

            {/* Dependency ceilings */}
            <div className="space-y-2">
              <h3 className="text-foreground font-medium">Dependency Ceilings</h3>
              <p>
                When a stablecoin depends on another (wrapper, mechanism, or collateral relationship), its dependency
                risk score is capped relative to its upstream:
              </p>
              <ul className="list-disc list-inside space-y-1">
                <li>
                  <strong>Wrapper dependency:</strong> capped at upstream score minus 3 points
                </li>
                <li>
                  <strong>Mechanism dependency:</strong> capped at upstream score
                </li>
                <li>
                  <strong>Collateral dependency:</strong> blended into dependency risk dimension via weighted average
                </li>
              </ul>
              <p>
                If any upstream dependency scores below 75, a 10-point penalty is applied. These ceilings prevent a
                wrapped token from outscoring its underlying asset.
              </p>
            </div>

            {/* Limitations */}
            <div className="space-y-2">
              <h3 className="text-foreground font-medium">Limitations</h3>
              <ul className="list-disc list-inside space-y-1">
                <li>
                  Peg stability only reflects price data &mdash; can&apos;t detect coins &ldquo;stable&rdquo; because
                  nobody trades them
                </li>
                <li>Decentralization is structural, not a value judgment</li>
                <li>Dependency map is manually maintained &mdash; may not capture every collateral relationship</li>
              </ul>
            </div>
          </MethodologyDetails>
        </CardContent>
      </Card>

      {/* Liquidity Score */}
      <Card
        id="liquidity-methodology"
        className="scroll-mt-36 rounded-xl border border-border/70 border-l-[3px] border-l-cyan-500 bg-card md:scroll-mt-28"
      >
        <CardHeader className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle as="h2">Liquidity Score</CardTitle>
            <span className="inline-flex items-center rounded-md border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 text-xs font-mono font-semibold text-cyan-700 dark:text-cyan-400">
              {LIQUIDITY_METHODOLOGY_VERSION_LABEL}
            </span>
            <Link
              href="/methodology/liquidity-score-changelog"
              className="text-xs text-foreground underline underline-offset-4 hover:text-cyan-700 dark:text-cyan-400 transition-colors"
            >
              Version history &rarr;
            </Link>
          </div>
          <p className="text-xs text-muted-foreground">
            Version increments when liquidity formula weights, source inclusion rules, or TVL normalization logic
            changes.
          </p>
        </CardHeader>
        <CardContent className="space-y-6 text-sm text-muted-foreground leading-relaxed">
          <p>
            Composite 0&ndash;100 score measuring DEX liquidity depth per stablecoin, updated every 30 minutes.
            Aggregates pool data across all major DEXes and chains.
          </p>
          <p>
            Dedicated direct-API sources (Fluid, Balancer, Raydium, Orca) are treated as primary-grade inputs and
            replace overlapping DeFiLlama pools before staged or fallback discovery sources are merged.
          </p>
          <p>
            When direct APIs expose pool-inventory metadata, Balancer, Raydium, and Orca now contribute measured
            balance health and fee detail instead of neutral placeholders. Balancer weighted pools are normalized
            against target token weights before the balance ratio is computed. Fluid now reads reserves and fee detail
            from the official DexReservesResolver on Ethereum, Arbitrum, Base, and Polygon; unsupported Fluid chains
            such as BSC and Plasma still fall back to neutral balance.
          </p>
          <p>
            After bad pools are filtered and secondary-source TVL caps are applied, every exported aggregate and score
            input is rebuilt from the retained pool set. That keeps filtered or downscaled pools from lingering in the
            final score through stale pre-filter totals.
          </p>
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <p className="text-xs uppercase tracking-wide">Update cadence</p>
              <p className="text-foreground">30m refresh</p>
            </div>
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <p className="text-xs uppercase tracking-wide">Signal mix</p>
              <p className="text-foreground">6 weighted liquidity components</p>
            </div>
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <p className="text-xs uppercase tracking-wide">Output</p>
              <p className="text-foreground">0-100 DEX depth score</p>
            </div>
          </div>
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Preconditions &amp; Failure Modes</h3>
            <MethodologyFacts
              facts={[
                {
                  label: "Minimum data",
                  value: "No hard minimum in scorer; missing stability history defaults to neutral 50 sub-scores",
                },
                {
                  label: "Required sources",
                  value: "Pool TVL/volume/chain data plus mechanism and pair-quality metadata",
                },
                {
                  label: "Failure behavior",
                  value: "If liquidity score is null/missing, report-card liquidity dimension is NR",
                },
              ]}
            />
          </div>
          <WorkedExample summary="Worked example (verified against computeLiquidityScore)">
            <p className="font-mono">
              Inputs: effectiveTVL=$25M, TVL=$20M, volume24h=$8M, qualityTVL=$18M, durability=68, pools=12
            </p>
            <p className="font-mono">tvlDepth=67.96, volume=63.37, quality=65.11, pair=60</p>
            <p className="font-mono">score=round(0.35*67.96+0.20*63.37+0.225*65.11+0.15*68+0.075*60)=66</p>
            <p>
              Result: <span className="text-foreground">Liquidity score 66</span>.
            </p>
          </WorkedExample>

          <MethodologyDetails summary="Technical details: component weights, TVL scaling, and quality adjustments">
            {/* Liquidity component diagram — desktop: 3×2 grid */}
            <div className="hidden md:flex flex-col items-center gap-3">
              <div className="grid grid-cols-5 gap-3 w-full">
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium">TVL Depth</p>
                  <p className="text-xs text-muted-foreground mt-0.5">35%</p>
                </div>
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium">Volume Activity</p>
                  <p className="text-xs text-muted-foreground mt-0.5">20%</p>
                </div>
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium">Pool Quality</p>
                  <p className="text-xs text-muted-foreground mt-0.5">22.5%</p>
                </div>
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium">Durability</p>
                  <p className="text-xs text-muted-foreground mt-0.5">15%</p>
                </div>
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium">Pair Diversity</p>
                  <p className="text-xs text-muted-foreground mt-0.5">7.5%</p>
                </div>
              </div>
              <div className="text-muted-foreground text-xl font-bold">&darr;</div>
              <div className="rounded-lg border p-3 text-center w-64">
                <p className="text-foreground font-medium">Liquidity Score</p>
                <p className="text-xs text-muted-foreground mt-0.5">0&ndash;100</p>
              </div>
            </div>

            {/* Liquidity component diagram — mobile: 2-col grid */}
            <div className="flex flex-col items-center gap-3 md:hidden">
              <div className="grid grid-cols-2 gap-2 w-full">
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium text-xs">TVL Depth</p>
                  <p className="text-xs text-muted-foreground">35%</p>
                </div>
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium text-xs">Vol. Activity</p>
                  <p className="text-xs text-muted-foreground">20%</p>
                </div>
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium text-xs">Pool Quality</p>
                  <p className="text-xs text-muted-foreground">22.5%</p>
                </div>
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium text-xs">Durability</p>
                  <p className="text-xs text-muted-foreground">15%</p>
                </div>
                <div className="rounded-lg border p-3 text-center col-span-2">
                  <p className="text-foreground font-medium text-xs">Pair Diversity</p>
                  <p className="text-xs text-muted-foreground">7.5%</p>
                </div>
              </div>
              <div className="text-muted-foreground text-xl font-bold">&darr;</div>
              <div className="w-full rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium">Liquidity Score</p>
                <p className="text-xs text-muted-foreground mt-0.5">0&ndash;100</p>
              </div>
            </div>

            {/* Components */}
            <div className="space-y-2">
              <h3 className="text-foreground font-medium">Components</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <th className="py-2 pr-4 font-medium text-foreground">Component</th>
                      <th className="py-2 pr-4 font-medium text-foreground">Weight</th>
                      <th className="py-2 font-medium text-foreground">How it works</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-2 pr-4 text-foreground">TVL Depth</td>
                      <td className="py-2 pr-4">35%</td>
                      <td className="py-2">
                        Log-scale effective TVL (quality-adjusted, metapool-deduped): $100K&rarr;20, $1M&rarr;40,
                        $10M&rarr;60, $100M&rarr;80, $1B+&rarr;100
                      </td>
                    </tr>
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-2 pr-4 text-foreground">Volume Activity</td>
                      <td className="py-2 pr-4">20%</td>
                      <td className="py-2">
                        Log-scale V/T ratio: 33.3&times;log10(vtRatio/0.005). ~0.5%&rarr;13, ~5%&rarr;56, ~50%&rarr;100
                      </td>
                    </tr>
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-2 pr-4 text-foreground">Pool Quality</td>
                      <td className="py-2 pr-4">22.5%</td>
                      <td className="py-2">
                        Quality-adjusted TVL using pool mechanism multiplier &times; balance health &times; pair
                        quality. Curve StableSwap (A&ge;500) = 1.0&times;, Uni V3 1bp = 1.1&times;, Fluid/
                        Balancer/Raydium/Orca direct APIs now feed measured balance health when available, and generic
                        AMM = 0.3&times;
                      </td>
                    </tr>
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-2 pr-4 text-foreground">Durability</td>
                      <td className="py-2 pr-4">15%</td>
                      <td className="py-2">
                        TVL stability (35%), volume consistency (25%), pool maturity (25%), organic fee fraction with
                        sqrt curve (15%)
                      </td>
                    </tr>
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-2 pr-4 text-foreground">Pair Diversity</td>
                      <td className="py-2 pr-4">7.5%</td>
                      <td className="py-2">Pool count with diminishing returns: min(100, poolCount &times; 5)</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            {/* Quality multipliers */}
            <div className="space-y-2">
              <h3 className="text-foreground font-medium">Pool Quality Adjustments</h3>
              <ul className="list-disc list-inside space-y-1">
                <li>
                  <span className="text-foreground">Balance health</span> &mdash; continuous ratio (not binary
                  threshold): pools with imbalanced reserves score lower
                </li>
                <li>
                  <span className="text-foreground">Pair quality</span> &mdash; co-token scored by Pharos governance
                  classification (CeFi&rarr;1.0, DeFi&rarr;0.9, CeFi-Dep&rarr;0.8) plus static map for volatile assets
                  (WETH&rarr;0.65, WBTC&rarr;0.6)
                </li>
                <li>
                  <span className="text-foreground">Metapool dedup</span> &mdash; uses TVL excluding base pool to
                  prevent double-counting across Curve metapools
                </li>
                <li>
                  <span className="text-foreground">Retained-pool recomputation</span> &mdash; HHI, depth, volume, and
                  balance/organic/durability inputs are all recomputed from the same retained pool set before the UI
                  truncates to the top 10 displayed pools
                </li>
              </ul>
            </div>
          </MethodologyDetails>
        </CardContent>
      </Card>

      {/* Mint/Burn Flow Scoring */}
      <Card
        id="mint-burn-flow-methodology"
        className="scroll-mt-36 rounded-xl border border-border/70 border-l-[3px] border-l-orange-500 bg-card md:scroll-mt-28"
      >
        <CardHeader className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle as="h2">Mint/Burn Flow Scoring</CardTitle>
            <span className="inline-flex items-center rounded-md border border-orange-500/30 bg-orange-500/10 px-2 py-0.5 text-xs font-mono font-semibold text-orange-700 dark:text-orange-400">
              {MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL}
            </span>
            <Link
              href={MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH}
              className="text-xs text-foreground underline underline-offset-4 hover:text-orange-700 dark:text-orange-400 transition-colors"
            >
              Version history &rarr;
            </Link>
          </div>
          <p className="text-xs text-muted-foreground">
            Version increments when flow scoring logic, tracked event semantics, or ingestion attribution policies
            change.
          </p>
        </CardHeader>
        <CardContent className="space-y-6 text-sm text-muted-foreground leading-relaxed">
          <p>
            Pharos tracks on-chain mint and burn events for major stablecoins via Alchemy JSON-RPC (Transfer mints/burns
            plus USDT Issue/Redeem). These raw events are aggregated into hourly buckets and exposed as two separate
            signals: raw net flow for current direction, and a baseline-relative pressure score for context. Counted
            flow excludes bridge burns, review-required burns, and atomic roundtrips.
          </p>
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <p className="text-xs uppercase tracking-wide">Data source</p>
              <p className="text-foreground">On-chain mint + burn events</p>
            </div>
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <p className="text-xs uppercase tracking-wide">Primary score</p>
              <p className="text-foreground">Pressure Shift vs 30D</p>
            </div>
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <p className="text-xs uppercase tracking-wide">Main outputs</p>
              <p className="text-foreground">Net flow, gauge, and FtQ</p>
            </div>
          </div>
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Preconditions &amp; Failure Modes</h3>
            <MethodologyFacts
              facts={[
                {
                  label: "Minimum data",
                  value: "Pressure Shift vs 30D requires at least 7 days of flow history per coin",
                },
                { label: "Required sources", value: "24h mint/burn totals plus 30-day baseline aggregates" },
                {
                  label: "Failure behavior",
                  value:
                    "Pressure shift can be null (NR); gauge is null when no weighted inputs contribute; FtQ needs ±$100M dual threshold",
                },
                {
                  label: "Counted rows",
                  value: "Economic-flow aggregates count standard mints plus effective burns only",
                },
              ]}
            />
          </div>
          <WorkedExample summary="Worked example (verified against computeFlowIntensity)">
            <p className="font-mono">Inputs: currentNet=-$0.2M, baselineNet=-$7.5M, baselineAbs=$40M</p>
            <p className="font-mono">denominator=max(40M*0.3,1M)=12M; z=(-0.2M-(-7.5M))/12M=0.608</p>
            <p className="font-mono">pressureShift=clamp(-100,100,z*50)=30.4</p>
            <p>
              Result: <span className="text-foreground">still burning today, but much lighter than its baseline.</span>
            </p>
          </WorkedExample>

          <MethodologyDetails summary="Technical details: two-signal pipeline, pressure formula, and gauge bands">
            {/* Flow pipeline diagram — desktop: horizontal */}
            <div className="hidden md:flex items-stretch gap-4">
              {/* Inputs */}
              <div className="flex flex-col gap-2 flex-1">
                <div className="rounded-lg border p-3 text-center flex-1">
                  <p className="text-foreground font-medium">Mints</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Transfer from 0x0</p>
                </div>
                <div className="rounded-lg border p-3 text-center flex-1">
                  <p className="text-foreground font-medium">Burns</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Transfer to 0x0</p>
                </div>
              </div>
              <div className="flex items-center text-muted-foreground text-xl font-bold">&rarr;</div>
              {/* Aggregation */}
              <div className="rounded-lg border p-3 text-center flex-1 flex flex-col justify-center">
                <p className="text-foreground font-medium">Hourly Buckets</p>
                <p className="text-xs text-muted-foreground mt-0.5">Trailing 30 closed daily Ethereum buckets</p>
              </div>
              <div className="flex items-center text-muted-foreground text-xl font-bold">&rarr;</div>
              <div className="flex flex-col gap-2 flex-1">
                <div className="rounded-lg border p-3 text-center flex-1">
                  <p className="text-foreground font-medium">Net Flow 24h</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Current mint minus burn direction</p>
                </div>
                <div className="rounded-lg border p-3 text-center flex-1">
                  <p className="text-foreground font-medium">Pressure Shift vs 30D</p>
                  <p className="text-xs text-muted-foreground mt-0.5">-100 worsening · 0 baseline · +100 improving</p>
                </div>
              </div>
              <div className="flex items-center text-muted-foreground text-xl font-bold">&rarr;</div>
              {/* Outputs */}
              <div className="flex flex-col gap-2 flex-1">
                <div className="rounded-lg border p-3 text-center flex-1">
                  <p className="text-foreground font-medium">Bank Run Gauge</p>
                  <p className="text-xs text-muted-foreground mt-0.5">market-cap weighted</p>
                </div>
                <div className="rounded-lg border p-3 text-center flex-1">
                  <p className="text-foreground font-medium">Flight-to-Quality</p>
                  <p className="text-xs text-muted-foreground mt-0.5">dual threshold detection</p>
                </div>
              </div>
            </div>

            {/* Flow pipeline diagram — mobile: vertical */}
            <div className="flex flex-col items-center gap-3 md:hidden">
              <div className="grid grid-cols-2 gap-2 w-full">
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium text-xs">Mints</p>
                  <p className="text-xs text-muted-foreground">Transfer from 0x0</p>
                </div>
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium text-xs">Burns</p>
                  <p className="text-xs text-muted-foreground">Transfer to 0x0</p>
                </div>
              </div>
              <div className="text-muted-foreground text-xl font-bold">&darr;</div>
              <div className="w-full rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium">Hourly Buckets</p>
                <p className="text-xs text-muted-foreground mt-0.5">Trailing 30 closed daily Ethereum buckets</p>
              </div>
              <div className="text-muted-foreground text-xl font-bold">&darr;</div>
              <div className="grid w-full gap-2">
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium">Net Flow 24h</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Current mint minus burn direction</p>
                </div>
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium">Pressure Shift vs 30D</p>
                  <p className="text-xs text-muted-foreground mt-0.5">-100 worsening · 0 baseline · +100 improving</p>
                </div>
              </div>
              <div className="text-muted-foreground text-xl font-bold">&darr;</div>
              <div className="grid grid-cols-2 gap-2 w-full">
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium text-xs">Bank Run Gauge</p>
                  <p className="text-xs text-muted-foreground">market-cap weighted</p>
                </div>
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium text-xs">Flight-to-Quality</p>
                  <p className="text-xs text-muted-foreground">dual threshold</p>
                </div>
              </div>
            </div>

            {/* Net Flow */}
            <div className="space-y-2">
              <h3 className="text-foreground font-medium">Net Flow 24h</h3>
              <p>
                Net Flow answers the first question directly: is a coin minting or burning right now? It is the raw
                24-hour mint volume minus burn volume.
              </p>
              <ul className="list-disc list-inside space-y-1">
                <li>
                  <span className="text-foreground">Minting</span> &mdash; `netFlow24hUsd &gt; 0`
                </li>
                <li>
                  <span className="text-foreground">Burning</span> &mdash; `netFlow24hUsd &lt; 0`
                </li>
                <li>
                  <span className="text-foreground">Flat</span> &mdash; `netFlow24hUsd = 0` with activity
                </li>
                <li>
                  <span className="text-foreground">No activity</span> &mdash; no 24h mint/burn events in the window
                </li>
                <li>
                  <span className="text-foreground">Invariant</span> &mdash; minting vs burning always comes from raw
                  net flow, never from the pressure score sign
                </li>
              </ul>
            </div>

            {/* Pressure Shift */}
            <div className="space-y-2">
              <h3 className="text-foreground font-medium">Pressure Shift vs 30D</h3>
              <p>
                This is the existing Flow Intensity formula under clearer naming. It measures how far current 24-hour
                flow pressure deviates from the coin&apos;s own trailing 30 fully closed daily Ethereum baseline.
              </p>
              <p className="font-mono text-xs border border-l-[3px] border-l-amber-500 border-border/60 bg-muted/50 rounded-lg px-4 py-3">
                denominator = max(baselineDailyAbs &times; 0.3, $1M)
                <br />
                z = (currentDailyNet &minus; baselineDailyNet) / denominator
                <br />
                pressureShift = clamp(-100, 100, z &times; 50)
              </p>
              <ul className="list-disc list-inside space-y-1">
                <li>
                  <span className="text-foreground">Baseline period</span> &mdash; trailing 30 fully closed UTC days of
                  Ethereum daily net flows and absolute volumes, excluding the current partial day
                </li>
                <li>
                  <span className="text-foreground">Minimum data</span> &mdash; requires 7 days of history; returns null
                  (NR) otherwise
                </li>
                <li>
                  <span className="text-foreground">Activity gate</span> &mdash; windows with no 24h mint/burn activity
                  or less than $50K absolute 24h flow are marked NR and excluded from gauge weighting
                </li>
                <li>
                  <span className="text-foreground">Ingestion safety</span> &mdash; sync state advances only to the
                  shared safe coverage frontier when some event definitions or block timestamps are incomplete
                </li>
                <li>
                  <span className="text-foreground">Floor</span> &mdash; denominator is floored at $1M to prevent noise
                  in low-volume coins
                </li>
                <li>
                  <span className="text-foreground">Interpretation</span> &mdash; above +10 = improving vs baseline,
                  between -10 and +10 = stable vs baseline, below -10 = worsening
                </li>
              </ul>
            </div>

            {/* Bank Run Gauge */}
            <div className="space-y-2">
              <h3 className="text-foreground font-medium">Bank Run Gauge</h3>
              <p>
                Market-cap-weighted composite of all tracked coins&apos; pressure-shift values, producing a single
                ecosystem-wide Ethereum flow-pressure reading. The gauge score maps to one of seven condition bands:
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <th className="py-2 pr-4 font-medium text-foreground">Band</th>
                      <th className="py-2 pr-4 font-medium text-foreground">Score Range</th>
                      <th className="py-2 font-medium text-foreground">Meaning</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-1.5 pr-4 text-foreground">CRISIS</td>
                      <td className="py-1.5 pr-4">&minus;100 to &minus;70</td>
                      <td className="py-1.5">Severe below-baseline redemption pressure across major coins</td>
                    </tr>
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-1.5 pr-4 text-foreground">STRESS</td>
                      <td className="py-1.5 pr-4">&minus;70 to &minus;40</td>
                      <td className="py-1.5">Worsening coordinated pressure versus normal conditions</td>
                    </tr>
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-1.5 pr-4 text-foreground">CAUTIOUS</td>
                      <td className="py-1.5 pr-4">&minus;40 to &minus;10</td>
                      <td className="py-1.5">Mild but broad pressure deterioration</td>
                    </tr>
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-1.5 pr-4 text-foreground">NEUTRAL</td>
                      <td className="py-1.5 pr-4">&minus;10 to 10</td>
                      <td className="py-1.5">Close to 30D norms across the market</td>
                    </tr>
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-1.5 pr-4 text-foreground">HEALTHY</td>
                      <td className="py-1.5 pr-4">10 to 40</td>
                      <td className="py-1.5">Improving aggregate pressure versus baseline</td>
                    </tr>
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-1.5 pr-4 text-foreground">CONFIDENT</td>
                      <td className="py-1.5 pr-4">40 to 70</td>
                      <td className="py-1.5">Strong positive pressure shift across major coins</td>
                    </tr>
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-1.5 pr-4 text-foreground">SURGE</td>
                      <td className="py-1.5 pr-4">70 to 100</td>
                      <td className="py-1.5">Exceptional improvement versus recent norms</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p>
                Returns null only when all tracked coins are NR (for example, insufficient history or no 24h mint/burn
                activity). Coins with null pressure-shift values are skipped from the market-cap-weighted composite.
              </p>
            </div>

            {/* Flight-to-quality */}
            <div className="space-y-2">
              <h3 className="text-foreground font-medium">Flight-to-Quality Detection</h3>
              <p>
                Detects capital rotation from risky to safe-haven stablecoins &mdash; a pattern typically seen during
                market stress when holders move funds from algorithmic or less-established coins into fully-backed
                centralized stablecoins.
              </p>
              <ul className="list-disc list-inside space-y-1">
                <li>
                  <span className="text-foreground">Safe classification</span> &mdash; centralized governance with
                  real-world-asset backing (USDT, USDC, FDUSD, PYUSD)
                </li>
                <li>
                  <span className="text-foreground">Dual threshold</span> &mdash; active when risky coins have &gt;$100M
                  net outflows AND safe coins have &gt;$100M net inflows simultaneously over 24h
                </li>
                <li>
                  <span className="text-foreground">Intensity scaling</span> &mdash; min(100, |riskyOutflows| / $1B
                  &times; 100), reflecting the magnitude of the rotation
                </li>
              </ul>
            </div>
          </MethodologyDetails>
        </CardContent>
      </Card>

      {/* Yield Intelligence */}
      <Card
        id="yield-intelligence-methodology"
        className="scroll-mt-36 rounded-xl border border-border/70 border-l-[3px] border-l-violet-500 bg-card md:scroll-mt-28"
      >
        <CardHeader className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle as="h2">Yield Intelligence</CardTitle>
            <span className="inline-flex items-center rounded-md border border-violet-500/30 bg-violet-500/10 px-2 py-0.5 text-xs font-mono font-semibold text-violet-700 dark:text-violet-400">
              {YIELD_METHODOLOGY_VERSION_LABEL}
            </span>
            <Link
              href={YIELD_METHODOLOGY_CHANGELOG_PATH}
              className="text-xs text-foreground underline underline-offset-4 hover:text-violet-700 dark:text-violet-400 transition-colors"
            >
              Version history &rarr;
            </Link>
          </div>
          <p className="text-xs text-muted-foreground">
            Version increments when APY source resolution, source arbitration, history semantics, PYS scoring logic, or
            eligibility rules for discovered yield sources change.
          </p>
        </CardHeader>
        <CardContent className="space-y-6 text-sm text-muted-foreground leading-relaxed">
          <p>
            Pharos tracks yield-bearing stablecoins and computes a risk-adjusted ranking via the Pharos Yield Score
            (PYS). Data is refreshed every 30 minutes using a source-aware APY resolution strategy, with alternative
            sources retained when multiple valid yield paths exist and confidence-weighted arbitration selecting the
            primary row.
          </p>
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <p className="text-xs uppercase tracking-wide">Update cadence</p>
              <p className="text-foreground">30m refresh</p>
            </div>
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <p className="text-xs uppercase tracking-wide">APY priority</p>
              <p className="text-foreground">Confidence-weighted across deterministic, curated, and fallback sources</p>
            </div>
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <p className="text-xs uppercase tracking-wide">Output</p>
              <p className="text-foreground">PYS (0-100)</p>
            </div>
          </div>
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Preconditions &amp; Failure Modes</h3>
            <MethodologyFacts
              facts={[
                {
                  label: "Minimum data",
                  value:
                    "Need one resolved APY source; deterministic exchange-rate sources additionally need prior source-specific history",
                },
                {
                  label: "Required sources",
                  value:
                    "Direct on-chain reads, curated DeFiLlama pools, rate-derived benchmark inputs, or 30d price history",
                },
                {
                  label: "Failure behavior",
                  value:
                    "No resolved source skips coin update; PYS returns 0 when apy30d <= 0 (safety defaults to 40 if missing), while degraded benchmark or safety inputs are surfaced in provenance",
                },
              ]}
            />
          </div>
          <WorkedExample summary="Worked example (verified against computePYS)">
            <p className="font-mono">Inputs: apy30d=8.4, safetyScore=72, apyVarianceScore=0.18, scalingFactor=5</p>
            <p className="font-mono">
              riskPenalty=max(0.5,(101-72)/20)=1.45; yieldEfficiency=8.4/1.45=5.79; sustainability=1-0.18=0.82
            </p>
            <p className="font-mono">PYS=min(100, round(5.79*0.82*5))=24</p>
            <p>
              Result: <span className="text-foreground">PYS 24</span>.
            </p>
          </WorkedExample>

          <MethodologyDetails summary="Technical details: APY source resolution, confidence arbitration, PYS formula, NAV handling, and limits">
            {/* Yield pipeline diagram — desktop: horizontal */}
            <div className="hidden md:flex items-stretch gap-4">
              {/* Three tiers */}
              <div className="flex flex-col gap-2 flex-1">
                <div className="rounded-lg border p-3 text-center flex-1">
                  <p className="text-foreground font-medium">Tier 1</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Direct on-chain reads</p>
                </div>
                <div className="rounded-lg border p-3 text-center flex-1">
                  <p className="text-foreground font-medium">Tier 2</p>
                  <p className="text-xs text-muted-foreground mt-0.5">DeFiLlama pools</p>
                </div>
                <div className="rounded-lg border p-3 text-center flex-1">
                  <p className="text-foreground font-medium">Tier 3</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Price- or rate-derived fallback</p>
                </div>
              </div>
              <div className="flex items-center text-muted-foreground text-xl font-bold">&rarr;</div>
              {/* APY */}
              <div className="rounded-lg border p-3 text-center w-32 flex flex-col justify-center flex-shrink-0">
                <p className="text-foreground font-medium">APY</p>
                <p className="text-xs text-muted-foreground mt-0.5">first successful tier</p>
              </div>
              <div className="flex items-center text-muted-foreground text-xl font-bold">&rarr;</div>
              {/* Formula components */}
              <div className="flex flex-col gap-2 flex-1">
                <div className="rounded-lg border p-3 text-center flex-1">
                  <p className="text-foreground font-medium">Yield Efficiency</p>
                  <p className="text-xs text-muted-foreground mt-0.5">APY ÷ risk penalty</p>
                </div>
                <div className="rounded-lg border p-3 text-center flex-1">
                  <p className="text-foreground font-medium">Sustainability</p>
                  <p className="text-xs text-muted-foreground mt-0.5">penalises high variance</p>
                </div>
              </div>
              <div className="flex items-center text-muted-foreground text-xl font-bold">&rarr;</div>
              {/* PYS */}
              <div className="rounded-lg border p-3 text-center w-32 flex flex-col justify-center flex-shrink-0">
                <p className="text-foreground font-medium">PYS Score</p>
                <p className="text-xs text-muted-foreground mt-0.5">0–100</p>
              </div>
            </div>

            {/* Yield pipeline diagram — mobile: vertical */}
            <div className="flex flex-col items-center gap-3 md:hidden">
              <div className="grid grid-cols-3 gap-2 w-full">
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium text-xs">Tier 1</p>
                  <p className="text-xs text-muted-foreground">On-chain reads</p>
                </div>
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium text-xs">Tier 2</p>
                  <p className="text-xs text-muted-foreground">DeFiLlama</p>
                </div>
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium text-xs">Tier 3</p>
                  <p className="text-xs text-muted-foreground">Price-derived</p>
                </div>
              </div>
              <div className="text-muted-foreground text-xl font-bold">&darr;</div>
              <div className="w-full rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium">APY</p>
                <p className="text-xs text-muted-foreground mt-0.5">first successful tier</p>
              </div>
              <div className="text-muted-foreground text-xl font-bold">&darr;</div>
              <div className="grid grid-cols-2 gap-2 w-full">
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium text-xs">Yield Efficiency</p>
                  <p className="text-xs text-muted-foreground">APY ÷ risk penalty</p>
                </div>
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium text-xs">Sustainability</p>
                  <p className="text-xs text-muted-foreground">penalises variance</p>
                </div>
              </div>
              <div className="text-muted-foreground text-xl font-bold">&darr;</div>
              <div className="w-full rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium">PYS Score</p>
                <p className="text-xs text-muted-foreground mt-0.5">0–100</p>
              </div>
            </div>

            {/* APY Resolution tiers */}
            <div className="space-y-2">
              <h3 className="text-foreground font-medium">APY Resolution and Source Arbitration</h3>
              <ul className="list-disc list-inside space-y-1">
                <li>
                  <span className="text-foreground">Tier 1 &mdash; Direct on-chain reads</span>: reads protocol state
                  directly, either as an exchange-rate delta (e.g.&nbsp;sUSDe) or a conservative reward-only estimator
                  (e.g.&nbsp;LUSD B.Protocol Stability Pool, LQTY only)
                </li>
                <li>
                  <span className="text-foreground">Tier 2 &mdash; DeFiLlama pools</span>: matches the coin to a
                  DeFiLlama yield pool via static mapping or symbol-based fallback
                </li>
                <li>
                  <span className="text-foreground">Tier 3 &mdash; Price-derived</span>: for NAV tokens only, derives
                  APY from the 30-day price appreciation in supply_history
                </li>
                <li>
                  <span className="text-foreground">Tier 4 &mdash; Rate-derived</span>: for dividend-distributing and
                  Treasury-tracking tokens, derives APY from the cached 3-month Treasury benchmark net of known fee
                  spreads
                </li>
              </ul>
              <p>
                Deterministic and curated paths can all contribute rows, then a confidence-weighted arbitration layer
                chooses the best row. Divergent discovered or fallback sources can be demoted or rejected when a
                canonical source disagrees materially.
              </p>
              <p>
                Trailing APY metrics are computed from source-specific history rather than a mixed coin-level series, so
                source switches no longer contaminate the displayed 7d/30d averages.
              </p>
            </div>

            {/* PYS formula */}
            <div className="space-y-2">
              <h3 className="text-foreground font-medium">Pharos Yield Score (PYS)</h3>
              <p className="font-mono text-xs border border-l-[3px] border-l-amber-500 border-border/60 bg-muted/50 rounded-lg px-4 py-3">
                riskPenalty = max(0.5, (101 &minus; safetyScore) / 20)
                <br />
                yieldEfficiency = apy30d / riskPenalty
                <br />
                sustainability = max(0.3, 1.0 &minus; apyVarianceScore)
                <br />
                PYS = min(100, yieldEfficiency &times; sustainability &times; scalingFactor)
              </p>
              <ul className="list-disc list-inside space-y-1">
                <li>
                  <span className="text-foreground">Yield efficiency</span> rewards higher APY relative to the
                  coin&apos;s risk profile &mdash; safer coins get a lower penalty divisor
                </li>
                <li>
                  <span className="text-foreground">Sustainability multiplier</span> penalizes volatile yields (high
                  variance over 30 days), favouring consistent returns
                </li>
                <li>
                  <span className="text-foreground">Scaling factor</span> is a global constant that normalises scores
                  into the 0&ndash;100 range
                </li>
              </ul>
            </div>

            {/* NAV token note */}
            <div className="space-y-2">
              <h3 className="text-foreground font-medium">NAV Token Handling</h3>
              <p>
                NAV-appreciating tokens (e.g.&nbsp;sDAI, wUSDM, BUIDL) are not covered by the report card
                framework&apos;s safety grading &mdash; they receive a default safety baseline of 40 (NR). Their PYS is
                therefore derived primarily from APY magnitude and variance rather than a full safety assessment. As the
                grading framework expands to cover NAV tokens, their PYS will become more nuanced.
              </p>
            </div>

            {/* Limitations */}
            <div className="space-y-2">
              <h3 className="text-foreground font-medium">Limitations</h3>
              <ul className="list-disc list-inside space-y-1">
                <li>
                  Trailing averages require sufficient history &mdash; newly tracked coins may show unstable scores
                  until 30 days of data accumulate
                </li>
                <li>
                  DeFiLlama pool matching uses heuristics; pool mismatches are corrected via the static override map
                </li>
                <li>
                  The LUSD B.Protocol Stability Pool row is conservative by design: it includes projected LQTY
                  incentives only and excludes ETH liquidation gains
                </li>
                <li>Price-derived APY (Tier 3) can be noisy for low-liquidity NAV tokens</li>
              </ul>
            </div>
          </MethodologyDetails>
        </CardContent>
      </Card>

      {/* PegScore and Depeg Early Warning Score (DEWS) */}
      <Card
        id="pegscore-dews-methodology"
        className="scroll-mt-36 rounded-xl border border-border/70 border-l-[3px] border-l-amber-500 bg-card md:scroll-mt-28"
      >
        <CardHeader className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle as="h2">PegScore and Depeg Early Warning Score (DEWS)</CardTitle>
            <span className="inline-flex items-center rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs font-mono font-semibold text-amber-700 dark:text-amber-400">
              {DEPEG_DEWS_METHODOLOGY_VERSION_LABEL}
            </span>
            <Link
              href={DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH}
              className="text-xs text-foreground underline underline-offset-4 hover:text-amber-700 dark:text-amber-400 transition-colors"
            >
              Version history &rarr;
            </Link>
          </div>
          <p className="text-xs text-muted-foreground">
            Version increments when depeg thresholds, confirmation policy, peg-score formula terms, or DEWS signal
            composition changes.
          </p>
        </CardHeader>
        <CardContent className="space-y-6 text-sm text-muted-foreground leading-relaxed">
          <p>
            PegScore observes the past and present by scoring realized peg behavior, while DEWS is forward-looking and
            tries to anticipate future depeg risk before it fully manifests.
          </p>
          <p>
            Depeg Tracker combines live event detection, secondary-source confirmation rules for large-cap assets,
            low-confidence primary prices, and extreme moves, plus a per-coin peg score that penalizes time off peg,
            event severity, active depegs, and unstable event spread. Pending depeg confirmation checks off-chain
            sources (CoinGecko or DefiLlama), CEX tickers (Binance), and DEX prices before promoting or rejecting
            candidates.
          </p>
          <p>
            DEX cross-validation uses explicit trust gates. Detection and pending confirmation only trust fresh DEX rows
            with at least $1M of aggregate source TVL, while the public DEX Price Check UI requires a lighter but still
            non-trivial floor of $250K.
          </p>
          <p>
            DEWS (Depeg Early Warning System) computes forward-looking stress every 15 minutes from market, liquidity,
            confidence, flow, and yield signals, with optional PSI-based amplification during systemic stress.
          </p>
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <p className="text-xs uppercase tracking-wide">PegScore focus</p>
              <p className="text-foreground">History: realized peg behavior</p>
            </div>
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <p className="text-xs uppercase tracking-wide">DEWS focus</p>
              <p className="text-foreground">Forward stress probability</p>
            </div>
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <p className="text-xs uppercase tracking-wide">Refresh</p>
              <p className="text-foreground">15m refresh</p>
            </div>
          </div>
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Preconditions &amp; Failure Modes</h3>
            <MethodologyFacts
              facts={[
                {
                  label: "Minimum data",
                  value:
                    "PegScore requires >=30 tracking days; DEWS requires >=2 available signals (total weight >=0.30)",
                },
                {
                  label: "Required sources",
                  value:
                    "Peg events + tracking window inputs; DEWS consumes supply/liquidity/price plus optional flow/blacklist/yield signals",
                },
                {
                  label: "Failure behavior",
                  value: "PegScore can be null; DEWS also returns null when signal coverage is below threshold",
                },
              ]}
            />
          </div>
          <WorkedExample summary="Worked examples (verified against computePegScore and computeDEWS)">
            <p className="font-mono">PegScore input: 100-day tracking window, 1 event (2 days, 220 bps, inactive)</p>
            <p className="font-mono">pegPct=98.0, severityScore=99.86, spread=0, activePenalty=0 &rarr; pegScore=99</p>
            <p className="font-mono">
              DEWS input signals: supply=40, pool=55, liq=25, price=0, diverg=10 (others unavailable), psiScore=70
            </p>
            <p className="font-mono">
              base=(0.25*40+0.2*55+0.15*25+0.15*0+0.15*10)/0.9=29.17; PSI amplifier=1.02 &rarr; DEWS=30
            </p>
            <p>
              Result: <span className="text-foreground">PegScore 99 and DEWS 30 (WATCH)</span>.
            </p>
          </WorkedExample>

          <MethodologyDetails summary="Technical details: PegScore formula, DEWS signals, weights, and threat bands">
            <div className="space-y-2">
              <h3 className="text-foreground font-medium">PegScore</h3>
              <p>
                Composite 0&ndash;100 score measuring how faithfully a stablecoin holds its peg. The tracking window
                spans up to 4 years but is capped at the coin&apos;s actual age (earliest supply snapshot), so young
                coins are not diluted across history they didn&apos;t exist for. Requires at least 30 days of tracking
                data; returns null otherwise.
              </p>
            </div>

            {/* Peg score formula */}
            <div className="space-y-2">
              <h3 className="text-foreground font-medium">PegScore Formula</h3>
              <p className="font-mono text-xs border border-l-[3px] border-l-amber-500 border-border/60 bg-muted/50 rounded-lg px-4 py-3">
                pegScore = 0.5 &times; pegPct + 0.5 &times; severityScore &minus; activeDepegPenalty &minus;
                spreadPenalty
              </p>
            </div>

            {/* Peg score flow diagram — desktop */}
            <div className="hidden md:flex flex-col items-center gap-3">
              <div className="grid grid-cols-2 gap-3 w-full max-w-md">
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium">Time-at-Peg</p>
                  <p className="text-xs text-muted-foreground mt-0.5">50%</p>
                </div>
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium">Event Severity</p>
                  <p className="text-xs text-muted-foreground mt-0.5">50%</p>
                </div>
              </div>
              <div className="text-muted-foreground text-xl font-bold">&darr;</div>
              <div className="rounded-lg border p-3 text-center w-64">
                <p className="text-foreground font-medium">&minus; Penalties</p>
                <p className="text-xs text-muted-foreground mt-0.5">active depeg + spread</p>
              </div>
              <div className="text-muted-foreground text-xl font-bold">&darr;</div>
              <div className="rounded-lg border p-3 text-center w-64">
                <p className="text-foreground font-medium">PegScore</p>
                <p className="text-xs text-muted-foreground mt-0.5">0&ndash;100</p>
              </div>
            </div>

            {/* Peg score flow diagram — mobile */}
            <div className="flex flex-col items-center gap-3 md:hidden">
              <div className="grid grid-cols-2 gap-2 w-full">
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium text-xs">Time-at-Peg</p>
                  <p className="text-xs text-muted-foreground">50%</p>
                </div>
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium text-xs">Event Severity</p>
                  <p className="text-xs text-muted-foreground">50%</p>
                </div>
              </div>
              <div className="text-muted-foreground text-xl font-bold">&darr;</div>
              <div className="w-full rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium">&minus; Penalties</p>
                <p className="text-xs text-muted-foreground mt-0.5">active depeg + spread</p>
              </div>
              <div className="text-muted-foreground text-xl font-bold">&darr;</div>
              <div className="w-full rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium">PegScore</p>
                <p className="text-xs text-muted-foreground mt-0.5">0&ndash;100</p>
              </div>
            </div>

            {/* Peg score components */}
            <div className="space-y-2">
              <h3 className="text-foreground font-medium">PegScore Components</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <th className="py-2 pr-4 font-medium text-foreground">Component</th>
                      <th className="py-2 pr-4 font-medium text-foreground">Weight</th>
                      <th className="py-2 pr-4 font-medium text-foreground">Range</th>
                      <th className="py-2 font-medium text-foreground">How it works</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-2 pr-4 text-foreground">Time-at-Peg (pegPct)</td>
                      <td className="py-2 pr-4">50%</td>
                      <td className="py-2 pr-4">0&ndash;100</td>
                      <td className="py-2">
                        Percentage of time spent at peg. Overlapping depeg intervals are merged to avoid double-counting
                      </td>
                    </tr>
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-2 pr-4 text-foreground">Event Severity</td>
                      <td className="py-2 pr-4">50%</td>
                      <td className="py-2 pr-4">0&ndash;100</td>
                      <td className="py-2">
                        Penalizes magnitude, duration, and recency of each depeg event. Per-event penalty:
                        max(durationPenalty, magnitudeFloor), where durationPenalty = (peakBps&nbsp;/&nbsp;100) &times;
                        (durationDays&nbsp;/&nbsp;30) &times; recencyWeight, magnitudeFloor = (peakBps&nbsp;/&nbsp;2000)
                        &times; recencyWeight. The floor ensures even brief depegs carry a minimum penalty proportional
                        to their severity. Recency weight = 1&nbsp;/&nbsp;(1&nbsp;+&nbsp;yearsAgo) so recent events
                        count more. Duration capped at 90 days
                      </td>
                    </tr>
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-2 pr-4 text-foreground">Active Depeg Penalty</td>
                      <td className="py-2 pr-4">subtracted</td>
                      <td className="py-2 pr-4">5&ndash;50</td>
                      <td className="py-2">
                        Applied only if an ongoing depeg exists (no end date). Scales with severity:
                        clamp(absBps&nbsp;/&nbsp;50, 5, 50)
                      </td>
                    </tr>
                    <tr className="hover:bg-muted/40 transition-colors">
                      <td className="py-2 pr-4 text-foreground">Spread Penalty</td>
                      <td className="py-2 pr-4">subtracted</td>
                      <td className="py-2 pr-4">0&ndash;15</td>
                      <td className="py-2">
                        Standard deviation of peak deviations across events, scaled. Penalizes erratic, unpredictable
                        depeg behaviour. Only applies when &ge;2 events exist
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div className="space-y-2">
              <h3 className="text-foreground font-medium">DEWS</h3>
              <p>
                DEWS is a per-coin, forward-looking stress score (0&ndash;100) estimating depeg probability. It is
                computed every 15 minutes from 8 sub-signals. Only signals with available data participate; weights are
                redistributed proportionally across available signals.
              </p>
            </div>

            {/* DEWS pipeline diagram — desktop: horizontal */}
            <div className="hidden md:flex items-stretch gap-4">
              {/* 8 signals */}
              <div className="grid grid-cols-2 gap-2 flex-1">
                <div className="rounded-lg border p-2 text-center">
                  <p className="text-foreground font-medium text-xs">Supply Velocity</p>
                  <p className="text-xs text-muted-foreground">0.25</p>
                </div>
                <div className="rounded-lg border p-2 text-center">
                  <p className="text-foreground font-medium text-xs">Pool Balance Drift</p>
                  <p className="text-xs text-muted-foreground">0.20</p>
                </div>
                <div className="rounded-lg border p-2 text-center">
                  <p className="text-foreground font-medium text-xs">Liquidity Erosion</p>
                  <p className="text-xs text-muted-foreground">0.15</p>
                </div>
                <div className="rounded-lg border p-2 text-center">
                  <p className="text-foreground font-medium text-xs">Price Confidence</p>
                  <p className="text-xs text-muted-foreground">0.15</p>
                </div>
                <div className="rounded-lg border p-2 text-center">
                  <p className="text-foreground font-medium text-xs">Cross-Source Divergence</p>
                  <p className="text-xs text-muted-foreground">0.15</p>
                </div>
                <div className="rounded-lg border p-2 text-center">
                  <p className="text-foreground font-medium text-xs">Blacklist Activity</p>
                  <p className="text-xs text-muted-foreground">0.10</p>
                </div>
                <div className="rounded-lg border p-2 text-center">
                  <p className="text-foreground font-medium text-xs">Mint/Burn Flow</p>
                  <p className="text-xs text-muted-foreground">0.10</p>
                </div>
                <div className="rounded-lg border p-2 text-center">
                  <p className="text-foreground font-medium text-xs">Yield Anomaly</p>
                  <p className="text-xs text-muted-foreground">0.05</p>
                </div>
              </div>
              <div className="flex items-center text-muted-foreground text-xl font-bold">&rarr;</div>
              {/* DEWS */}
              <div className="rounded-lg border p-3 text-center w-36 flex flex-col justify-center flex-shrink-0">
                <p className="text-foreground font-medium">DEWS</p>
                <p className="text-xs text-muted-foreground mt-0.5">&Sigma;(W&sdot;S) / &Sigma;(W)</p>
                <p className="text-xs text-muted-foreground">0–100</p>
              </div>
              <div className="flex items-center text-muted-foreground text-xl font-bold">&rarr;</div>
              {/* Threat bands */}
              <div className="flex flex-col gap-1.5 w-36 justify-center flex-shrink-0">
                <div className="rounded-lg border p-2 text-center">
                  <p className="text-green-700 dark:text-green-400 font-medium text-xs">CALM</p>
                  <p className="text-xs text-muted-foreground">0–15</p>
                </div>
                <div className="rounded-lg border p-2 text-center">
                  <p className="text-teal-700 dark:text-teal-400 font-medium text-xs">WATCH</p>
                  <p className="text-xs text-muted-foreground">16–35</p>
                </div>
                <div className="rounded-lg border p-2 text-center">
                  <p className="text-yellow-700 dark:text-yellow-400 font-medium text-xs">ALERT</p>
                  <p className="text-xs text-muted-foreground">36–55</p>
                </div>
                <div className="rounded-lg border p-2 text-center">
                  <p className="text-orange-700 dark:text-orange-400 font-medium text-xs">WARNING</p>
                  <p className="text-xs text-muted-foreground">56–75</p>
                </div>
                <div className="rounded-lg border p-2 text-center">
                  <p className="text-red-700 dark:text-red-400 font-medium text-xs">DANGER</p>
                  <p className="text-xs text-muted-foreground">76–100</p>
                </div>
              </div>
            </div>

            {/* DEWS pipeline diagram — mobile: vertical */}
            <div className="flex flex-col items-center gap-3 md:hidden">
              <div className="grid grid-cols-2 gap-2 w-full">
                <div className="rounded-lg border p-2 text-center">
                  <p className="text-foreground font-medium text-xs">Supply Velocity</p>
                  <p className="text-xs text-muted-foreground">0.25</p>
                </div>
                <div className="rounded-lg border p-2 text-center">
                  <p className="text-foreground font-medium text-xs">Pool Balance Drift</p>
                  <p className="text-xs text-muted-foreground">0.20</p>
                </div>
                <div className="rounded-lg border p-2 text-center">
                  <p className="text-foreground font-medium text-xs">Liquidity Erosion</p>
                  <p className="text-xs text-muted-foreground">0.15</p>
                </div>
                <div className="rounded-lg border p-2 text-center">
                  <p className="text-foreground font-medium text-xs">Price Confidence</p>
                  <p className="text-xs text-muted-foreground">0.15</p>
                </div>
                <div className="rounded-lg border p-2 text-center">
                  <p className="text-foreground font-medium text-xs">Cross-Source Div.</p>
                  <p className="text-xs text-muted-foreground">0.15</p>
                </div>
                <div className="rounded-lg border p-2 text-center">
                  <p className="text-foreground font-medium text-xs">Blacklist Activity</p>
                  <p className="text-xs text-muted-foreground">0.10</p>
                </div>
                <div className="rounded-lg border p-2 text-center">
                  <p className="text-foreground font-medium text-xs">Mint/Burn Flow</p>
                  <p className="text-xs text-muted-foreground">0.10</p>
                </div>
                <div className="rounded-lg border p-2 text-center">
                  <p className="text-foreground font-medium text-xs">Yield Anomaly</p>
                  <p className="text-xs text-muted-foreground">0.05</p>
                </div>
              </div>
              <div className="text-muted-foreground text-xl font-bold">&darr;</div>
              <div className="w-full rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium">DEWS</p>
                <p className="text-xs text-muted-foreground mt-0.5">&Sigma;(W&sdot;S) / &Sigma;(W) &mdash; 0–100</p>
              </div>
              <div className="text-muted-foreground text-xl font-bold">&darr;</div>
              <div className="grid grid-cols-5 gap-1 w-full">
                <div className="rounded-lg border p-1.5 text-center">
                  <p className="text-green-700 dark:text-green-400 font-medium text-xs">CALM</p>
                  <p className="text-xs text-muted-foreground">0–15</p>
                </div>
                <div className="rounded-lg border p-1.5 text-center">
                  <p className="text-teal-700 dark:text-teal-400 font-medium text-xs">WATCH</p>
                  <p className="text-xs text-muted-foreground">16–35</p>
                </div>
                <div className="rounded-lg border p-1.5 text-center">
                  <p className="text-yellow-700 dark:text-yellow-400 font-medium text-xs">ALERT</p>
                  <p className="text-xs text-muted-foreground">36–55</p>
                </div>
                <div className="rounded-lg border p-1.5 text-center">
                  <p className="text-orange-700 dark:text-orange-400 font-medium text-xs">WARN</p>
                  <p className="text-xs text-muted-foreground">56–75</p>
                </div>
                <div className="rounded-lg border p-1.5 text-center">
                  <p className="text-red-700 dark:text-red-400 font-medium text-xs">DANGER</p>
                  <p className="text-xs text-muted-foreground">76–100</p>
                </div>
              </div>
            </div>

            {/* Formula */}
            <div className="space-y-2">
              <h3 className="text-foreground font-medium">Score Formula</h3>
              <p className="font-mono text-xs border border-l-[3px] border-l-amber-500 border-border/60 bg-muted/50 rounded-lg px-4 py-3">
                DEWS = round(clamp(0, 100, sum(W_i &times; S_i) / sum(W_i)))
              </p>
              <p>
                At least 2 available signal sources (total weight &ge; 0.30) are required; otherwise DEWS returns null.
              </p>
            </div>

            {/* Sub-signals */}
            <div className="space-y-2">
              <h3 className="text-foreground font-medium">Sub-Signals &amp; Weights</h3>
              <ul className="list-disc list-inside space-y-1">
                <li>
                  <span className="text-foreground">Supply Velocity (0.25)</span> &mdash; rapid redemptions (bank run),
                  measured from 1-day and 7-day supply contraction rates
                </li>
                <li>
                  <span className="text-foreground">Pool Balance Drift (0.20)</span> &mdash; one-sided selling pressure
                  in DEX pools, blending balance stress, pool stress, and worst-pool imbalance
                </li>
                <li>
                  <span className="text-foreground">Liquidity Erosion (0.15)</span> &mdash; LPs fleeing, measured from
                  7-day changes in liquidity score and TVL
                </li>
                <li>
                  <span className="text-foreground">Price Confidence (0.15)</span> &mdash; N-source consensus failures
                  across CoinGecko, DefiLlama list, GeckoTerminal, Pyth, Binance, Coinbase, RedStone, Curve on-chain, and DEX prices;
                  maps confidence levels (high/single-source/low/fallback) to stress values
                </li>
                <li>
                  <span className="text-foreground">Cross-Source Divergence (0.15)</span> &mdash; fragmented pricing
                  between multi-source consensus price, DEX price, and peg reference
                </li>
                <li>
                  <span className="text-foreground">Blacklist Activity (0.10)</span> &mdash; issuer emergency freeze
                  surges for USDC, USDT, PAXG, XAUT
                </li>
                <li>
                  <span className="text-foreground">Mint/Burn Flow (0.10)</span> &mdash; redemption surge vs minting
                  from on-chain Transfer event data
                </li>
                <li>
                  <span className="text-foreground">Yield Anomaly (0.05)</span> &mdash; warning-signal accumulation from
                  yield spikes, divergence, TVL outflows, negative trends, and reward-heavy regimes
                </li>
              </ul>
            </div>

            {/* Threat bands */}
            <div className="space-y-2">
              <h3 className="text-foreground font-medium">Threat Bands</h3>
              <ul className="list-disc list-inside space-y-1">
                <li>
                  <span className="text-green-700 dark:text-green-400 font-medium">CALM (0&ndash;15)</span> &mdash; no
                  stress signals detected
                </li>
                <li>
                  <span className="text-teal-700 dark:text-teal-400 font-medium">WATCH (16&ndash;35)</span> &mdash; mild
                  stress on 1&ndash;2 indicators
                </li>
                <li>
                  <span className="text-yellow-700 dark:text-yellow-400 font-medium">ALERT (36&ndash;55)</span> &mdash;
                  multiple indicators elevated
                </li>
                <li>
                  <span className="text-orange-700 dark:text-orange-400 font-medium">WARNING (56&ndash;75)</span>{" "}
                  &mdash; strong stress signals, depeg plausible
                </li>
                <li>
                  <span className="text-red-700 dark:text-red-400 font-medium">DANGER (76&ndash;100)</span> &mdash; all
                  precursors firing
                </li>
              </ul>
            </div>

            {/* Edge cases */}
            <div className="space-y-2">
              <h3 className="text-foreground font-medium">Edge Cases</h3>
              <ul className="list-disc list-inside space-y-1">
                <li>NAV tokens are excluded entirely (price appreciates, not pegged)</li>
                <li>Non-USD pegs: cross-source divergence is dampened by 0.7 (noisier FX pricing)</li>
                <li>Small coins (&lt;$50M): supply velocity is dampened via a logarithmic size factor</li>
                <li>Missing DEX data: pool and liquidity signals marked unavailable, weight redistributed</li>
              </ul>
            </div>
          </MethodologyDetails>
        </CardContent>
      </Card>

      {/* Contagion Stress Test */}
      <Card
        id="contagion-stress-test-methodology"
        className="scroll-mt-36 rounded-xl border border-border/70 border-l-[3px] border-l-emerald-500 bg-card md:scroll-mt-28"
      >
        <CardHeader>
          <CardTitle as="h2">Contagion Stress Test</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6 text-sm text-muted-foreground leading-relaxed">
          <p>
            The stress test simulates dependency failures to reveal systemic concentration risk across the stablecoin
            ecosystem.
          </p>
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <p className="text-xs uppercase tracking-wide">Simulation action</p>
              <p className="text-foreground">Force one coin to grade D</p>
            </div>
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <p className="text-xs uppercase tracking-wide">Propagation channel</p>
              <p className="text-foreground">Dependency channel only</p>
            </div>
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
              <p className="text-xs uppercase tracking-wide">Primary output</p>
              <p className="text-foreground">Affected coins + supply at risk</p>
            </div>
          </div>
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Preconditions &amp; Failure Modes</h3>
            <MethodologyFacts
              facts={[
                { label: "Minimum data", value: "Target coin must have dependents and mapped dependency weights" },
                { label: "Required sources", value: "Current report-card scores plus dependency map inputs" },
                {
                  label: "Failure behavior",
                  value:
                    "Only direct dependency-risk channel is recomputed (no peg/liquidity/confidence feedback loops)",
                },
              ]}
            />
          </div>
          <WorkedExample summary="Worked example (verified against scoreDependencyRisk path used by stress test)">
            <p className="font-mono">
              Override upstream score to 40; dependent coin has 60% exposure and decentralized self-backed score 90
            </p>
            <p className="font-mono">blended=0.6*40+0.4*90=60; weak-upstream penalty (score&lt;75) applies -10</p>
            <p className="font-mono">dependencyRisk score=50</p>
            <p>
              Result:{" "}
              <span className="text-foreground">
                Dependency dimension falls to 50 before overall grade recomputation
              </span>
              .
            </p>
          </WorkedExample>

          <MethodologyDetails summary="Technical details: simulation pipeline, scoreboard logic, and limitations">
            {/* Stress test pipeline diagram — desktop: horizontal */}
            <div className="hidden md:grid grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] gap-4 items-start">
              <div className="rounded-lg border p-3 text-center self-center">
                <p className="text-foreground font-medium">Select Target</p>
                <p className="text-xs text-muted-foreground mt-0.5">pick a coin</p>
              </div>
              <div className="flex items-center self-center text-muted-foreground text-xl font-bold">&rarr;</div>
              <div className="rounded-lg border p-3 text-center self-center">
                <p className="text-foreground font-medium">Override to D</p>
                <p className="text-xs text-muted-foreground mt-0.5">force downgrade</p>
              </div>
              <div className="flex items-center self-center text-muted-foreground text-xl font-bold">&rarr;</div>
              <div className="rounded-lg border p-3 text-center self-center">
                <p className="text-foreground font-medium">Recompute Dep. Risk</p>
                <p className="text-xs text-muted-foreground mt-0.5">cascade upstream</p>
              </div>
              <div className="flex items-center self-center text-muted-foreground text-xl font-bold">&rarr;</div>
              <div className="rounded-lg border p-3 text-center self-center">
                <p className="text-foreground font-medium">Impact Report</p>
                <p className="text-xs text-muted-foreground mt-0.5">coins &amp; $ at risk</p>
              </div>
            </div>

            {/* Stress test pipeline diagram — mobile: vertical */}
            <div className="flex flex-col items-center gap-3 md:hidden">
              <div className="w-full rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium">Select Target</p>
                <p className="text-xs text-muted-foreground mt-0.5">pick a coin</p>
              </div>
              <div className="text-muted-foreground text-xl font-bold">&darr;</div>
              <div className="w-full rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium">Override to D</p>
                <p className="text-xs text-muted-foreground mt-0.5">force downgrade</p>
              </div>
              <div className="text-muted-foreground text-xl font-bold">&darr;</div>
              <div className="w-full rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium">Recompute Dep. Risk</p>
                <p className="text-xs text-muted-foreground mt-0.5">cascade upstream</p>
              </div>
              <div className="text-muted-foreground text-xl font-bold">&darr;</div>
              <div className="w-full rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium">Impact Report</p>
                <p className="text-xs text-muted-foreground mt-0.5">coins &amp; $ at risk</p>
              </div>
            </div>

            {/* Systemic Risk Scoreboard */}
            <div className="space-y-2">
              <h3 className="text-foreground font-medium">Systemic Risk Scoreboard</h3>
              <p>
                On page load, the scoreboard pre-computes the five most damaging single-coin failure scenarios. For each
                targetable coin (one that has dependents), it simulates a downgrade to D, counts the number of affected
                coins, and sums their market cap as &ldquo;supply at risk.&rdquo; Results are sorted by supply at risk
                descending.
              </p>
            </div>

            {/* Stress Test */}
            <div className="space-y-2">
              <h3 className="text-foreground font-medium">Stress Test</h3>
              <p>
                The interactive stress test overrides a target coin&apos;s overall score, then recomputes the Dependency
                Risk dimension for every coin that lists that target as an upstream dependency. This models the direct
                dependency channel only.
              </p>
              <p>
                In reality, a major stablecoin failure would also impact peg stability, liquidity, and market confidence
                simultaneously &mdash; the stress test captures only the mechanical dependency impact.
              </p>
            </div>

            {/* Limitations */}
            <div className="space-y-2">
              <h3 className="text-foreground font-medium">Limitations</h3>
              <ul className="list-disc list-inside space-y-1">
                <li>Collateral weights are researched estimates that may not reflect real-time ratios</li>
                <li>The stress test models only the dependency risk channel, not second-order market effects</li>
              </ul>
            </div>
          </MethodologyDetails>
        </CardContent>
      </Card>

      <Card
        id="blacklist-tracker-methodology"
        className="scroll-mt-36 rounded-xl border border-border/70 border-l-[3px] border-l-rose-500 bg-card md:scroll-mt-28"
      >
        <CardHeader className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle as="h2">Blacklist Tracker Methodology</CardTitle>
            <span className="inline-flex items-center rounded-md border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-xs font-mono font-semibold text-rose-700 dark:text-rose-400">
              {BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL}
            </span>
            <Link
              href={BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH}
              className="text-xs text-foreground underline underline-offset-4 hover:text-rose-700 dark:text-rose-400 transition-colors"
            >
              Version history &rarr;
            </Link>
          </div>
          <p className="text-xs text-muted-foreground">
            Version increments when tracked contracts, event parsing rules, cursor semantics, or amount-enrichment logic
            change.
          </p>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground leading-relaxed">
          <p>
            The Blacklist Tracker monitors issuer intervention events across USDC, USDT, PAXG, and XAUT contracts,
            including blacklist, unblacklist, and destroy/wipe actions across EVM and Tron networks.
          </p>
          <p>
            Methodology revisions document changes to event coverage, cross-chain decoding behavior, cursor safety
            policies, and amount attribution rules that affect historical interpretation and comparability over time.
          </p>
        </CardContent>
      </Card>

      {/* ─── Chain Health Score ─────────────────────────────── */}
      <Card
        id="chain-health-score"
        className="scroll-mt-36 rounded-xl border border-border/70 border-l-[3px] border-l-teal-500 bg-card md:scroll-mt-28"
      >
        <CardHeader className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle as="h2">Chain Health Score</CardTitle>
            <span className="inline-flex items-center rounded-md border border-teal-500/30 bg-teal-500/10 px-2 py-0.5 text-xs font-mono font-semibold text-teal-700 dark:text-teal-400">
              {CHAIN_HEALTH_METHODOLOGY_VERSION_LABEL}
            </span>
            <Link
              href={CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH}
              className="text-xs text-foreground underline underline-offset-4 hover:text-teal-700 dark:hover:text-teal-400 transition-colors"
            >
              Version history &rarr;
            </Link>
          </div>
          <p className="text-xs text-muted-foreground">
            Version increments when factor weights, tier assignments, or sub-factor formulas change.
          </p>
        </CardHeader>
        <CardContent className="space-y-6 text-sm text-muted-foreground leading-relaxed">
          <p>
            The Chain Health Score is a 0&ndash;100 composite that rates each blockchain&rsquo;s stablecoin ecosystem
            across five weighted factors. It answers: <em>how healthy, diverse, and resilient is the stablecoin mix on
            this chain?</em>
          </p>

          <MethodologyFacts
            facts={[
              { label: "Score range", value: "0–100 (null when safety-score coverage < 50%)" },
              { label: "Refresh cadence", value: "Every stablecoins cache refresh (~10 min)" },
              { label: "Dependencies", value: "DefiLlama supply, Pharos Safety Scores, peg rates" },
            ]}
          />

          <MethodologyDetails summary="Formula & Weights" defaultOpen primary>
            <p className="text-foreground font-medium">Composite formula</p>
            <pre className="overflow-x-auto rounded-lg bg-muted/50 px-4 py-3 text-xs font-mono">
{`healthScore =
  0.30 × quality
+ 0.20 × chainEnvironment
+ 0.20 × concentration
+ 0.20 × pegStability
+ 0.10 × backingDiversity`}
            </pre>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-4">Factor</th>
                    <th className="py-2 pr-4">Weight</th>
                    <th className="py-2">What it measures</th>
                  </tr>
                </thead>
                <tbody className="text-foreground">
                  <tr className="border-b border-border/40">
                    <td className="py-2 pr-4 font-medium">Quality</td>
                    <td className="py-2 pr-4">30%</td>
                    <td className="py-2">Supply-weighted average of Pharos Safety Scores for stablecoins on the chain. Unrated coins default to 40. Returns null if rated supply &lt; 50% of total.</td>
                  </tr>
                  <tr className="border-b border-border/40">
                    <td className="py-2 pr-4 font-medium">Chain Environment</td>
                    <td className="py-2 pr-4">20%</td>
                    <td className="py-2">
                      Rates the chain&rsquo;s own infrastructure quality, decentralization, and censorship resistance
                      via a resilience tier: <strong>Tier&nbsp;1</strong>&nbsp;(100) for battle-tested, highly
                      decentralized L1s; <strong>Tier&nbsp;2</strong>&nbsp;(60) for established chains with moderate
                      centralization; <strong>Tier&nbsp;3</strong>&nbsp;(20) for unproven or problematic chains.
                    </td>
                  </tr>
                  <tr className="border-b border-border/40">
                    <td className="py-2 pr-4 font-medium">Concentration</td>
                    <td className="py-2 pr-4">20%</td>
                    <td className="py-2">100&nbsp;&times;&nbsp;(1&nbsp;&minus;&nbsp;HHI) where HHI&nbsp;=&nbsp;&Sigma;(market share)&sup2;. A single stablecoin scores 0; perfectly even N coins score 100&times;(1&minus;1/N).</td>
                  </tr>
                  <tr className="border-b border-border/40">
                    <td className="py-2 pr-4 font-medium">Peg Stability</td>
                    <td className="py-2 pr-4">20%</td>
                    <td className="py-2">Supply-weighted average of per-coin peg proximity: 100&nbsp;&minus;&nbsp;deviationBps/5. Coins without a price get a neutral 50.</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 font-medium">Backing Diversity</td>
                    <td className="py-2 pr-4">10%</td>
                    <td className="py-2">Normalized Shannon entropy across three backing types (RWA-backed, crypto-backed, algorithmic). 0 for monoculture, 100 for a perfect three-way split.</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </MethodologyDetails>

          <MethodologyDetails summary="Chain Resilience Tiers">
            <p>
              The same stablecoin can have different security properties on different chains.
              A fully on-chain, censorship-resistant stablecoin on Ethereum mainnet may lose those guarantees
              on an L2 with a centralized sequencer. The chain environment factor captures this.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-4">Tier</th>
                    <th className="py-2 pr-4">Score</th>
                    <th className="py-2 pr-4">Criteria</th>
                    <th className="py-2">Examples</th>
                  </tr>
                </thead>
                <tbody className="text-foreground">
                  <tr className="border-b border-border/40">
                    <td className="py-2 pr-4 font-medium">Tier 1</td>
                    <td className="py-2 pr-4 font-mono">100</td>
                    <td className="py-2 pr-4">Highly decentralized, battle-tested, censorship-resistant L1</td>
                    <td className="py-2">Ethereum</td>
                  </tr>
                  <tr className="border-b border-border/40">
                    <td className="py-2 pr-4 font-medium">Tier 2</td>
                    <td className="py-2 pr-4 font-mono">60</td>
                    <td className="py-2 pr-4">Established chains with moderate centralization (default for unlisted chains)</td>
                    <td className="py-2">Solana, BSC, Arbitrum, Tron, Base, Polygon</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 font-medium">Tier 3</td>
                    <td className="py-2 pr-4 font-mono">20</td>
                    <td className="py-2 pr-4">Unproven, known centralization issues, or compromised security</td>
                    <td className="py-2">PulseChain, Harmony, BitTorrent</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </MethodologyDetails>

          <MethodologyDetails summary="Health Bands">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-4">Band</th>
                    <th className="py-2 pr-4">Score Range</th>
                    <th className="py-2">Interpretation</th>
                  </tr>
                </thead>
                <tbody className="text-foreground">
                  <tr className="border-b border-border/40"><td className="py-2 pr-4 font-medium text-emerald-600 dark:text-emerald-400">Robust</td><td className="py-2 pr-4 font-mono">80&ndash;100</td><td className="py-2">Strong, diversified stablecoin ecosystem on quality infrastructure</td></tr>
                  <tr className="border-b border-border/40"><td className="py-2 pr-4 font-medium text-sky-600 dark:text-sky-400">Healthy</td><td className="py-2 pr-4 font-mono">60&ndash;79</td><td className="py-2">Good ecosystem with room for improvement</td></tr>
                  <tr className="border-b border-border/40"><td className="py-2 pr-4 font-medium text-amber-600 dark:text-amber-400">Mixed</td><td className="py-2 pr-4 font-mono">40&ndash;59</td><td className="py-2">Moderate concerns &mdash; concentration, quality gaps, or chain risk</td></tr>
                  <tr className="border-b border-border/40"><td className="py-2 pr-4 font-medium text-orange-600 dark:text-orange-400">Fragile</td><td className="py-2 pr-4 font-mono">20&ndash;39</td><td className="py-2">Significant ecosystem weaknesses</td></tr>
                  <tr><td className="py-2 pr-4 font-medium text-red-600 dark:text-red-400">Concentrated</td><td className="py-2 pr-4 font-mono">0&ndash;19</td><td className="py-2">Minimal diversity or critically weak infrastructure</td></tr>
                </tbody>
              </table>
            </div>
          </MethodologyDetails>

          <WorkedExample summary="Worked example: Ethereum vs PulseChain">
            <p className="text-foreground font-medium">Ethereum (Tier 1)</p>
            <pre className="overflow-x-auto rounded-lg bg-muted/50 px-4 py-3 text-xs font-mono">
{`quality      = 72  (supply-weighted safety scores across ~190 coins)
environment  = 100 (tier 1 — gold standard for decentralization)
concentration= 66  (USDT ~48%, USDC ~33% → HHI ≈ 0.34)
pegStability = 98  (most coins very close to peg)
diversity    = 35  (overwhelmingly RWA-backed)

health = 0.30×72 + 0.20×100 + 0.20×66 + 0.20×98 + 0.10×35
       = 21.6 + 20 + 13.2 + 19.6 + 3.5 = 77.9 → 78 (healthy)`}
            </pre>
            <p className="text-foreground font-medium mt-4">PulseChain (Tier 3)</p>
            <pre className="overflow-x-auto rounded-lg bg-muted/50 px-4 py-3 text-xs font-mono">
{`quality      = 72  (DAI + unrated coins defaulting to 40)
environment  = 20  (tier 3 — unproven, centralized)
concentration= 67  (DAI ~39%, rest ~12% each)
pegStability = 98  (coins on peg)
diversity    = 61  (mixed backing types)

health = 0.30×72 + 0.20×20 + 0.20×67 + 0.20×98 + 0.10×61
       = 21.6 + 4 + 13.4 + 19.6 + 6.1 = 64.7 → 65 (healthy)

→ Chain environment alone creates a 16-point gap vs Ethereum.`}
            </pre>
          </WorkedExample>
        </CardContent>
      </Card>

    </>
  );
}
