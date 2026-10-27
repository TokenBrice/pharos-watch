import { cn } from "@/lib/utils";
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
import { PSI_BAND_CLASSES, METHODOLOGY_SECTION_ACCENT_CLASSES, METHODOLOGY_TABLE_ACCENT_CLASSES } from "@shared/lib/classification";
import { PSI_COMPONENT_LIMITS, PSI_CONDITION_BANDS } from "@shared/lib/psi-policy";
import { CRON_SCHEDULE_CADENCES } from "@shared/lib/cron-cadences";

const PSI_REFRESH_MINUTES = CRON_SCHEDULE_CADENCES.dewsPsiOffset.intervalSec / 60;

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
      range: `0–${PSI_COMPONENT_LIMITS.severity}`,
      formula: <>min({PSI_COMPONENT_LIMITS.severity}, &Sigma;(abs(bps)/100 &times; share &times; log2(1+mcap/1B) &times; 60 &times; factor))</>,
      purpose: "Magnitude-weighted depeg damage with extra emphasis on mega-cap instability",
    },
  },
  {
    id: "breadth",
    cells: {
      component: "Breadth",
      range: `0–${PSI_COMPONENT_LIMITS.breadth}`,
      formula: <>min({PSI_COMPONENT_LIMITS.breadth}, &Sigma;(sqrt(mcap/1B) &times; 3 &times; factor))</>,
      purpose: "How widely depegs are spreading across unique coins",
    },
  },
  {
    id: "stress-breadth",
    cells: {
      component: "Stress Breadth",
      range: `0–${PSI_COMPONENT_LIMITS.stressBreadth}`,
      formula: `min(${PSI_COMPONENT_LIMITS.stressBreadth}, dewsStressBreadth)`,
      purpose: "Early-warning pressure from DEWS stress signals before full depegs",
    },
  },
  {
    id: "trend",
    cells: {
      component: "Trend",
      range: `−${PSI_COMPONENT_LIMITS.trend} to +${PSI_COMPONENT_LIMITS.trend}`,
      formula: `clamp(-${PSI_COMPONENT_LIMITS.trend}, ${PSI_COMPONENT_LIMITS.trend}, mcap7dChangePct)`,
      purpose: "7-day stablecoin market-cap momentum (supports or offsets penalties)",
    },
  },
];

const STABILITY_BAND_COLUMNS = [
  { id: "range", header: "Range" },
  { id: "band", header: "Band", cellClassName: "font-medium" },
  { id: "meaning", header: "Meaning", cellClassName: "whitespace-normal" },
];

const STABILITY_BAND_MEANINGS = {
  BEDROCK: "Near-ideal market stability",
  STEADY: "Normal conditions with minor stress",
  TREMOR: "Meaningful instability emerging",
  FRACTURE: "Broad, significant market stress",
  CRISIS: "Contagion-level instability",
  MELTDOWN: "Systemic peg failure conditions",
};
const STABILITY_BAND_ROWS = PSI_CONDITION_BANDS.map(({ min, band }, index) => ({
  id: band.toLowerCase(),
  cells: {
    range: `[${min}, ${index === 0 ? "100]" : `${PSI_CONDITION_BANDS[index - 1].min})`}`,
    band,
    meaning: STABILITY_BAND_MEANINGS[band],
  },
  cellClassNames: { band: PSI_BAND_CLASSES[band] },
}));

export function StabilityIndexMethodologySection() {
  return (
    <MethodologySectionShell
      id={STABILITY_INDEX_SECTION_CONTENT.id}
      title={STABILITY_INDEX_SECTION_CONTENT.title}
      versionBadge={{ label: PSI_METHODOLOGY_VERSION_LABEL }}
      changelogPath={PSI_METHODOLOGY_CHANGELOG_PATH}
      versionNote="Version increments when PSI formula, caps, bands, component definitions, or other score-affecting input semantics change."
      changelogClassName={METHODOLOGY_SECTION_ACCENT_CLASSES.stabilityIndex.changelogHover}
    >
      <p>
        The Pharos Stability Index (PSI) is a market-level 0&ndash;100 health score for the stablecoin ecosystem. It is
        recomputed every {PSI_REFRESH_MINUTES} minutes from live depeg conditions and stress signals, then aggregated into daily history
        snapshots. Its monetary aggregate contains active core stablecoins and cash equivalents; tracked variants and
        stable-value investment products remain browsable but do not count as independent supply.
      </p>
      <p>
        Methodology v3.67 can change repaired historical scores without changing formula weights or bands.
        Audit repairs and bounded backfills share canonical daily-price, native-domain and DEWS archive inputs
        with a twenty-one-day supply lookback. Historical trend compares paired admitted supply identities;
        an unavailable prior denominator or required missing DEWS archive preserves the accepted day rather
        than inventing flat growth or zero stress. Event exclusion and restoration rebuild the post-audit
        eligible universe atomically with event provenance. Fixed-clock replay and owner review remain release
        prerequisites, not completed historical repair claims.
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
          { label: "Update cadence", value: `${PSI_REFRESH_MINUTES}m refresh` },
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
          <h3 className="text-foreground font-medium">Scoring formula</h3>
          <code className="block rounded-lg border border-border/60 bg-muted/50 px-4 py-3 text-xs pharos-numeric">
            Score = 100 &minus; severity &minus; breadth &minus; stressBreadth + trend
          </code>
          <p className="text-xs">The final value is clamped to [0, 100] and rounded to one decimal.</p>
        </div>
        <MethodologyDiagramFlow
          inputCols={4}
          inputs={[
            { title: "Severity", subtitle: STABILITY_COMPONENT_ROWS[0].cells.range },
            { title: "Breadth", subtitle: STABILITY_COMPONENT_ROWS[1].cells.range },
            { title: "Stress Breadth", subtitle: STABILITY_COMPONENT_ROWS[2].cells.range },
            { title: "Trend", subtitle: STABILITY_COMPONENT_ROWS[3].cells.range },
          ]}
          steps={[
            { title: "Compute PSI", subtitle: "100 − penalties + trend", className: "md:w-80" },
            { title: "Condition band", subtitle: "BEDROCK through MELTDOWN", className: cn("md:w-80", METHODOLOGY_TABLE_ACCENT_CLASSES.psiConditionBand) },
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
          <h3 className="text-foreground font-medium">Depeg handling rules</h3>
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
              remained active through the UTC close and a daily snapshot misses the move. Unless that floor applies, a
              start day whose restored daily price is back inside the configured threshold drops out of the replay.
              Later days of an active event keep their daily-price deviation. Restore jobs also repair
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
          <h3 className="text-foreground font-medium">Condition bands</h3>
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
