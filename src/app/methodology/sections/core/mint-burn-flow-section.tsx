import {
  MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH,
  MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/mint-burn-flow-version";
import {
  MethodologyDetails,
  MethodologyFacts,
  MethodologySectionShell,
  WorkedExample,
} from "../../methodology-shared";

export function MintBurnFlowMethodologySection() {
  return (
          <MethodologySectionShell
            id="mint-burn-flow-methodology"
            title="Mint/Burn Flow Scoring"
            versionLabel={MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL}
            changelogPath={MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH}
            versionNote="Version increments when flow scoring logic, tracked event semantics, or ingestion attribution policies change."
            accentClassName="border-l-orange-500"
            badgeClassName="border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-400"
            changelogClassName="hover:text-orange-700 dark:text-orange-400"
          >
              <p>
                Pharos tracks on-chain mint and burn events for major stablecoins via Alchemy JSON-RPC (Transfer mints/burns
                plus USDT Issue/Redeem). These raw events are aggregated into hourly buckets and exposed as two separate
                signals: raw net flow for current direction, and a baseline-relative pressure score for context. Counted
                flow excludes bridge transfers, review-required burns, and atomic roundtrips.
              </p>
              <MethodologyFacts
                facts={[
                  { label: "Data source", value: "On-chain mint + burn events" },
                  { label: "Primary score", value: "Pressure Shift vs 30D" },
                  { label: "Main outputs", value: "Net flow, gauge, and FtQ" },
                ]}
              />
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
                      value: "Economic-flow aggregates count standard rows only, which in practice means non-bridge mints plus effective burns",
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
                          <th scope="col" className="py-2 pr-4 font-medium text-foreground">Band</th>
                          <th scope="col" className="py-2 pr-4 font-medium text-foreground">Score Range</th>
                          <th scope="col" className="py-2 font-medium text-foreground">Meaning</th>
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
          </MethodologySectionShell>
  );
}
