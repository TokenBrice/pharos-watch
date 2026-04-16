import {
  YIELD_METHODOLOGY_CHANGELOG_PATH,
  YIELD_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/yield-methodology-version";
import {
  MethodologyDetails,
  MethodologyDiagramArrow,
  MethodologyDiagramCard,
  MethodologyFacts,
  MethodologySectionShell,
  WorkedExample,
} from "../../methodology-shared";

export function YieldIntelligenceMethodologySection() {
  return (
          <MethodologySectionShell
            id="yield-intelligence-methodology"
            title="Yield Intelligence"
            versionLabel={YIELD_METHODOLOGY_VERSION_LABEL}
            changelogPath={YIELD_METHODOLOGY_CHANGELOG_PATH}
            versionNote="Version increments when APY source resolution, source arbitration, history semantics, PYS scoring logic, or eligibility rules for discovered yield sources change."
            accentClassName="border-l-violet-500"
            badgeClassName="border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-400"
            changelogClassName="hover:text-violet-700 dark:text-violet-400"
          >
              <p>
                Pharos tracks yield-bearing stablecoins and computes a risk-adjusted ranking via the Pharos Yield Score (PYS). Core rankings publish hourly using a source-aware APY resolution strategy, while slower
                supplemental-source families refresh on a separate four-hour lane. Alternative sources are retained when
                multiple valid yield paths exist, address-first identity is used before symbol fallback, curated
                exact-pool overrides can cover named non-stablecoin venues, confidence-weighted arbitration selects
                the primary row, and published lending suggestions exclude Resolv / USR-linked venues so broken wrapper
                ecosystems do not surface as recommended base-asset routes. Published lending-opportunity rows now also
                require observable venue TVL and a size floor of at least 0.1% of the tracked stablecoin&apos;s current
                supply before they can become the live recommendation. PYS is benchmark-aware, and Curve Savings crvUSD now follows the active on-chain profit-unlock stream instead of a trailing exchange-rate delta; pre-launch assets remain manifest-visible as intentional gaps but cannot publish into the live leaderboard before launch.
              </p>
              <p className="text-xs text-muted-foreground">
                See also:{" "}
                <a href="#safety-scores-methodology" className="text-foreground/70 underline underline-offset-2 hover:text-foreground transition-colors">Safety Scores</a>
                {" · "}
                <a href="#liquidity-methodology" className="text-foreground/70 underline underline-offset-2 hover:text-foreground transition-colors">Liquidity Score</a>
              </p>
              <MethodologyFacts
                facts={[
                  { label: "Update cadence", value: "1h publish / 4h supplemental" },
                  { label: "APY priority", value: "Confidence-weighted across deterministic, curated, and fallback sources" },
                  { label: "Output", value: "PYS (0-100)" },
                ]}
              />
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
                        "Direct on-chain reads, curated DeFiLlama pools, curated protocol-native APIs, rate-derived benchmark inputs, or 7-45d price history",
                    },
                    {
                      label: "Failure behavior",
                      value:
                        "No resolved source skips coin update; PYS returns 0 when apy30d <= 0 or the benchmark-adjusted effective yield is non-positive (safety defaults to 40 / NR if live report-card hydration is missing), while degraded benchmark or safety inputs are surfaced in provenance",
                    },
                  ]}
                />
              </div>
              <WorkedExample summary="Worked example (verified against computePYS)">
                <p className="font-mono">Inputs: apy30d=8.4, benchmarkRate=4.25, safetyScore=72, apyVarianceScore=0.18, scalingFactor=8</p>
                <p className="font-mono">
                  benchmarkSpread=8.4-4.25=4.15; effectiveYield=max(0,8.4+0.25*4.15)=9.44; riskPenalty=max(0.5,(101-72)/20)=1.45;
                  adjustedPenalty=1.45^1.75=1.92; yieldEfficiency=9.44/1.92=4.92; sustainability=1-0.18=0.82
                </p>
                <p className="font-mono">PYS=min(100, round(4.92*0.82*8))=32</p>
                <p>
                  Result: <span className="text-foreground">PYS 32</span>.
                </p>
              </WorkedExample>
              <MethodologyDetails summary="Technical details: APY source resolution, confidence arbitration, PYS formula, NAV handling, and limits">
                {/* Yield pipeline diagram — desktop: horizontal */}
                <div className="hidden md:flex items-stretch gap-4">
                  {/* Three tiers */}
                  <div className="flex flex-col gap-2 flex-1">
                    <MethodologyDiagramCard className="flex-1" title="Tier 1" subtitle="Direct on-chain reads" />
                    <MethodologyDiagramCard className="flex-1" title="Tier 2" subtitle="Curated pools + protocol APIs" />
                    <MethodologyDiagramCard className="flex-1" title="Tier 3 / 4" subtitle="Price- or rate-derived fallback" />
                  </div>
                  <MethodologyDiagramArrow direction="right" />
                  {/* APY */}
                  <MethodologyDiagramCard className="w-32 flex flex-shrink-0 flex-col justify-center" title="Effective Yield" subtitle="APY + 25% benchmark spread" />
                  <MethodologyDiagramArrow direction="right" />
                  {/* Formula components */}
                  <div className="flex flex-col gap-2 flex-1">
                    <MethodologyDiagramCard className="flex-1" title="Yield Efficiency" subtitle="Effective yield ÷ curved risk penalty" />
                    <MethodologyDiagramCard className="flex-1" title="Sustainability" subtitle="penalises high variance" />
                  </div>
                  <MethodologyDiagramArrow direction="right" />
                  {/* PYS */}
                  <MethodologyDiagramCard className="w-32 flex flex-shrink-0 flex-col justify-center" title="PYS Score" subtitle="0–100" />
                </div>
                {/* Yield pipeline diagram — mobile: vertical */}
                <div className="flex flex-col items-center gap-3 md:hidden">
                  <div className="grid grid-cols-3 gap-2 w-full">
                    <MethodologyDiagramCard title="Tier 1" titleClassName="text-xs text-foreground font-medium" subtitle="On-chain reads" subtitleClassName="text-xs text-muted-foreground" />
                    <MethodologyDiagramCard title="Tier 2" titleClassName="text-xs text-foreground font-medium" subtitle="Curated venues" subtitleClassName="text-xs text-muted-foreground" />
                    <MethodologyDiagramCard title="Tier 3 / 4" titleClassName="text-xs text-foreground font-medium" subtitle="Fallbacks" subtitleClassName="text-xs text-muted-foreground" />
                  </div>
                  <MethodologyDiagramArrow />
                  <MethodologyDiagramCard className="w-full" title="Effective Yield" subtitle="APY + 25% benchmark spread" />
                  <MethodologyDiagramArrow />
                  <div className="grid grid-cols-2 gap-2 w-full">
                    <MethodologyDiagramCard title="Yield Efficiency" titleClassName="text-xs text-foreground font-medium" subtitle="Effective yield ÷ curved risk penalty" subtitleClassName="text-xs text-muted-foreground" />
                    <MethodologyDiagramCard title="Sustainability" titleClassName="text-xs text-foreground font-medium" subtitle="penalises variance" subtitleClassName="text-xs text-muted-foreground" />
                  </div>
                  <MethodologyDiagramArrow />
                  <MethodologyDiagramCard className="w-full" title="PYS Score" subtitle="0–100" />
                </div>
                {/* APY Resolution tiers */}
                <div className="space-y-2">
                  <h3 className="text-foreground font-medium">APY Resolution and Source Arbitration</h3>
                  <ul className="list-disc list-inside space-y-1">
                    <li>
                      <span className="text-foreground">Tier 1 &mdash; Direct on-chain reads</span>: reads protocol state
                      directly, either as an exchange-rate delta (e.g.&nbsp;sUSDe), a conservative reward-only estimator
                      (e.g.&nbsp;LUSD B.Protocol Stability Pool, LQTY only), or scrvUSD&apos;s Yearn V3 profit-unlock current-rate reader
                    </li>
                    <li>
                      <span className="text-foreground">Tier 2 &mdash; DeFiLlama pools</span>: matches the coin to a
                      DeFiLlama yield pool via static mapping, chain-scoped wrapper rules, and address-first fallback
                      matching, while explicitly preserving wrapper pools that upstream marks as non-stablecoin when they
                      are configured as relevant yield sources and allowing exact-pool curated overrides for assets such as
                      XAUT. Wrapper-over-native venues such as BOLD/yBOLD stay classified as native yield rather than
                      governance-set when the wrapper is just packaging the protocol&apos;s own Stability Pool return
                    </li>
                    <li>
                      <span className="text-foreground">Tier 2.5 &mdash; Protocol-native venues</span>: ingests curated
                      protocol-owned APIs and protocol-specific on-chain venue readers when the canonical savings path is
                      not representable as a reliable DeFiLlama pool; these rows stay in the curated tier rather than
                      inheriting Tier 1 deterministic precedence reserved for native wrapper readers
                    </li>
                    <li>
                      <span className="text-foreground">Tier 3 &mdash; Price-derived</span>: for NAV tokens only, derives
                      APY from 7-45 day price appreciation in `supply_history`
                    </li>
                    <li>
                      <span className="text-foreground">Tier 4 &mdash; Rate-derived</span>: for dividend-distributing and
                      Treasury-tracking tokens, derives APY from the selected benchmark registry entry net of known fee
                      spreads, using USD by default, 3-month compounded €STR for EUR pegs, and 3-month compounded SARON
                      for Swiss-franc pegs
                    </li>
                  </ul>
                  <p>
                    Deterministic and curated paths can all contribute rows, then a confidence-weighted arbitration layer
                    chooses the best row. Divergent discovered or fallback sources can be demoted or rejected when a
                    canonical source disagrees materially. Protocol-native supplemental lending venues such as Aave V3 do
                    not outrank stronger native wrapper yields purely because they query protocol state directly, and
                    Resolv / USR-linked lending-opportunity venues are excluded from publication entirely. Published
                    lending-opportunity rows also need observable venue TVL and must clear the higher of the absolute
                    TVL floor or 0.1% of the tracked stablecoin&apos;s current supply, and explicit lending overrides only
                    publish for active assets.
                  </p>
                  <p>
                    Yield-bearing coverage is now explicitly inventoried per asset. If no reliable runtime source exists,
                    the asset is marked as an intentional gap rather than silently disappearing from audit coverage.
                  </p>
                  <p>
                    Deterministic rows keep their own source identity (`onchain:&lt;stablecoinId&gt;`) rather than sharing
                    a pool UUID with curated sources, so source-aware history and previous-rate lookups stay isolated when
                    both paths coexist.
                  </p>
                  <p>
                    Trailing APY metrics are computed from source-specific history rather than a mixed coin-level series, so
                    source switches no longer contaminate the displayed 7d/30d averages.
                  </p>
                  <p>
                    Read-time <code className="text-xs bg-muted px-1 py-0.5 rounded">data-stale</code> warnings are also
                    cadence-aware: hourly families attach only after three missed <code className="text-xs bg-muted px-1 py-0.5 rounded">sync-yield-data</code>{" "}
                    intervals (about 3 hours at the current publisher), while <code className="text-xs bg-muted px-1 py-0.5 rounded">price-derived</code>{" "}
                    rows wait 36 hours because they are backed by daily <code className="text-xs bg-muted px-1 py-0.5 rounded">supply_history</code>{" "}
                    snapshots rather than hourly source observations.
                  </p>
                </div>
                {/* PYS formula */}
                <div className="space-y-2">
                  <h3 className="text-foreground font-medium">Pharos Yield Score (PYS)</h3>
                  <p className="font-mono text-xs border border-l-[3px] border-l-amber-500 border-border/60 bg-muted/50 rounded-lg px-4 py-3">
                    benchmarkSpread = apy30d &minus; benchmarkRate
                    <br />
                    effectiveYield = max(0, apy30d + benchmarkSpread &times; 0.25)
                    <br />
                    riskPenalty = max(0.5, (101 &minus; safetyScore) / 20)
                    <br />
                    yieldEfficiency = effectiveYield / (riskPenalty ^ 1.75)
                    <br />
                    sustainability = max(0.3, 1.0 &minus; apyVarianceScore)
                    <br />
                    PYS = min(100, yieldEfficiency &times; sustainability &times; scalingFactor)
                  </p>
                  <ul className="list-disc list-inside space-y-1">
                    <li>
                      <span className="text-foreground">Effective yield</span> keeps raw APY as the anchor, then adds 25%
                      of the row&apos;s benchmark spread so tighter local-currency cash hurdles can lift the score without
                      turning PYS into a pure excess-yield ranker
                    </li>
                    <li>
                      <span className="text-foreground">Yield efficiency</span> rewards higher APY relative to the
                      coin&apos;s risk profile &mdash; the raw safety penalty is raised to a fixed power so weaker safety
                      grades need much more effective yield to compete
                    </li>
                    <li>
                      <span className="text-foreground">Sustainability multiplier</span> penalizes volatile yields (high
                      variance over 30 days), favouring consistent returns
                    </li>
                    <li>
                      <span className="text-foreground">Scaling factor</span> is a global constant that normalises scores
                      into a readable 0&ndash;100 range after the steeper safety curve is applied
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
                      until 7 days of data accumulate
                    </li>
                    <li>
                      Some DeFiLlama and protocol-native surfaces still depend on upstream asset metadata completeness; the
                      resolver now drops ambiguous candidates rather than guessing across duplicate symbols
                    </li>
                    <li>
                      The LUSD B.Protocol Stability Pool row is conservative by design: it includes projected LQTY
                      incentives only and excludes ETH liquidation gains
                    </li>
                    <li>Price-derived APY (Tier 3) can be noisy for low-liquidity NAV tokens</li>
                  </ul>
                </div>
              </MethodologyDetails>
          </MethodologySectionShell>
  );
}
