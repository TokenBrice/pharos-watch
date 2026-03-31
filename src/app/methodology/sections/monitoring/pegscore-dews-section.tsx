import {
  DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
  DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/depeg-dews-version";
import {
  MethodologyDetails,
  MethodologyFacts,
  MethodologySectionShell,
  WorkedExample,
} from "../../methodology-shared";

export function PegScoreDewsMethodologySection() {
  return (
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
                DEX cross-validation uses explicit trust gates: detection and pending confirmation only trust fresh DEX rows with at least $1M of aggregate source TVL, while the public DEX Price Check UI requires a lighter but still non-trivial floor of $250K. For already-open depegs, same-direction aggregate DEX disagreement is advisory rather than a synthetic recovery signal, so events stay continuous until the normal recovery path confirms the coin is back inside threshold.
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
  );
}
