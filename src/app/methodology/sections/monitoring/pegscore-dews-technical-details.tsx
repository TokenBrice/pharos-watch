import { MethodologyDetails } from "../../methodology-shared";

export function PegScoreDewsTechnicalDetails() {
  return (
    <MethodologyDetails summary="Technical details: PegScore formula, DEWS signals, weights, and threat bands">
      <PegScoreTechnicalDetails />
      <DewsTechnicalDetails />
    </MethodologyDetails>
  );
}

function PegScoreTechnicalDetails() {
  return (
    <>
      <div className="space-y-2">
        <h3 className="text-foreground font-medium">PegScore</h3>
        <p>
          Composite 0&ndash;100 score measuring how faithfully a stablecoin holds its peg. The tracking window
          spans up to 4 years but is capped at the coin&apos;s actual age. PegScore now prefers a curated
          launch date when one is available and otherwise falls back to the earliest supply snapshot, so
          young coins are not diluted across history they didn&apos;t exist for. Requires at least 7 days of tracking
          data; returns null otherwise. Scores based on 7&ndash;30 days are marked as &ldquo;Early score&rdquo; to
          signal limited history.
        </p>
      </div>

      <div className="space-y-2">
        <h3 className="text-foreground font-medium">PegScore Formula</h3>
        <p className="font-mono text-xs border border-l-[3px] border-l-amber-500 border-border/60 bg-muted/50 rounded-lg px-4 py-3">
          pegScore = 0.5 &times; pegPct + 0.5 &times; severityScore &minus; activeDepegPenalty &minus;
          spreadPenalty
        </p>
      </div>

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
    </>
  );
}

function DewsTechnicalDetails() {
  return (
    <>
      <div className="space-y-2">
        <h3 className="text-foreground font-medium">DEWS</h3>
        <p>
          DEWS is a per-coin, forward-looking stress score (0&ndash;100) estimating depeg probability. It is
          computed every 30 minutes from 8 sub-signals. Only signals with available data participate; weights are
          redistributed proportionally across available signals.
        </p>
        <p>
          Bootstrap tolerance is one-time only. Missing optional tables can be ignored before the first successful
          publication. After that, stale or missing core liquidity inputs are recorded as source failures. The cron
          still writes rows that meet signal coverage, then marks the run degraded instead of treating the missing input as startup noise.
        </p>
      </div>

      <div className="hidden md:flex items-stretch gap-4">
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
        <div className="rounded-lg border p-3 text-center w-36 flex flex-col justify-center flex-shrink-0">
          <p className="text-foreground font-medium">DEWS</p>
          <p className="text-xs text-muted-foreground mt-0.5">&Sigma;(W&sdot;S) / &Sigma;(W)</p>
          <p className="text-xs text-muted-foreground">0–100</p>
        </div>
        <div className="flex items-center text-muted-foreground text-xl font-bold">&rarr;</div>
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

      <div className="space-y-2">
        <h3 className="text-foreground font-medium">Score Formula</h3>
        <p className="font-mono text-xs border border-l-[3px] border-l-amber-500 border-border/60 bg-muted/50 rounded-lg px-4 py-3">
          base = sum(W_i &times; S_i) / sum(W_i); psiAmp = PSI &lt; 75 ? 1 + ((75 - PSI) / 75) &times; 0.3 : 1; contagionAmp = same-peg first-pass bump, clamped to 1.2; DEWS = round(clamp(0, 100, base &times; psiAmp &times; contagionAmp))
        </p>
        <p>
          At least 2 available signal sources (total weight &ge; 0.30) are required; otherwise DEWS returns null.
        </p>
      </div>

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
            surges for the live blacklist-tracked symbol set
          </li>
          <li>
            <span className="text-foreground">Mint/Burn Flow (0.10)</span> &mdash; redemption surge vs minting
            from on-chain Transfer event data; mature 30-day coverage stays available even when the latest
            24-hour window is quiet, contributing zero flow stress instead of disappearing
          </li>
          <li>
            <span className="text-foreground">Yield Anomaly (0.05)</span> &mdash; warning-signal accumulation from
            yield spikes, divergence, TVL outflows, negative trends, and reward-heavy regimes
          </li>
        </ul>
      </div>

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

      <div className="space-y-2">
        <h3 className="text-foreground font-medium">Edge Cases</h3>
        <ul className="list-disc list-inside space-y-1">
          <li>NAV tokens are excluded entirely (price appreciates, not pegged)</li>
          <li>Non-USD pegs: cross-source divergence is dampened by 0.7 (noisier FX pricing)</li>
          <li>Small coins (&lt;$50M): supply velocity is dampened via a logarithmic size factor</li>
          <li>Missing DEX data stays unavailable; zero-current rows retire; aggregate freshness uses the oldest current row</li>
        </ul>
      </div>
    </>
  );
}
