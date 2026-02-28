import type { Metadata } from "next";
import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = {
  title: "Methodology: How Pharos Grades Stablecoins",
  description:
    "Full methodology behind Pharos safety grades, peg scores, liquidity scores, and contagion stress tests. Transparent scoring for every stablecoin.",
  alternates: {
    canonical: "/methodology/",
  },
  openGraph: {
    title: "Methodology: How Pharos Grades Stablecoins",
    description:
      "Full methodology behind Pharos safety grades, peg scores, liquidity scores, and contagion stress tests. Transparent scoring for every stablecoin.",
    url: "/methodology/",
  },
};

export default function MethodologyPage() {
  return (
    <div className="space-y-8">
      <BreadcrumbJsonLd name="Methodology" path="/methodology/" />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "FAQPage",
            mainEntity: [
              {
                "@type": "Question",
                name: "How does Pharos grade stablecoins?",
                acceptedAnswer: {
                  "@type": "Answer",
                  text: "Pharos computes a weighted average of four base dimensions — Liquidity (30%), Resilience (20%), Decentralization (10%), and Dependency Risk (30%) — then applies a peg stability power-curve multiplier. When some dimensions lack data, their weight is redistributed proportionally. Grades range from A+ (92–100) to F (0–44), with NR for insufficient data.",
                },
              },
              {
                "@type": "Question",
                name: "How is the Pharos peg score calculated?",
                acceptedAnswer: {
                  "@type": "Answer",
                  text: "The peg score is a composite 0–100 measure combining time-at-peg (50%) and event severity (50%), minus penalties for active depegs and erratic behavior. It requires at least 30 days of tracking data over a 4-year window.",
                },
              },
              {
                "@type": "Question",
                name: "How does Pharos measure DEX liquidity?",
                acceptedAnswer: {
                  "@type": "Answer",
                  text: "The liquidity score is a composite 0–100 metric combining TVL depth (30%), volume activity (20%), pool quality (20%), durability (15%), pair diversity (7.5%), and cross-chain presence (7.5%). Pool quality is adjusted for mechanism type, balance health, and pair quality.",
                },
              },
            ],
          }),
        }}
      />

      {/* Breadcrumb + heading */}
      <div className="space-y-2">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link href="/" className="hover:text-foreground transition-colors">Dashboard</Link>
          <span>/</span>
          <span className="text-foreground">Methodology</span>
        </nav>
        <h1 className="text-4xl font-extrabold tracking-tighter">Methodology</h1>
        <p className="text-sm text-muted-foreground">
          How Pharos grades stablecoins — transparent scoring across safety, peg stability, liquidity, and contagion risk.
        </p>
      </div>

      {/* Grading Methodology */}
      <Card className="rounded-xl border-l-[3px] border-l-amber-500">
        <CardHeader>
          <CardTitle as="h2">Grading Methodology</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6 text-sm text-muted-foreground leading-relaxed">
          <p>
            Pharos synthesizes multiple data signals into a single transparent grade per stablecoin.
            The overall score is computed in two steps: first, a weighted average of four base dimensions
            (liquidity, resilience, decentralization, dependency risk), then a peg stability multiplier
            that penalizes coins with poor pegs while barely affecting well-pegged ones.
            When some base dimensions lack data (NR), their weight is redistributed proportionally among rated ones.
          </p>

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
                  <tr>
                    <td className="py-2 pr-4 text-foreground">Liquidity</td>
                    <td className="py-2 pr-4">30%</td>
                    <td className="py-2 pr-4">DEX liquidity score</td>
                    <td className="py-2">Direct passthrough of the liquidity score (see below)</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 text-foreground">Resilience</td>
                    <td className="py-2 pr-4">20%</td>
                    <td className="py-2 pr-4">Chain risk, collateral, custody, blacklist</td>
                    <td className="py-2">Structural resilience across 4 equally-weighted sub-factors</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 text-foreground">Decentralization</td>
                    <td className="py-2 pr-4">10%</td>
                    <td className="py-2 pr-4">Governance type, chain risk</td>
                    <td className="py-2">Governance structure with chain-risk penalty</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 text-foreground">Dependency Risk</td>
                    <td className="py-2 pr-4">30%</td>
                    <td className="py-2 pr-4">Upstream grades, collateral weights</td>
                    <td className="py-2">Inherited risk from upstream stablecoins, weighted by exposure</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* Peg multiplier */}
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Peg Stability Multiplier</h3>
            <p>
              After computing the base score, peg stability is applied as a power-curve multiplier:
              final&nbsp;=&nbsp;base&nbsp;&times;&nbsp;(PSI&nbsp;/&nbsp;100)<sup>0.20</sup>.
              Coins with strong pegs (90+) are barely affected (~2% penalty), while coins with broken pegs
              are properly penalized (e.g. PSI&nbsp;10 &rarr; 37% penalty). NAV tokens (PSI&nbsp;=&nbsp;NR) receive
              multiplier&nbsp;1.0 since peg tracking does not apply to them.
            </p>
          </div>

          {/* Resilience sub-factors */}
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Resilience Scoring</h3>
            <p>Average of four equally-weighted sub-factors (25% each):</p>
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
                  <tr>
                    <td className="py-2 pr-4 text-foreground">Chain Risk</td>
                    <td className="py-2 pr-4">Where does the core protocol operate?</td>
                    <td className="py-2">Ethereum&nbsp;(100), Stage&nbsp;1+&nbsp;L2&nbsp;(66), Established&nbsp;alt&#8209;L1&nbsp;(20), Unproven&nbsp;(0)</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 text-foreground">Collateral Quality</td>
                    <td className="py-2 pr-4">Reserve composition risk</td>
                    <td className="py-2">Weighted avg of curated reserve slices: Very&nbsp;Low&nbsp;(100), Low&nbsp;(75), Medium&nbsp;(50), High&nbsp;(25), Very&nbsp;High&nbsp;(5). Falls back to enum scoring for coins without curated reserves.</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 text-foreground">Custody Model</td>
                    <td className="py-2 pr-4">Who holds the collateral?</td>
                    <td className="py-2">Fully&nbsp;on&#8209;chain&nbsp;(100), Institutional&nbsp;custodian&nbsp;(50), CEX/off&#8209;exchange&nbsp;(0)</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 text-foreground">Blacklist Capability</td>
                    <td className="py-2 pr-4">Can the issuer freeze holder funds?</td>
                    <td className="py-2">No&nbsp;(100), Possible&nbsp;(mutable&nbsp;contract)&nbsp;(66), Yes&nbsp;(33)</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p>
              Collateral quality is derived from curated reserve compositions when available &mdash; each reserve slice is classified into one of five risk tiers and the score is their weighted average.
              For coins without curated reserves, a coarser enum-based fallback is used. Explicit overrides exist for coins where defaults are incorrect (e.g., protocols on Solana, coins with CEX custody).
            </p>
          </div>

          {/* Decentralization scoring */}
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Decentralization Scoring</h3>
            <p>Base score from governance quality tier, then a chain-risk penalty for protocols on less decentralized chains &mdash; governance decentralization is undermined when the underlying chain has centralisation concerns:</p>
            <ul className="list-disc list-inside space-y-1">
              <li><span className="text-foreground">DAO governance</span> &mdash; 85 (e.g.&nbsp;DAI, LUSD)</li>
              <li><span className="text-foreground">Multisig</span> &mdash; 55 (e.g.&nbsp;GHO, FRAX)</li>
              <li><span className="text-foreground">Regulated entity</span> &mdash; 40 (named regulator, license, and independent audit &mdash; e.g.&nbsp;USDC, USDT)</li>
              <li><span className="text-foreground">Single entity</span> &mdash; 20 (unregulated or unverified issuer)</li>
              <li><span className="text-foreground">Wrapper</span> &mdash; 10 (inherits upstream governance)</li>
            </ul>
            <p className="font-medium text-foreground mt-2">Chain-risk penalty (DAO and multisig governance only):</p>
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
              Two-phase computation ensures upstream scores are available before dependent coins are graded.
              Phase 1 grades independent coins (centralized &amp; decentralized), then Phase 2 grades CeFi-Dependent coins using Phase 1 results.
            </p>
            <ul className="list-disc list-inside space-y-1">
              <li><span className="text-foreground">Non-dependent coins</span> &mdash; score 95 (no upstream risk)</li>
              <li>
                <span className="text-foreground">CeFi-Dependent with mapped dependencies</span> &mdash; blended score:
                each upstream&apos;s grade is weighted by its collateral fraction, and the self-backed portion (non-stablecoin collateral) scores 75.
                A &minus;10 penalty applies if any upstream dependency scores below 75
              </li>
              <li><span className="text-foreground">CeFi-Dependent, unmapped</span> &mdash; falls back to 70 when dependencies aren&apos;t mapped or scores are unavailable</li>
            </ul>
            <p className="mt-2">
              <span className="text-foreground font-medium">Dependency type ceilings</span> &mdash; each dependency is classified as <em>wrapper</em>, <em>mechanism-critical</em>, or <em>collateral</em> (default).
              Wrappers (e.g., syrupUSDC &rarr; USDC) are thin layers around the upstream &mdash; their score is capped at <code className="text-xs">upstream &minus; 3</code>.
              Mechanism-critical dependencies (e.g., DAI &rarr; USDC via PSM) are essential to the peg &mdash; score is capped at the upstream&apos;s score.
              Collateral dependencies use the blended formula with no ceiling.
            </p>
            <p className="text-xs">
              The self-backed portion scores 75 (not 95) because CeFi-Dependent coins still carry systemic coupling risk &mdash; their peg mechanisms depend on upstream stablecoin infrastructure even for non-stablecoin collateral.
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
                  <tr><td className="py-1.5 pr-8 text-foreground">A+</td><td className="py-1.5">92&ndash;100</td></tr>
                  <tr><td className="py-1.5 pr-8 text-foreground">A</td><td className="py-1.5">88&ndash;91</td></tr>
                  <tr><td className="py-1.5 pr-8 text-foreground">A&minus;</td><td className="py-1.5">85&ndash;87</td></tr>
                  <tr><td className="py-1.5 pr-8 text-foreground">B+</td><td className="py-1.5">80&ndash;84</td></tr>
                  <tr><td className="py-1.5 pr-8 text-foreground">B</td><td className="py-1.5">75&ndash;79</td></tr>
                  <tr><td className="py-1.5 pr-8 text-foreground">B&minus;</td><td className="py-1.5">70&ndash;74</td></tr>
                  <tr><td className="py-1.5 pr-8 text-foreground">C+</td><td className="py-1.5">65&ndash;69</td></tr>
                  <tr><td className="py-1.5 pr-8 text-foreground">C</td><td className="py-1.5">60&ndash;64</td></tr>
                  <tr><td className="py-1.5 pr-8 text-foreground">C&minus;</td><td className="py-1.5">55&ndash;59</td></tr>
                  <tr><td className="py-1.5 pr-8 text-foreground">D</td><td className="py-1.5">45&ndash;54</td></tr>
                  <tr><td className="py-1.5 pr-8 text-foreground">F</td><td className="py-1.5">0&ndash;44</td></tr>
                  <tr><td className="py-1.5 pr-8 text-foreground">NR</td><td className="py-1.5">Not enough data</td></tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* Key design decisions */}
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Key Design Decisions</h3>
            <ul className="list-disc list-inside space-y-1">
              <li><span className="text-foreground font-medium">NR (Not Rated)</span> is used when fewer than 2 base dimensions have data &mdash; no misleading partial grades</li>
              <li>Weight is redistributed proportionally among rated base dimensions when some are NR</li>
              <li>Peg stability acts as a multiplier, not a base dimension &mdash; maintaining a peg is table stakes, not a differentiator</li>
              <li>Cemetery (defunct) coins receive a permanent F</li>
              <li>Decentralization score is structural, not a value judgment</li>
            </ul>
          </div>

          {/* Limitations */}
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Limitations</h3>
            <ul className="list-disc list-inside space-y-1">
              <li>Peg stability only reflects price data &mdash; can&apos;t detect coins &ldquo;stable&rdquo; because nobody trades them</li>
              <li>Decentralization is structural, not a value judgment</li>
              <li>Dependency map is manually maintained &mdash; may not capture every collateral relationship</li>
            </ul>
          </div>

          {/* Versioning */}
          <p className="text-xs text-muted-foreground italic">
            Methodology version v5.1. Version increments when weights, thresholds, or dimension definitions change.
          </p>
        </CardContent>
      </Card>

      {/* Peg Score */}
      <Card className="rounded-xl border-l-[3px] border-l-emerald-500">
        <CardHeader>
          <CardTitle as="h2">Peg Score</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6 text-sm text-muted-foreground leading-relaxed">
          <p>
            Composite 0&ndash;100 score measuring how faithfully a stablecoin holds its peg, computed over a 4-year tracking window.
            Requires at least 30 days of tracking data; returns null otherwise.
          </p>

          {/* Formula */}
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Formula</h3>
            <p className="font-mono text-xs bg-muted rounded px-3 py-2">
              pegScore = 0.5 &times; pegPct + 0.5 &times; severityScore &minus; activeDepegPenalty &minus; spreadPenalty
            </p>
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
                    <th className="py-2 pr-4 font-medium text-foreground">Range</th>
                    <th className="py-2 font-medium text-foreground">How it works</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  <tr>
                    <td className="py-2 pr-4 text-foreground">Time-at-Peg (pegPct)</td>
                    <td className="py-2 pr-4">50%</td>
                    <td className="py-2 pr-4">0&ndash;100</td>
                    <td className="py-2">Percentage of time spent at peg. Overlapping depeg intervals are merged to avoid double-counting</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 text-foreground">Event Severity</td>
                    <td className="py-2 pr-4">50%</td>
                    <td className="py-2 pr-4">0&ndash;100</td>
                    <td className="py-2">
                      Penalizes magnitude, duration, and recency of each depeg event.
                      Per-event penalty: (peakBps&nbsp;/&nbsp;100) &times; (durationDays&nbsp;/&nbsp;30) &times; recencyWeight.
                      Recency weight = 1&nbsp;/&nbsp;(1&nbsp;+&nbsp;yearsAgo) so recent events count more. Duration capped at 90 days
                    </td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 text-foreground">Active Depeg Penalty</td>
                    <td className="py-2 pr-4">subtracted</td>
                    <td className="py-2 pr-4">2&ndash;50</td>
                    <td className="py-2">Applied only if an ongoing depeg exists (no end date). Scales with severity: clamp(absBps&nbsp;/&nbsp;200, 2, 50)</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 text-foreground">Spread Penalty</td>
                    <td className="py-2 pr-4">subtracted</td>
                    <td className="py-2 pr-4">0&ndash;15</td>
                    <td className="py-2">Standard deviation of peak deviations across events, scaled. Penalizes erratic, unpredictable depeg behaviour. Only applies when &ge;2 events exist</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Liquidity Score */}
      <Card className="rounded-xl border-l-[3px] border-l-cyan-500">
        <CardHeader>
          <CardTitle as="h2">Liquidity Score</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6 text-sm text-muted-foreground leading-relaxed">
          <p>
            Composite 0&ndash;100 score measuring DEX liquidity depth per stablecoin, updated every 20 minutes.
            Aggregates pool data across all major DEXes and chains.
          </p>

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
                  <tr>
                    <td className="py-2 pr-4 text-foreground">TVL Depth</td>
                    <td className="py-2 pr-4">30%</td>
                    <td className="py-2">Log-scale effective TVL (quality-adjusted, metapool-deduped): $100K&rarr;20, $1M&rarr;40, $10M&rarr;60, $100M&rarr;80, $1B+&rarr;100</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 text-foreground">Volume Activity</td>
                    <td className="py-2 pr-4">20%</td>
                    <td className="py-2">Volume/TVL ratio. 0&rarr;0, 0.5+&rarr;100</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 text-foreground">Pool Quality</td>
                    <td className="py-2 pr-4">20%</td>
                    <td className="py-2">Quality-adjusted TVL using pool mechanism multiplier &times; balance health &times; pair quality. Curve StableSwap (A&ge;500) = 1.0&times;, Uni V3 1bp = 1.1&times;, generic AMM = 0.3&times;</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 text-foreground">Durability</td>
                    <td className="py-2 pr-4">15%</td>
                    <td className="py-2">Organic fee fraction (35%), TVL stability (25%), volume consistency (20%), pool maturity (15%), locked liquidity (5%)</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 text-foreground">Pair Diversity</td>
                    <td className="py-2 pr-4">7.5%</td>
                    <td className="py-2">Pool count with diminishing returns: min(100, poolCount &times; 5)</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4 text-foreground">Cross-chain</td>
                    <td className="py-2 pr-4">7.5%</td>
                    <td className="py-2">Number of chains with liquidity: 1&rarr;15, 2&rarr;40, 3&rarr;60, 5&rarr;80, 8+&rarr;100</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* Quality multipliers */}
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Pool Quality Adjustments</h3>
            <ul className="list-disc list-inside space-y-1">
              <li><span className="text-foreground">Balance health</span> &mdash; continuous ratio (not binary threshold): pools with imbalanced reserves score lower</li>
              <li><span className="text-foreground">Pair quality</span> &mdash; co-token scored by Pharos governance classification (CeFi&rarr;1.0, DeFi&rarr;0.9, CeFi-Dep&rarr;0.8) plus static map for volatile assets (WETH&rarr;0.65, WBTC&rarr;0.6)</li>
              <li><span className="text-foreground">Metapool dedup</span> &mdash; uses TVL excluding base pool to prevent double-counting across Curve metapools</li>
            </ul>
          </div>
        </CardContent>
      </Card>

      {/* Contagion Stress Test */}
      <Card className="rounded-xl border-l-[3px] border-l-emerald-500">
        <CardHeader>
          <CardTitle as="h2">Contagion Stress Test</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6 text-sm text-muted-foreground leading-relaxed">
          <p>
            The stress test simulates dependency failures to reveal systemic concentration risk
            across the stablecoin ecosystem.
          </p>

          {/* Systemic Risk Scoreboard */}
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Systemic Risk Scoreboard</h3>
            <p>
              On page load, the scoreboard pre-computes the five most damaging single-coin failure
              scenarios. For each targetable coin (one that has dependents), it simulates a downgrade
              to D, counts the number of affected coins, and sums their market cap as &ldquo;supply at
              risk.&rdquo; Results are sorted by supply at risk descending.
            </p>
          </div>

          {/* Stress Test */}
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Stress Test</h3>
            <p>
              The interactive stress test overrides a target coin&apos;s overall score, then recomputes
              the Dependency Risk dimension for every coin that lists that target as an upstream
              dependency. This models the direct dependency channel only.
            </p>
            <p>
              In reality, a major stablecoin failure would also impact peg stability, liquidity,
              and market confidence simultaneously &mdash; the stress test captures only the
              mechanical dependency impact.
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
        </CardContent>
      </Card>
    </div>
  );
}
