import Link from "next/link";
import type { ReactNode } from "react";
import { sortCemeteryCoins } from "@shared/lib/cemetery";
import type { CemeteryEntry } from "@shared/lib/cemetery-merged";
import { getMechanismExplainerPath } from "@shared/lib/classification";
import { formatDeathDate } from "@shared/lib/format";
import { CemeterySectionHeader } from "@/components/cemetery/cemetery-section-header";
import { CASE_STUDY_CLIENT_BY_CEMETERY_ID, type CaseStudyClientSummary } from "@/lib/case-study-client-index";
import type { CemeteryStats } from "@/lib/cemetery-stats";
import { MECHANISM_EXPLAINER_TITLES } from "@/lib/mechanism-explainer-registry";
import { LIFECYCLE_PHASES_SECTION_CONTENT } from "@/lib/methodology-content";

/** One case study linked to a cemetery record; built server-side by `buildCemeteryCaseStudyLinks`. */
export interface CemeteryCaseStudyLink {
  id: string;
  slug: string;
  title: string;
  symbol: string;
  deathDate: string;
}

export interface CemeteryContextProps {
  stats: CemeteryStats;
  /** Newest first, as returned by `buildCemeteryCaseStudyLinks`. */
  caseStudies: readonly CemeteryCaseStudyLink[];
}

/** Case studies attached to cemetery records, newest death first (the `sortCemeteryCoins` order). */
export function buildCemeteryCaseStudyLinks(
  entries: readonly CemeteryEntry[],
  index: Readonly<Record<string, CaseStudyClientSummary>> = CASE_STUDY_CLIENT_BY_CEMETERY_ID,
): CemeteryCaseStudyLink[] {
  return sortCemeteryCoins(entries.filter((entry) => Object.hasOwn(index, entry.id))).map((entry) => ({
    id: entry.id,
    slug: index[entry.id].slug,
    title: index[entry.id].title,
    symbol: entry.symbol,
    deathDate: entry.deathDate,
  }));
}

/** The owner-approved rules (D11), printed verbatim. */
export const CEMETERY_INCLUSION_RULE =
  "A stablecoin is included when it had a public market and at least one primary public source documents its failure or discontinuation. There is no size floor; peak market cap is recorded when known.";
export const CEMETERY_PRIMARY_CAUSE_RULE =
  "Each record carries one primary cause: the root cause, meaning the design or party whose failure made the peg unrecoverable. Triggers such as runs, exploits or orders are described in the obituary.";

/**
 * Records whose obituaries document a holder exit: BUSD balances were
 * auto-converted, FEI redeemed 1:1 for DAI, EURT holders had a year to redeem.
 */
const HOLDER_CONVERTED_ID = "busd-binance-usd-2023-02";
const HOLDER_REDEMPTION_IDS = ["fei-fei-usd-2022-08", "eurt-euro-tether-2024-11"] as const;

const LIFECYCLE_HREF = `/methodology/#${LIFECYCLE_PHASES_SECTION_CONTENT.id}`;
const COLUMN_CLASS = "min-w-0 space-y-3 px-4 py-4 md:px-5 md:py-5";
const COLUMN_TITLE_CLASS = "text-sm font-semibold text-foreground";
const LIST_CLASS = "space-y-2 text-sm leading-relaxed text-muted-foreground";

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

/** Runs of consecutive years with no records, as "2019–2020" or "2023". */
function emptyYearRanges(stats: CemeteryStats): string[] {
  const ranges: string[] = [];
  let start: number | null = null;
  let end: number | null = null;
  const flush = () => {
    if (start !== null && end !== null) ranges.push(start === end ? String(start) : `${start}–${end}`);
    start = null;
    end = null;
  };
  for (const year of stats.years) {
    if (year.total > 0) {
      flush();
      continue;
    }
    if (start === null) start = year.year;
    end = year.year;
  }
  flush();
  return ranges;
}

function holderRouteSentence(stats: CemeteryStats): string | null {
  const symbolById = new Map<string, string>();
  for (const lane of stats.peakByCause.lanes) for (const dot of lane.dots) symbolById.set(dot.id, dot.symbol);
  const converted = symbolById.get(HOLDER_CONVERTED_ID);
  const redeemed = HOLDER_REDEMPTION_IDS.map((id) => symbolById.get(id));
  if (converted === undefined || redeemed.some((symbol) => symbol === undefined)) return null;
  return `${converted} holders were converted, and ${redeemed.join(" and ")} had redemption routes.`;
}

function catalogSentence(stats: CemeteryStats): string {
  const empty = emptyYearRanges(stats);
  const latest = stats.years.find((year) => year.year === stats.latestYear);
  const parts = [
    empty.length > 0
      ? `The catalog is not exhaustive: nothing is recorded for ${joinList(empty)}.`
      : "The catalog is not exhaustive.",
  ];
  if (latest && latest.tracked > 0) {
    parts.push(
      `${latest.tracked} of the ${plural(latest.total, "record")} in ${latest.year}${latest.partial ? " so far" : ""} ${latest.tracked === 1 ? "is a coin" : "are coins"} Pharos tracked live.`,
    );
  }
  return parts.join(" ");
}

function fieldsAndLimits(stats: CemeteryStats): { key: string; text: string }[] {
  const { day, month } = stats.datePrecision;
  const { unrecordedCount } = stats.peak;
  const holderRoutes = holderRouteSentence(stats);
  const peak = [
    "Peak market cap is approximate, optional and not a loss figure:",
    unrecordedCount > 0
      ? `${unrecordedCount} of ${stats.total} not recorded, never counted as zero.`
      : `recorded for all ${stats.total}.`,
    holderRoutes,
  ].filter((part): part is string => part !== null);
  const items = [
    { key: "cause", text: "One primary cause per record." },
    {
      key: "dates",
      text: `Death dates are precise to the day for ${plural(day, "record")} and to the month for ${month}.`,
    },
    { key: "peak", text: peak.join(" ") },
    { key: "source", text: "One primary source per record." },
    { key: "catalog", text: catalogSentence(stats) },
  ];
  if (stats.mechanisms.unmappedCount > 0) {
    items.push({
      key: "mechanism",
      text: `${stats.mechanisms.unmappedCount} of ${stats.total} records ${stats.mechanisms.unmappedCount === 1 ? "has" : "have"} no mechanism link yet.`,
    });
  }
  return items;
}

function Count({ children }: { children: ReactNode }) {
  return <span className="pharos-numeric font-semibold text-foreground">{children}</span>;
}

function ReadDeeperCard({ kicker, title, children }: { kicker: string; title: string; children: ReactNode }) {
  return (
    <div className="pharos-card-shell min-w-0 space-y-3 px-4 py-4 md:px-5 md:py-5">
      <div className="space-y-1">
        <p className="pharos-kicker">{kicker}</p>
        <h4 className={COLUMN_TITLE_CLASS}>{title}</h4>
      </div>
      {children}
    </div>
  );
}

/** "What counts as dead": routes in, the two approved rules, field limits, and further reading. */
export function CemeteryContext({ stats, caseStudies }: CemeteryContextProps) {
  const mechanisms = stats.mechanisms.counts
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count);

  return (
    <section id="methodology" aria-labelledby="methodology-heading" className="scroll-mt-24 space-y-4">
      <CemeterySectionHeader id="methodology-heading" kicker="Methodology" title="What counts as dead" />

      <div className="pharos-card-shell overflow-hidden">
        <div className="grid lg:grid-cols-3">
          <div className={COLUMN_CLASS}>
            <h3 className={COLUMN_TITLE_CLASS}>Two routes into the cemetery</h3>
            <ul className={LIST_CLASS}>
              <li>
                <span className="font-medium text-foreground">Tracked, then frozen</span> (<Count>{stats.trackedCount}</Count>): coins
                Pharos monitored live and froze once they had effectively ended or failed. Their detail pages stay online with
                archived data.
              </li>
              <li>
                <span className="font-medium text-foreground">Curated</span> (<Count>{stats.curatedCount}</Count>): failed or
                discontinued stablecoins documented from public sources.
              </li>
            </ul>
            <p className="pharos-meta">
              Phases are defined in{" "}
              <Link href={LIFECYCLE_HREF} className="pharos-prose-link">
                {LIFECYCLE_PHASES_SECTION_CONTENT.title}
              </Link>
              .
            </p>
            <h4 className={`${COLUMN_TITLE_CLASS} pt-1`}>Not in the cemetery</h4>
            <ul className={LIST_CLASS}>
              <li>
                Active depegs, which stay on the{" "}
                <Link href="/depeg/" className="pharos-prose-link">
                  depeg tracker
                </Link>{" "}
                until they recover or are frozen.
              </li>
              <li>Quarantined records, withheld after a reviewed lack of supply or market-cap coverage.</li>
              <li>Delisted records, which fell outside listing scope. They keep a read-only profile with a dated reason.</li>
            </ul>
          </div>

          <div className={`${COLUMN_CLASS} border-t border-border/60 lg:border-l lg:border-t-0`}>
            <h3 className={COLUMN_TITLE_CLASS}>Inclusion and primary cause</h3>
            <dl className="space-y-3 text-sm leading-relaxed">
              <div className="space-y-1">
                <dt className="pharos-kicker">Inclusion</dt>
                <dd className="text-foreground/90">{CEMETERY_INCLUSION_RULE}</dd>
              </div>
              <div className="space-y-1">
                <dt className="pharos-kicker">Primary cause</dt>
                <dd className="text-foreground/90">{CEMETERY_PRIMARY_CAUSE_RULE}</dd>
              </div>
            </dl>
          </div>

          <div className={`${COLUMN_CLASS} border-t border-border/60 lg:border-l lg:border-t-0`}>
            <h3 className={COLUMN_TITLE_CLASS}>Fields and limits</h3>
            <ul className={`${LIST_CLASS} list-disc pl-4 marker:text-border`}>
              {fieldsAndLimits(stats).map((item) => (
                <li key={item.key}>{item.text}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {caseStudies.length > 0 || mechanisms.length > 0 ? (
        <div className="space-y-3">
          <h3 className="pharos-kicker">Read deeper</h3>
          <div className="grid gap-4 md:grid-cols-2">
            {caseStudies.length > 0 ? (
              <ReadDeeperCard kicker="Case studies" title="Full reconstructions of documented deaths">
                <ul className="divide-y divide-border/50">
                  {caseStudies.map((study) => (
                    <li key={study.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2 first:pt-0 last:pb-0">
                      <Link href={`/learn/case-studies/${study.slug}/`} className="pharos-prose-link min-w-0 text-sm">
                        {study.title}
                      </Link>
                      <span className="pharos-numeric shrink-0 font-mono text-[11px] text-muted-foreground">
                        {study.symbol} · {formatDeathDate(study.deathDate)}
                      </span>
                    </li>
                  ))}
                </ul>
              </ReadDeeperCard>
            ) : null}
            {mechanisms.length > 0 ? (
              <ReadDeeperCard kicker="Mechanism explainers" title="How each design works, and how it has failed">
                <ul className="divide-y divide-border/50">
                  {mechanisms.map(({ archetype, count }) => (
                    <li key={archetype} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2 first:pt-0 last:pb-0">
                      <Link href={getMechanismExplainerPath(archetype)} className="pharos-prose-link min-w-0 text-sm">
                        {MECHANISM_EXPLAINER_TITLES[archetype]}
                      </Link>
                      <span className="pharos-numeric shrink-0 text-xs text-muted-foreground">
                        {plural(count, "linked death")}
                      </span>
                    </li>
                  ))}
                </ul>
              </ReadDeeperCard>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
