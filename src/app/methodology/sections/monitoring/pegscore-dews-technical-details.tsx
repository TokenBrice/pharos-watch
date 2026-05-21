import Link from "next/link";
import {
  DEWS_SIGNAL_DESCRIPTIONS,
  DEWS_SIGNAL_LABELS,
  DEWS_SIGNAL_SHORT_LABELS,
  DEWS_SIGNAL_WEIGHTS,
  DEWS_THREAT_BANDS,
  type DewsSignalKey,
} from "@shared/lib/dews-config";
import {
  THREAT_BAND_TEXT_COLORS,
  type ThreatBand,
} from "@shared/lib/classification";
import { MethodologyDetails } from "../../methodology-shared";

const DEWS_SIGNAL_KEYS = Object.keys(DEWS_SIGNAL_WEIGHTS) as DewsSignalKey[];

const DEWS_THREAT_BAND_DESCRIPTIONS: Record<ThreatBand, string> = {
  CALM: "no stress signals detected",
  WATCH: "mild stress on 1-2 indicators",
  ALERT: "multiple indicators elevated",
  WARNING: "strong stress signals, depeg plausible",
  DANGER: "severe stress across available weighted signals",
};

function formatDewsWeight(key: DewsSignalKey): string {
  return DEWS_SIGNAL_WEIGHTS[key].toFixed(2);
}

function getThreatBandLowerBound(index: number): number {
  return index === 0 ? 0 : DEWS_THREAT_BANDS[index - 1].upper + 1;
}

function DewsSignalCards({ compact = false }: { compact?: boolean }) {
  return (
    <>
      {DEWS_SIGNAL_KEYS.map((key) => (
        <div key={key} className="rounded-lg border p-2 text-center">
          <p className="text-foreground font-medium text-xs">
            {compact ? DEWS_SIGNAL_SHORT_LABELS[key] : DEWS_SIGNAL_LABELS[key]}
          </p>
          <p className="text-xs text-muted-foreground">{formatDewsWeight(key)}</p>
        </div>
      ))}
    </>
  );
}

function DewsThreatBandCards({ compact = false }: { compact?: boolean }) {
  return (
    <>
      {DEWS_THREAT_BANDS.map(({ band, upper }, index) => {
        const lower = getThreatBandLowerBound(index);
        const label = compact && band === "WARNING" ? "WARN" : band;
        return (
          <div key={band} className="rounded-lg border p-2 text-center">
            <p className={`${THREAT_BAND_TEXT_COLORS[band]} font-medium text-xs`}>{label}</p>
            <p className="text-xs text-muted-foreground">{lower}&ndash;{upper}</p>
          </div>
        );
      })}
    </>
  );
}

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
        <p className="pharos-numeric text-xs border border-l-[3px] border-l-amber-500 border-border/60 bg-muted/50 rounded-lg px-4 py-3">
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
          DEWS is a per-coin, forward-looking stress score (0&ndash;100) for depeg stress. It is not a
          calibrated probability. It is
          computed every 30 minutes from 8 sub-signals. Only signals with available data participate; weights are
          redistributed proportionally across available signals.
        </p>
        <p>
          Bootstrap tolerance is one-time only. Missing optional tables can be ignored before the first successful
          publication. After that, stale or missing core liquidity inputs are recorded as source failures. The cron
          still writes rows that meet signal coverage, then marks the run degraded instead of treating the missing input as startup noise.
        </p>
        <p>
          The Yield Anomaly sub-signal combines legacy warning strings with populated Yield Intelligence source-risk,
          source-switch, and rank-attribution stress evidence. Neutral, missing, or malformed structured yield rows
          remain unavailable rather than adding zero-stress signal weight.
        </p>
      </div>

      <div className="hidden md:flex items-stretch gap-4">
        <div className="grid grid-cols-2 gap-2 flex-1">
          <DewsSignalCards />
        </div>
        <div className="flex items-center text-muted-foreground text-xl font-bold">&rarr;</div>
        <div className="rounded-lg border p-3 text-center w-36 flex flex-col justify-center flex-shrink-0">
          <p className="text-foreground font-medium">DEWS</p>
          <p className="text-xs text-muted-foreground mt-0.5">&Sigma;(W&sdot;S) / &Sigma;(W)</p>
          <p className="text-xs text-muted-foreground">0–100</p>
        </div>
        <div className="flex items-center text-muted-foreground text-xl font-bold">&rarr;</div>
        <div className="flex flex-col gap-1.5 w-36 justify-center flex-shrink-0">
          <DewsThreatBandCards />
        </div>
      </div>

      <div className="flex flex-col items-center gap-3 md:hidden">
        <div className="grid grid-cols-2 gap-2 w-full">
          <DewsSignalCards compact />
        </div>
        <div className="text-muted-foreground text-xl font-bold">&darr;</div>
        <div className="w-full rounded-lg border p-3 text-center">
          <p className="text-foreground font-medium">DEWS</p>
          <p className="text-xs text-muted-foreground mt-0.5">&Sigma;(W&sdot;S) / &Sigma;(W) &mdash; 0–100</p>
        </div>
        <div className="text-muted-foreground text-xl font-bold">&darr;</div>
        <div className="grid grid-cols-5 gap-1 w-full">
          <DewsThreatBandCards compact />
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-foreground font-medium">Score Formula</h3>
        <p className="pharos-numeric text-xs border border-l-[3px] border-l-amber-500 border-border/60 bg-muted/50 rounded-lg px-4 py-3">
          base = sum(W_i &times; S_i) / sum(W_i); psiAmp = PSI &lt; 75 ? 1 + ((75 - PSI) / 75) &times; 0.3 : 1; contagionAmp = same-peg first-pass bump, clamped to 1.2; DEWS = round(clamp(0, 100, base &times; psiAmp &times; contagionAmp))
        </p>
        <p>
          At least 2 available signal sources (total weight &ge; 0.30) are required; otherwise DEWS returns null.
        </p>
      </div>

      <div className="space-y-2">
        <h3 className="text-foreground font-medium">Sub-Signals &amp; Weights</h3>
        <ul className="list-disc list-inside space-y-1">
          {DEWS_SIGNAL_KEYS.map((key) => (
            <li key={key}>
              <span className="text-foreground">
                {DEWS_SIGNAL_LABELS[key]} ({formatDewsWeight(key)})
              </span>{" "}
              &mdash; {DEWS_SIGNAL_DESCRIPTIONS[key]}
            </li>
          ))}
        </ul>
      </div>

      <div className="space-y-2">
        <h3 className="text-foreground font-medium">Threat Bands</h3>
        <ul className="list-disc list-inside space-y-1">
          {DEWS_THREAT_BANDS.map(({ band, upper }, index) => {
            const lower = getThreatBandLowerBound(index);
            return (
              <li key={band}>
                <span className={`${THREAT_BAND_TEXT_COLORS[band]} font-medium`}>
                  {band} ({lower}&ndash;{upper})
                </span>{" "}
                &mdash; {DEWS_THREAT_BAND_DESCRIPTIONS[band]}
              </li>
            );
          })}
        </ul>
      </div>

      <div className="space-y-2">
        <h3 className="text-foreground font-medium">Edge Cases</h3>
        <ul className="list-disc list-inside space-y-1">
          <li>
            <Link
              href="/learn/mechanisms/tbill/"
              className="text-foreground/70 underline underline-offset-2 hover:text-foreground transition-colors"
            >
              NAV tokens
            </Link>
            {" "}are excluded entirely (price appreciates, not pegged)
          </li>
          <li>Non-USD pegs: cross-source divergence is dampened by 0.7 (noisier FX pricing)</li>
          <li>Small coins (&lt;$50M): supply velocity is dampened via a logarithmic size factor</li>
          <li>Missing DEX data stays unavailable; zero-current rows retire; aggregate freshness uses the newest current row while the body exposes oldest-row lag</li>
        </ul>
      </div>
    </>
  );
}
