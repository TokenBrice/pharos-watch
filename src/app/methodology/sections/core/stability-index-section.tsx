import {
  PSI_METHODOLOGY_CHANGELOG_PATH,
  PSI_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/constants";
import { ContentTable } from "@/components/table";
import {
  METHODOLOGY_LINK_CLASS,
  MethodologyDetails,
  MethodologyDiagramFlow,
  MethodologyFacts,
  MethodologyPreconditions,
  MethodologySectionShell,
  WorkedExample,
} from "../../methodology-shared";
import { STABILITY_INDEX_SECTION_CONTENT } from "@/lib/methodology-content";
import { PSI_BAND_CLASSES } from "@shared/lib/classification";

const STABILITY_COMPONENT_COLUMNS = [
  { id: "component", header: "Component", cellClassName: "text-foreground" },
  { id: "range", header: "Range" },
  { id: "formula", header: "Formula", cellClassName: "pharos-numeric text-xs whitespace-normal" },
  { id: "purpose", header: "Purpose", cellClassName: "whitespace-normal" },
];

const STABILITY_COMPONENT_ROWS = [
  {
    id: "severity",
    cells: {
      component: "Severity",
      range: "0–68",
      formula: <>min(68, &Sigma;(abs(bps)/100 &times; share &times; log2(1+mcap/1B) &times; 60 &times; factor))</>,
      purpose: "Magnitude-weighted depeg damage with extra emphasis on mega-cap instability",
    },
  },
  {
    id: "breadth",
    cells: {
      component: "Breadth",
      range: "0–17",
      formula: <>min(17, &Sigma;(sqrt(mcap/1B) &times; 3 &times; factor))</>,
      purpose: "How widely depegs are spreading across unique coins",
    },
  },
  {
    id: "stress-breadth",
    cells: {
      component: "Stress Breadth",
      range: "0–5",
      formula: "min(5, dewsStressBreadth)",
      purpose: "Early-warning pressure from DEWS stress signals before full depegs",
    },
  },
  {
    id: "trend",
    cells: {
      component: "Trend",
      range: "−5 to +5",
      formula: "clamp(-5, 5, mcap7dChangePct)",
      purpose: "7-day stablecoin market-cap momentum (supports or offsets penalties)",
    },
  },
];

const STABILITY_BAND_COLUMNS = [
  { id: "range", header: "Range" },
  { id: "band", header: "Band", cellClassName: "font-medium" },
  { id: "meaning", header: "Meaning", cellClassName: "whitespace-normal" },
];

const STABILITY_BAND_ROWS = [
  {
    id: "bedrock",
    cells: { range: "90–100", band: "BEDROCK", meaning: "Near-ideal market stability" },
    cellClassNames: { band: PSI_BAND_CLASSES.BEDROCK },
  },
  {
    id: "steady",
    cells: { range: "75–89", band: "STEADY", meaning: "Normal conditions with minor stress" },
    cellClassNames: { band: PSI_BAND_CLASSES.STEADY },
  },
  {
    id: "tremor",
    cells: { range: "60–74", band: "TREMOR", meaning: "Meaningful instability emerging" },
    cellClassNames: { band: PSI_BAND_CLASSES.TREMOR },
  },
  {
    id: "fracture",
    cells: { range: "40–59", band: "FRACTURE", meaning: "Broad, significant market stress" },
    cellClassNames: { band: PSI_BAND_CLASSES.FRACTURE },
  },
  {
    id: "crisis",
    cells: { range: "20–39", band: "CRISIS", meaning: "Contagion-level instability" },
    cellClassNames: { band: PSI_BAND_CLASSES.CRISIS },
  },
  {
    id: "meltdown",
    cells: { range: "0–19", band: "MELTDOWN", meaning: "Systemic peg failure conditions" },
    cellClassNames: { band: PSI_BAND_CLASSES.MELTDOWN },
  },
];

export function StabilityIndexMethodologySection() {
  return (
    <MethodologySectionShell
      id={STABILITY_INDEX_SECTION_CONTENT.id}
      title={STABILITY_INDEX_SECTION_CONTENT.title}
      versionBadge={{ label: PSI_METHODOLOGY_VERSION_LABEL }}
      changelogPath={PSI_METHODOLOGY_CHANGELOG_PATH}
      versionNote="Version increments when PSI formula, caps, bands, component definitions, or other score-affecting input semantics change."
      changelogClassName="hover:text-cyan-700 dark:hover:text-cyan-400"
    >
      <p>
        The Pharos Stability Index (PSI) is a market-level 0&ndash;100 health score for the stablecoin ecosystem. It is
        recomputed every 30 minutes from live depeg conditions and stress signals, then aggregated into daily history
        snapshots. Its monetary aggregate contains active core stablecoins and cash equivalents; tracked variants and
        stable-value investment products remain browsable but do not count as independent supply.
      </p>
      <p className="text-xs text-muted-foreground">
        See also:{" "}
        <a href="#pegscore-dews-methodology" className={METHODOLOGY_LINK_CLASS}>
          PegScore + DEWS
        </a>
        {" · "}
        <a href="#safety-scores-methodology" className={METHODOLOGY_LINK_CLASS}>
          Safety Scores
        </a>
      </p>
      <MethodologyFacts
        facts={[
          { label: "Update cadence", value: "30m refresh" },
          { label: "Score range", value: "0-100 market health" },
          { label: "Main use", value: "Bands: BEDROCK to MELTDOWN" },
        ]}
      />
      <MethodologyPreconditions
        facts={[
            {
              label: "Aggregate universe",
              value:
                "Active core stablecoins and cash equivalents, plus PSI historical assets for continuity; variants and stable-value investments are excluded",
            },
            {
              label: "Minimum data",
              value:
                "Scorer accepts empty depeg and zero warning-band DEWS stress rows, but the cron requires finite positive aggregate market cap and paired previous-week denominator, readable active-depeg inputs, and a fresh non-empty published DEWS generation",
            },
            {
              label: "Required sources",
              value:
                "Observed finite nonnegative current market caps (explicit zero is valid), paired usable previous-week supply, active depeg inputs (observed USD prices or recent replay-safe price_cache; native events use directly observed per-event CoinGecko quotes retained in D1 or timestamped start/recovery evidence strictly younger than six hours), and exact fresh DEWS rows within 3600 seconds",
            },
            {
              label: "Failure behavior",
              value:
                "The cron preserves the last sample when aggregate market cap, paired trend denominator, active-depeg reads or DEWS inputs are unavailable. Assets without usable supply leave denominators, stressed weights and contributors; unpriced open events are omitted, never assigned synthetic calm. Successful partial publication is ok with quality and disclosed supply/trend omission IDs. Native quotes are not inferred from USD prices or FX; PSI adds no network requests",
            },
            {
              label: "Historical replay",
              value:
                "Backfills score any depeg overlapping the UTC day, canonicalize legacy depeg IDs into the current PSI universe, use same-day supply_history prices when they capture the move, cap replayed daily deviation at the event peak, and keep peak event deviation as a start-day floor only when the depeg stayed open through the UTC close and the daily snapshot misses the move",
            },
        ]}
      />
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
        <MethodologyDiagramFlow
          inputCols={4}
          inputs={[
            { title: "Severity", subtitle: "0–68" },
            { title: "Breadth", subtitle: "0–17" },
            { title: "Stress Breadth", subtitle: "0–5" },
            { title: "Trend", subtitle: "−5 to +5" },
          ]}
          steps={[
            { title: "Compute PSI", subtitle: "100 − penalties + trend", className: "md:w-80" },
            { title: "Condition Band", subtitle: "BEDROCK through MELTDOWN", className: "md:w-80 border-cyan-500/40" },
          ]}
        />
        <div className="space-y-2">
          <h3 className="text-foreground font-medium">Components</h3>
          <ContentTable
            tableId="methodology-stability-index-components"
            testId="methodology-stability-index-components-table"
            columns={STABILITY_COMPONENT_COLUMNS}
            rows={STABILITY_COMPONENT_ROWS}
          />
        </div>
        <div className="space-y-2">
          <h3 className="text-foreground font-medium">Depeg Handling Rules</h3>
          <ul className="list-disc list-inside space-y-1">
            <li>
              <span className="text-foreground font-medium">Core-universe boundary:</span> tracked variants and
              stable-value investment products do not contribute market cap, trend, depeg penalties, or DEWS stress
              breadth; their detail and research surfaces remain available.
            </li>
            <li>
              <span className="text-foreground font-medium">Per-coin deduplication:</span> active events are grouped by
              coin; each coin contributes once using the worst current deviation.
            </li>
            <li>
              <span className="text-foreground font-medium">Native quote domains:</span> non-USD native events never
              divide a USD price by a native reference. Live and historical inputs use timestamped native start or
              recovery evidence retained in D1, strictly as-of and younger than six hours. Continuous native quotes
              are not retained; other windows disclose unavailable price evidence rather than inventing a deviation.
            </li>
            <li>
              <span className="text-foreground font-medium">Daily provenance:</span> daily scores average all samples,
              including methodology transitions, with the version breakdown and component sample counts disclosed.
              All-null components are stored as null and display as unavailable chart gaps; observed zero stays zero.
              Partially observed components average their observed samples and disclose the count.
            </li>
            <li>
              <span className="text-foreground font-medium">Historical rebuild parity:</span> completed-day backfills
              score any depeg overlapping the UTC day, canonicalize legacy depeg IDs into the current PSI universe,
              replay USD-domain deviation from `supply_history.price` when possible, never exceed the event&apos;s
              recorded `peak_deviation_bps`, and keep `peak_deviation_bps` as a start-day floor only when the event
              remained active through the UTC close and a daily snapshot misses the move. Replay days whose restored
              daily price is back inside the configured threshold drop out entirely, and restore jobs also repair
              replay-critical daily price coverage, including PSI historical assets, before the PSI rebuild is rerun.
            </li>
            <li>
              <span className="text-foreground font-medium">Age-aware depreciation:</span> fresh depegs get full weight
              for 30 days, then decay linearly to a 25% floor by asset age 120 days.
              Contributor costs use the full-precision scoring factor; rounding applies only to visible age,
              percentage and cost text.
            </li>
          </ul>
          <code className="block rounded-lg border border-border/60 bg-muted/50 px-4 py-3 text-xs pharos-numeric">
            factor = ageDays &le; 30 ? 1.0 : max(0.25, 1.0 &minus; (ageDays &minus; 30)/120)
          </code>
        </div>
        <div className="space-y-2">
          <h3 className="text-foreground font-medium">Condition Bands</h3>
          <ContentTable
            tableId="methodology-stability-index-condition-bands"
            testId="methodology-stability-index-condition-bands-table"
            columns={STABILITY_BAND_COLUMNS}
            rows={STABILITY_BAND_ROWS}
          />
        </div>
      </MethodologyDetails>
    </MethodologySectionShell>
  );
}
