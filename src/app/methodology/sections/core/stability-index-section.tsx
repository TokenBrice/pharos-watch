import {
  PSI_METHODOLOGY_CHANGELOG_PATH,
  PSI_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/stability-index-version";
import {
  MethodologyDetails,
  MethodologyDiagramArrow,
  MethodologyDiagramCard,
  MethodologyFacts,
  MethodologySectionShell,
  WorkedExample,
} from "../../methodology-shared";

export function StabilityIndexMethodologySection() {
  return (
          <MethodologySectionShell
            id="stability-index-methodology"
            title="Stability Index Methodology"
            versionLabel={PSI_METHODOLOGY_VERSION_LABEL}
            changelogPath={PSI_METHODOLOGY_CHANGELOG_PATH}
            versionNote="Version increments when PSI formula, caps, bands, component definitions, or other score-affecting input semantics change."
            accentClassName="border-l-cyan-500"
            badgeClassName="border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-400"
            changelogClassName="hover:text-cyan-700 dark:text-cyan-400"
          >
              <p>
                The Pharos Stability Index (PSI) is a market-level 0&ndash;100 health score for the stablecoin ecosystem. It
                is recomputed every 30 minutes from live depeg conditions and stress signals, then aggregated into daily
                history snapshots.
              </p>
              <MethodologyFacts
                facts={[
                  { label: "Update cadence", value: "30m refresh" },
                  { label: "Score range", value: "0-100 market health" },
                  { label: "Main use", value: "Bands: BEDROCK to MELTDOWN" },
                ]}
              />
              <div className="space-y-2">
                <h3 className="text-foreground font-medium">Preconditions &amp; Failure Modes</h3>
                <MethodologyFacts
                  facts={[
                    { label: "Minimum data", value: "Scorer accepts empty depeg sets, but the cron requires total market cap > 0 and an available active-depeg input query" },
                    { label: "Required sources", value: "Market-cap totals + active depeg inputs (current stablecoins price, or recent replay-safe price_cache fallback for already-open depegs; DEWS breadth optional)" },
                    {
                      label: "Failure behavior",
                      value:
                        "Returns null when market-cap input is missing/<=0; the cron also skips publication when active-depeg inputs are unavailable, and the API serves the last valid value",
                    },
                    {
                      label: "Historical replay",
                      value:
                        "Backfills score any depeg overlapping the UTC day, canonicalize legacy depeg IDs into the current PSI universe, use same-day supply_history prices when they capture the move, cap replayed daily deviation at the event peak, and keep peak event deviation as a start-day floor only when the depeg stayed open through the UTC close and the daily snapshot misses the move",
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
                <div className="hidden md:flex flex-col items-center gap-3">
                  <div className="grid grid-cols-4 gap-3 w-full">
                    <MethodologyDiagramCard title="Severity" subtitle="0–68" />
                    <MethodologyDiagramCard title="Breadth" subtitle="0–17" />
                    <MethodologyDiagramCard title="Stress Breadth" subtitle="0–5" />
                    <MethodologyDiagramCard title="Trend" subtitle="−5 to +5" />
                  </div>
                  <MethodologyDiagramArrow />
                  <MethodologyDiagramCard className="w-80" title="Compute PSI" subtitle="100 − penalties + trend" />
                  <MethodologyDiagramArrow />
                  <MethodologyDiagramCard className="w-80 border-cyan-500/40" title="Condition Band" subtitle="BEDROCK through MELTDOWN" />
                </div>
                <div className="flex flex-col items-center gap-3 md:hidden">
                  <div className="grid grid-cols-2 gap-2 w-full">
                    <MethodologyDiagramCard title="Severity" titleClassName="text-xs text-foreground font-medium" subtitle="0–68" subtitleClassName="text-xs text-muted-foreground" />
                    <MethodologyDiagramCard title="Breadth" titleClassName="text-xs text-foreground font-medium" subtitle="0–17" subtitleClassName="text-xs text-muted-foreground" />
                    <MethodologyDiagramCard title="Stress Breadth" titleClassName="text-xs text-foreground font-medium" subtitle="0–5" subtitleClassName="text-xs text-muted-foreground" />
                    <MethodologyDiagramCard title="Trend" titleClassName="text-xs text-foreground font-medium" subtitle="−5 to +5" subtitleClassName="text-xs text-muted-foreground" />
                  </div>
                  <MethodologyDiagramArrow />
                  <MethodologyDiagramCard className="w-full" title="Compute PSI" subtitle="100 − penalties + trend" />
                  <MethodologyDiagramArrow />
                  <MethodologyDiagramCard className="w-full border-cyan-500/40" title="Condition Band" subtitle="BEDROCK through MELTDOWN" />
                </div>
                <div className="space-y-2">
                  <h3 className="text-foreground font-medium">Components</h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left">
                          <th scope="col" className="py-2 pr-4 font-medium text-foreground">Component</th>
                          <th scope="col" className="py-2 pr-4 font-medium text-foreground">Range</th>
                          <th scope="col" className="py-2 pr-4 font-medium text-foreground">Formula</th>
                          <th scope="col" className="py-2 font-medium text-foreground">Purpose</th>
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
                      <span className="text-foreground font-medium">Historical rebuild parity:</span> completed-day backfills
                      score any depeg overlapping the UTC day, canonicalize legacy depeg IDs into the current PSI
                      universe, replay same-day deviation from `supply_history.price` when possible, never exceed the
                      event&apos;s recorded `peak_deviation_bps`, and keep `peak_deviation_bps` as a start-day floor only
                      when the event remained active through the UTC close and a daily snapshot misses the move.
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
                          <th scope="col" className="py-2 pr-4 font-medium text-foreground">Range</th>
                          <th scope="col" className="py-2 pr-4 font-medium text-foreground">Band</th>
                          <th scope="col" className="py-2 font-medium text-foreground">Meaning</th>
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
          </MethodologySectionShell>
  );
}
