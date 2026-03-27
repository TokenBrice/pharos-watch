import {
  BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH,
  BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/blacklist-tracker-version";
import {
  DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
  DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/depeg-dews-version";
import {
  YIELD_METHODOLOGY_CHANGELOG_PATH,
  YIELD_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/yield-methodology-version";
import {
  CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH,
  CHAIN_HEALTH_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/chain-health-version";
import { MethodologyDetails, MethodologyFacts, MethodologySectionShell, WorkedExample } from "../methodology-shared";

export function MonitoringMethodologySections() {
  return (
    <>
      {/* Yield Intelligence */}
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
            Pharos tracks yield-bearing stablecoins and computes a risk-adjusted ranking via the Pharos Yield Score
            (PYS). Core rankings publish hourly using a source-aware APY resolution strategy, while slower
            supplemental-source families refresh on a separate four-hour lane. Alternative sources are retained when
            multiple valid yield paths exist, address-first identity is used before symbol fallback, curated
            exact-pool overrides can cover named non-stablecoin venues, and confidence-weighted arbitration selects
            the primary row. PYS is now benchmark-aware: it keeps raw APY as the base term, adds a modest slice of
            row-level benchmark spread, and only then applies the safety and consistency penalties.
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
                <div className="rounded-lg border p-3 text-center flex-1">
                  <p className="text-foreground font-medium">Tier 1</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Direct on-chain reads</p>
                </div>
                <div className="rounded-lg border p-3 text-center flex-1">
                  <p className="text-foreground font-medium">Tier 2</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Curated pools + protocol APIs</p>
                </div>
                <div className="rounded-lg border p-3 text-center flex-1">
                  <p className="text-foreground font-medium">Tier 3 / 4</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Price- or rate-derived fallback</p>
                </div>
              </div>
              <div className="flex items-center text-muted-foreground text-xl font-bold">&rarr;</div>
              {/* APY */}
              <div className="rounded-lg border p-3 text-center w-32 flex flex-col justify-center flex-shrink-0">
                <p className="text-foreground font-medium">Effective Yield</p>
                <p className="text-xs text-muted-foreground mt-0.5">APY + 25% benchmark spread</p>
              </div>
              <div className="flex items-center text-muted-foreground text-xl font-bold">&rarr;</div>
              {/* Formula components */}
              <div className="flex flex-col gap-2 flex-1">
                <div className="rounded-lg border p-3 text-center flex-1">
                  <p className="text-foreground font-medium">Yield Efficiency</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Effective yield ÷ curved risk penalty</p>
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
                  <p className="text-xs text-muted-foreground">Curated venues</p>
                </div>
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium text-xs">Tier 3 / 4</p>
                  <p className="text-xs text-muted-foreground">Fallbacks</p>
                </div>
              </div>
              <div className="text-muted-foreground text-xl font-bold">&darr;</div>
              <div className="w-full rounded-lg border p-3 text-center">
                <p className="text-foreground font-medium">Effective Yield</p>
                <p className="text-xs text-muted-foreground mt-0.5">APY + 25% benchmark spread</p>
              </div>
              <div className="text-muted-foreground text-xl font-bold">&darr;</div>
              <div className="grid grid-cols-2 gap-2 w-full">
                <div className="rounded-lg border p-3 text-center">
                  <p className="text-foreground font-medium text-xs">Yield Efficiency</p>
                  <p className="text-xs text-muted-foreground">Effective yield ÷ curved risk penalty</p>
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
                  DeFiLlama yield pool via static mapping, chain-scoped wrapper rules, and address-first fallback
                  matching, while explicitly preserving wrapper pools that upstream marks as non-stablecoin when they
                  are configured as relevant yield sources and allowing exact-pool curated overrides for assets such as
                  XAUT
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
                not outrank stronger native wrapper yields purely because they query protocol state directly.
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

      {/* PegScore and Depeg Early Warning Score (DEWS) */}
      <MethodologySectionShell
        id="pegscore-dews-methodology"
        title="PegScore and Depeg Early Warning Score (DEWS)"
        versionLabel={DEPEG_DEWS_METHODOLOGY_VERSION_LABEL}
        changelogPath={DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH}
        versionNote="Version increments when depeg thresholds, confirmation policy, peg-score formula terms, or DEWS signal composition or score-affecting input semantics change."
        accentClassName="border-l-amber-500"
        badgeClassName="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"
        changelogClassName="hover:text-amber-700 dark:text-amber-400"
      >
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
            When a live event is later contradicted across the peg by a low-confidence primary price, the detector now
            retires the stale live row immediately and routes the replacement move through pending confirmation instead
            of leaving the wrong direction active.
          </p>
          <p>
            DEX cross-validation uses explicit trust gates. Detection and pending confirmation only trust fresh DEX rows
            with at least $1M of aggregate source TVL, while the public DEX Price Check UI requires a lighter but still
            non-trivial floor of $250K.
          </p>
          <p>
            DEWS (Depeg Early Warning System) computes forward-looking stress every 30 minutes from market, liquidity,
            confidence, flow, and yield signals, with optional PSI-based amplification during systemic stress.
          </p>
          <MethodologyFacts
            facts={[
              { label: "PegScore focus", value: "History: realized peg behavior" },
              { label: "DEWS focus", value: "Forward stress probability" },
              { label: "Refresh", value: "Peg 15m / DEWS 30m" },
            ]}
          />
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Preconditions &amp; Failure Modes</h3>
            <MethodologyFacts
              facts={[
                {
                  label: "Minimum data",
                  value:
                    "PegScore requires >=7 tracking days; DEWS requires >=2 available signals (total weight >=0.30) plus fresh core source tables",
                },
                {
                  label: "Required sources",
                  value:
                    "Peg events + tracking window inputs; DEWS consumes supply/liquidity/price plus optional flow/blacklist/yield signals",
                },
                {
                  label: "Failure behavior",
                  value: "PegScore can be null; DEWS returns null when signal coverage is below threshold, and the cron degrades/no-writes when core source reads fail or dex liquidity is stale",
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
                coins are not diluted across history they didn&apos;t exist for. Requires at least 7 days of tracking
                data; returns null otherwise. Scores based on fewer than 30 days are marked as &ldquo;Early score&rdquo;
                to signal limited history.
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
                      <th scope="col" className="py-2 pr-4 font-medium text-foreground">Component</th>
                      <th scope="col" className="py-2 pr-4 font-medium text-foreground">Weight</th>
                      <th scope="col" className="py-2 pr-4 font-medium text-foreground">Range</th>
                      <th scope="col" className="py-2 font-medium text-foreground">How it works</th>
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
                computed every 30 minutes from 8 sub-signals. Only signals with available data participate; weights are
                redistributed proportionally across available signals.
              </p>
              <p>
                Bootstrap tolerance is one-time only. Missing optional tables can be ignored before the first
                successful publication, but once DEWS has published, stale or missing core liquidity inputs block fresh
                writes instead of being treated as startup noise.
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
      </MethodologySectionShell>

      {/* Contagion Stress Test */}
      <MethodologySectionShell
        id="contagion-stress-test-methodology"
        title="Contagion Stress Test"
        accentClassName="border-l-emerald-500"
      >
          <p>
            The stress test simulates dependency failures to reveal systemic concentration risk across the stablecoin
            ecosystem.
          </p>
          <MethodologyFacts
            facts={[
              { label: "Simulation action", value: "Force one coin to grade D" },
              { label: "Propagation channel", value: "Dependency channel only" },
              { label: "Primary output", value: "Affected coins + supply at risk" },
            ]}
          />
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
      </MethodologySectionShell>

      <MethodologySectionShell
        id="blacklist-tracker-methodology"
        title="Blacklist Tracker Methodology"
        versionLabel={BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL}
        changelogPath={BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH}
        versionNote="Version increments when tracked contracts, event parsing rules, cursor semantics, or amount-enrichment logic change."
        accentClassName="border-l-rose-500"
        badgeClassName="border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-400"
        changelogClassName="hover:text-rose-700 dark:text-rose-400"
      >
          <p>
            The Blacklist Tracker monitors issuer intervention events across USDC, USDT, PAXG, XAUT, PYUSD, and USD1
            contracts, including blacklist, unblacklist, and destroy/wipe actions across EVM and Tron networks.
          </p>
          <p>
            Methodology revisions document changes to event coverage, cross-chain decoding behavior, cursor safety
            policies, event-time amount attribution rules, and the separate freeze-ledger snapshot used for the public
            summary and quarterly chart, including the reconciled `kyc.rip` / `stables.rip` bootstrap for ETH USDC,
            ETH USDT, and TRON USDT.
          </p>
      </MethodologySectionShell>

      {/* ─── Chain Health Score ─────────────────────────────── */}
      <MethodologySectionShell
        id="chain-health-score"
        title="Chain Health Score"
        versionLabel={CHAIN_HEALTH_METHODOLOGY_VERSION_LABEL}
        changelogPath={CHAIN_HEALTH_METHODOLOGY_CHANGELOG_PATH}
        versionNote="Version increments when factor weights, tier assignments, or sub-factor formulas change."
        accentClassName="border-l-teal-500"
        badgeClassName="border-teal-500/30 bg-teal-500/10 text-teal-700 dark:text-teal-400"
        changelogClassName="hover:text-teal-700 dark:hover:text-teal-400"
      >
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
                    <th scope="col" className="py-2 pr-4">Factor</th>
                    <th scope="col" className="py-2 pr-4">Weight</th>
                    <th scope="col" className="py-2">What it measures</th>
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
                    <th scope="col" className="py-2 pr-4">Tier</th>
                    <th scope="col" className="py-2 pr-4">Score</th>
                    <th scope="col" className="py-2 pr-4">Criteria</th>
                    <th scope="col" className="py-2">Examples</th>
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
                    <th scope="col" className="py-2 pr-4">Band</th>
                    <th scope="col" className="py-2 pr-4">Score Range</th>
                    <th scope="col" className="py-2">Interpretation</th>
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
      </MethodologySectionShell>
    </>
  );
}
