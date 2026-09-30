import type { ReactNode } from "react";
import { CAUSE_META, CAUSE_ORDER } from "@shared/lib/cause-of-death";
import { formatDeathDate } from "@shared/lib/format";
import { ChartLegendChip } from "@/components/chart-primitives/legend";
import { CAUSE_BG_CLASS, causeColorVars } from "@/lib/cemetery-cause-style";
import { CEMETERY_PEAK_BUCKET_LABELS, type CemeteryPeakBucket } from "@/lib/cemetery-selection";
import { formatCemeteryPeak, type CemeteryPatternKey, type CemeteryStats } from "@/lib/cemetery-stats";
import { cn } from "@/lib/utils";
import { CemeterySectionHeader } from "./cemetery-section-header";
import { DeathsByYearChart, type DeathsByYearDatum } from "./deaths-by-year-chart";
import { PeakByCauseChart, type PeakLaneDatum } from "./peak-by-cause-chart";

const YEAR_HEADLINE_KEYS: readonly CemeteryPatternKey[] = ["algorithmic-early", "counterparty-rising"];
const PEAK_HEADLINE_KEYS: readonly CemeteryPatternKey[] = ["top-two-concentration"];
/** Footnote order: smallest bucket first. */
const FOOTNOTE_BUCKETS: readonly CemeteryPeakBucket[] = ["under-10m", "10m-100m", "100m-1b", "1b-plus"];
const YEAR_LIST = new Intl.ListFormat("en", { type: "conjunction" });

const LEGEND_MARKER = "inline-block h-2.5 w-2.5 rounded-sm";

function ChartCardHeader({
  titleId,
  kicker,
  title,
  headlines,
  description,
  legend,
}: {
  titleId: string;
  kicker: string;
  title: string;
  headlines: string[];
  description: string;
  legend: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <p className="pharos-kicker">{kicker}</p>
      <h3 id={titleId} className="pharos-section-title">
        {title}
      </h3>
      {headlines.length > 0 ? (
        <ul className="space-y-0.5">
          {headlines.map((headline) => (
            <li key={headline} className="text-sm font-medium text-foreground">
              {headline}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="pharos-meta max-w-2xl">{description}</p>
      <div className="flex flex-wrap gap-2 pt-1">{legend}</div>
    </div>
  );
}

function CauseLegendChips() {
  return CAUSE_ORDER.map((cause) => (
    <ChartLegendChip key={cause} markerClassName={cn(LEGEND_MARKER, CAUSE_BG_CLASS)} markerStyle={causeColorVars(cause)}>
      {CAUSE_META[cause].label}
    </ChartLegendChip>
  ));
}

/** Analysis section (`#analysis`): deaths per year (chart B) and peak market cap by cause (chart C). */
export function CemeteryAnalysis({ stats }: { stats: CemeteryStats }) {
  const headlinesFor = (keys: readonly CemeteryPatternKey[]) =>
    keys.flatMap((key) => stats.patterns.filter((pattern) => pattern.key === key).map((pattern) => pattern.headline));

  const years: DeathsByYearDatum[] = stats.years.map((year) => ({
    year: year.year,
    total: year.total,
    counts: CAUSE_ORDER.map((cause) => year.byCause[cause]),
    tracked: CAUSE_ORDER.map((cause) => year.trackedByCause[cause]),
    medianPeakLabel: year.medianPeak === null ? null : formatCemeteryPeak(year.medianPeak),
    partial: year.partial,
  }));

  const lanes: PeakLaneDatum[] = stats.peakByCause.lanes.map((lane) => ({
    cause: lane.cause,
    medianPeak: lane.median,
    medianLabel: lane.median === null ? null : formatCemeteryPeak(lane.median),
    n: lane.n,
    unrecordedCount: lane.unrecordedCount,
    dots: lane.dots.map((dot) => ({
      id: dot.id,
      name: dot.name,
      symbol: dot.symbol,
      peak: dot.peak,
      peakLabel: formatCemeteryPeak(dot.peak),
      dateLabel: formatDeathDate(dot.deathDate),
      labelled: dot.labelled,
    })),
  }));

  const latest = stats.years[stats.years.length - 1];
  const partialYear = stats.years.find((year) => year.partial);
  const emptyYears = stats.years.filter((year) => year.total === 0).map((year) => String(year.year));
  const yearFootnote = [
    partialYear ? `* ${partialYear.year} runs through ${stats.asOf.label}.` : null,
    latest && latest.tracked > 0
      ? `${latest.tracked} of ${latest.total} records in ${latest.year} come from Pharos's own tracked archive.`
      : null,
    emptyYears.length > 0
      ? `No records exist for ${YEAR_LIST.format(emptyYears)}; that is a gap in the catalog, not evidence of no failures.`
      : null,
  ]
    .filter(Boolean)
    .join(" ");

  const unplotted = stats.peakByCause.unplottedCount;
  const peakFootnote = [
    unplotted === 1
      ? "1 record has no recorded peak and is not plotted."
      : unplotted > 1
        ? `${unplotted} records have no recorded peak and are not plotted.`
        : null,
    `Size buckets: ${FOOTNOTE_BUCKETS.map(
      (key) => `${CEMETERY_PEAK_BUCKET_LABELS[key]} ${stats.peakBuckets.find((bucket) => bucket.key === key)?.count ?? 0}`,
    ).join(" · ")}.`,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <section id="analysis" aria-labelledby="analysis-heading" className="scroll-mt-24 space-y-3">
      <CemeterySectionHeader
        id="analysis-heading"
        kicker="Analysis"
        title="When, and how big"
        meta="Counts include every record. Peak market cap is each coin's approximate peak, summed only where recorded; it measures size at the top, not holder losses."
      />
      <div className="space-y-4">
        <DeathsByYearChart
          years={years}
          asOfLabel={stats.asOf.label}
          titleId="analysis-deaths-by-year-title"
          header={
            <ChartCardHeader
              titleId="analysis-deaths-by-year-title"
              kicker="Timeline"
              title="Documented deaths per year, by cause"
              headlines={headlinesFor(YEAR_HEADLINE_KEYS)}
              description="Bars count records by death year. The row under the axis is the median peak market cap of that year's deaths."
              legend={
                <>
                  <CauseLegendChips />
                  <ChartLegendChip markerClassName="inline-block h-2.5 w-2.5 rounded-sm bg-muted-foreground bg-[image:repeating-linear-gradient(135deg,var(--color-card)_0_1.5px,transparent_1.5px_3.5px)]">
                    Pharos tracked archive
                  </ChartLegendChip>
                  {partialYear ? (
                    <ChartLegendChip markerClassName="inline-block h-2.5 w-2.5 rounded-sm border border-dashed border-muted-foreground">
                      Partial year *
                    </ChartLegendChip>
                  ) : null}
                </>
              }
            />
          }
          footnote={
            <p className="pharos-meta">
              <span className="sm:hidden">Median peak by year is in the data table on narrow screens. </span>
              {yearFootnote}
            </p>
          }
        />
        <PeakByCauseChart
          lanes={lanes}
          titleId="analysis-peak-by-cause-title"
          header={
            <ChartCardHeader
              titleId="analysis-peak-by-cause-title"
              kicker="Size"
              title="Peak market cap by cause"
              headlines={headlinesFor(PEAK_HEADLINE_KEYS)}
              description="Each dot is one death with a recorded peak, on a log scale. The dark tick marks each cause's median. Select a dot to open its row in the register."
              legend={
                <>
                  <ChartLegendChip markerClassName="inline-block h-2.5 w-2.5 rounded-full bg-muted-foreground">
                    One death
                  </ChartLegendChip>
                  <ChartLegendChip markerClassName="inline-block h-3 w-0.5 bg-foreground">
                    Cause median
                  </ChartLegendChip>
                  <ChartLegendChip markerClassName="inline-block h-3 w-3 rounded-full bg-muted-foreground">
                    Top five, labelled
                  </ChartLegendChip>
                </>
              }
            />
          }
          footnote={<p className="pharos-meta">{peakFootnote}</p>}
        />
      </div>
    </section>
  );
}
