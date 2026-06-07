import {
  PSI_METHODOLOGY_CHANGELOG_PATH,
  PSI_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/stability-index-version";
import {
  TableBody,
  TableCell,
  TableFrame,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/table";
import {
  METHODOLOGY_LINK_CLASS,
  MethodologyDetails,
  MethodologyDiagramArrow,
  MethodologyDiagramCard,
  MethodologyFacts,
  MethodologySectionShell,
  WorkedExample,
} from "../../methodology-shared";
import { STABILITY_INDEX_SECTION_CONTENT } from "../methodology-content";
export function StabilityIndexMethodologySection() {
  return (
          <MethodologySectionShell
            id={STABILITY_INDEX_SECTION_CONTENT.id}
            title={STABILITY_INDEX_SECTION_CONTENT.title}
            versionLabel={PSI_METHODOLOGY_VERSION_LABEL}
            changelogPath={PSI_METHODOLOGY_CHANGELOG_PATH}
            versionNote="Version increments when PSI formula, caps, bands, component definitions, or other score-affecting input semantics change."
            badgeClassName="border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-400"
            changelogClassName="hover:text-cyan-700 dark:text-cyan-400"
          >
              <p>
                The Pharos Stability Index (PSI) is a market-level 0&ndash;100 health score for the stablecoin ecosystem. It
                is recomputed every 30 minutes from live depeg conditions and stress signals, then aggregated into daily
                history snapshots.
              </p>
              <p className="text-xs text-muted-foreground">
                See also:{" "}
                <a href="#pegscore-dews-methodology" className={METHODOLOGY_LINK_CLASS}>PegScore + DEWS</a>
                {" · "}
                <a href="#safety-scores-methodology" className={METHODOLOGY_LINK_CLASS}>Safety Scores</a>
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
                    { label: "Minimum data", value: "Scorer accepts empty depeg and zero warning-band DEWS stress rows, but the cron requires total market cap > 0 plus readable active-depeg inputs and a fresh non-empty latest DEWS row set" },
                    { label: "Required sources", value: "Market-cap totals, active depeg inputs (current stablecoins price, or recent replay-safe price_cache fallback for already-open depegs), and latest DEWS stress-signal rows no older than two compute-dews intervals" },
                    {
                      label: "Failure behavior",
                      value:
                        "Returns null when market-cap input is missing/<=0; the cron also skips publication when active-depeg or DEWS inputs are unavailable, empty, or stale, and the API serves the last valid value",
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
                <p className="pharos-numeric">
                  Inputs: bps=-120, depegMcap=$2B, totalMcap=$200B, age=10d, trend=+1.2, stressBreadth=1.5
                </p>
                <p className="pharos-numeric">severity=1.141, breadth=4.243, score=100-1.141-4.243-1.5+1.2=94.316&rarr;94.3</p>
                <p>
                  Result: <span className="text-foreground">PSI 94.3 (BEDROCK)</span>.
                </p>
              </WorkedExample>
              <MethodologyDetails
                primary
                summary="Technical details: formula, component math, depeg handling, and condition bands"
              >
                <div className="space-y-2">
                  <h3 className="text-foreground font-medium">Scoring Formula</h3>
                  <code className="block rounded-lg border border-border/60 bg-muted/50 px-4 py-3 text-xs pharos-numeric">
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
                  <TableFrame
                    chrome="content"
                    density="compact"
                    tableId="methodology-stability-index-components"
                    testId="methodology-stability-index-components-table"
                    viewportProps={{ mobileScrollHint: false }}
                  >
                    <TableHeader>
                      <TableRow className="text-left">
                        <TableHead scope="col" className="py-2 pr-4 text-foreground">Component</TableHead>
                        <TableHead scope="col" className="py-2 pr-4 text-foreground">Range</TableHead>
                        <TableHead scope="col" className="py-2 pr-4 text-foreground">Formula</TableHead>
                        <TableHead scope="col" className="py-2 text-foreground">Purpose</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      <TableRow>
                        <TableCell className="py-2 pr-4 text-foreground">Severity</TableCell>
                        <TableCell className="py-2 pr-4">0&ndash;68</TableCell>
                        <TableCell className="py-2 pr-4 pharos-numeric text-xs whitespace-normal">
                          min(68, &Sigma;(abs(bps)/100 &times; share &times; log2(1+mcap/1B) &times; 60 &times; factor))
                        </TableCell>
                        <TableCell className="py-2 whitespace-normal">
                          Magnitude-weighted depeg damage with extra emphasis on mega-cap instability
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="py-2 pr-4 text-foreground">Breadth</TableCell>
                        <TableCell className="py-2 pr-4">0&ndash;17</TableCell>
                        <TableCell className="py-2 pr-4 pharos-numeric text-xs whitespace-normal">
                          min(17, &Sigma;(sqrt(mcap/1B) &times; 3 &times; factor))
                        </TableCell>
                        <TableCell className="py-2 whitespace-normal">How widely depegs are spreading across unique coins</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="py-2 pr-4 text-foreground">Stress Breadth</TableCell>
                        <TableCell className="py-2 pr-4">0&ndash;5</TableCell>
                        <TableCell className="py-2 pr-4 pharos-numeric text-xs whitespace-normal">min(5, dewsStressBreadth)</TableCell>
                        <TableCell className="py-2 whitespace-normal">Early-warning pressure from DEWS stress signals before full depegs</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="py-2 pr-4 text-foreground">Trend</TableCell>
                        <TableCell className="py-2 pr-4">&minus;5 to +5</TableCell>
                        <TableCell className="py-2 pr-4 pharos-numeric text-xs whitespace-normal">clamp(-5, 5, mcap7dChangePct)</TableCell>
                        <TableCell className="py-2 whitespace-normal">7-day stablecoin market-cap momentum (supports or offsets penalties)</TableCell>
                      </TableRow>
                    </TableBody>
                  </TableFrame>
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
                      when the event remained active through the UTC close and a daily snapshot misses the move. Replay
                      days whose restored daily price is back inside the configured threshold drop out entirely, and
                      restore jobs also repair replay-critical daily price coverage, including PSI-only shadow assets,
                      before the PSI rebuild is rerun.
                    </li>
                    <li>
                      <span className="text-foreground font-medium">Age-aware depreciation:</span> fresh depegs get full
                      weight for 30 days, then decay linearly to a 25% floor over 120 days.
                    </li>
                  </ul>
                  <code className="block rounded-lg border border-border/60 bg-muted/50 px-4 py-3 text-xs pharos-numeric">
                    factor = ageDays &le; 30 ? 1.0 : max(0.25, 1.0 &minus; (ageDays &minus; 30)/120)
                  </code>
                </div>
                <div className="space-y-2">
                  <h3 className="text-foreground font-medium">Condition Bands</h3>
                  <TableFrame
                    chrome="content"
                    density="compact"
                    tableId="methodology-stability-index-condition-bands"
                    testId="methodology-stability-index-condition-bands-table"
                    viewportProps={{ mobileScrollHint: false }}
                  >
                    <TableHeader>
                      <TableRow className="text-left">
                        <TableHead scope="col" className="py-2 pr-4 text-foreground">Range</TableHead>
                        <TableHead scope="col" className="py-2 pr-4 text-foreground">Band</TableHead>
                        <TableHead scope="col" className="py-2 text-foreground">Meaning</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      <TableRow>
                        <TableCell className="py-2 pr-4">90&ndash;100</TableCell>
                        <TableCell className="py-2 pr-4 text-green-700 dark:text-green-400 font-medium">BEDROCK</TableCell>
                        <TableCell className="py-2 whitespace-normal">Near-ideal market stability</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="py-2 pr-4">75&ndash;89</TableCell>
                        <TableCell className="py-2 pr-4 text-teal-700 dark:text-teal-400 font-medium">STEADY</TableCell>
                        <TableCell className="py-2 whitespace-normal">Normal conditions with minor stress</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="py-2 pr-4">60&ndash;74</TableCell>
                        <TableCell className="py-2 pr-4 text-yellow-700 dark:text-yellow-400 font-medium">TREMOR</TableCell>
                        <TableCell className="py-2 whitespace-normal">Meaningful instability emerging</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="py-2 pr-4">40&ndash;59</TableCell>
                        <TableCell className="py-2 pr-4 text-orange-700 dark:text-orange-400 font-medium">FRACTURE</TableCell>
                        <TableCell className="py-2 whitespace-normal">Broad, significant market stress</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="py-2 pr-4">20&ndash;39</TableCell>
                        <TableCell className="py-2 pr-4 text-red-700 dark:text-red-400 font-medium">CRISIS</TableCell>
                        <TableCell className="py-2 whitespace-normal">Contagion-level instability</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="py-2 pr-4">0&ndash;19</TableCell>
                        <TableCell className="py-2 pr-4 text-red-800 font-medium">MELTDOWN</TableCell>
                        <TableCell className="py-2 whitespace-normal">Systemic peg failure conditions</TableCell>
                      </TableRow>
                    </TableBody>
                  </TableFrame>
                </div>
              </MethodologyDetails>
          </MethodologySectionShell>
  );
}
