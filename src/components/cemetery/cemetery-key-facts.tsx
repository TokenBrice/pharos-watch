import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { formatPercentFromRatio, formatUtcDayLabel } from "@shared/lib/format";
import { buildRegisterHref, CEMETERY_PEAK_BUCKET_LABELS } from "@/lib/cemetery-selection";
import { formatCemeteryPeak, type CemeteryStats } from "@/lib/cemetery-stats";
import styles from "./cemetery-below-fold.module.css";

/** The dataset fields the footer rail prints; `CEMETERY_DATASET_META` satisfies it. */
export interface CemeteryKeyFactsDatasetMeta {
  schemaVersion: string;
  sourceChecksumShort: string;
}

export interface CemeteryKeyFactsProps {
  stats: CemeteryStats;
  datasetMeta: CemeteryKeyFactsDatasetMeta;
}

interface FactCell {
  key: string;
  label: string;
  value: ReactNode;
  detail: ReactNode;
}

/**
 * Hairlines between cells, by position among the visible cells: a 2 × 2 grid
 * below `md`, one row from `md`.
 */
const CELL_POSITION_CLASSES = [
  "",
  "border-l",
  "border-t md:border-t-0 md:border-l",
  "border-l border-t md:border-t-0",
] as const;

const NOT_RECORDED_VALUE = (
  <>
    <span aria-hidden="true">—</span>
    <span className="sr-only">not recorded</span>
  </>
);

function formatRecordedAt(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return formatUtcDayLabel(new Date(Date.UTC(year, month - 1, day)));
}

function trailingDetail(stats: CemeteryStats): string {
  const { trailing12, prior12 } = stats.keyFacts;
  const tracked =
    trailing12.tracked === 0
      ? "None of these were coins Pharos tracked live"
      : trailing12.tracked === 1
        ? "1 of these was a coin Pharos tracked live"
        : `${trailing12.tracked} of these were coins Pharos tracked live`;
  const prior = prior12.tracked === 0 ? "none" : String(prior12.tracked);
  return `${tracked} (${prior} in the prior ${prior12.months} months). Curated records: ${trailing12.curated} vs ${prior12.curated}.`;
}

function buildCells(stats: CemeteryStats): FactCell[] {
  const { trailing12, topTwo, medianPeak, atLeastOneBillionCount, trackedCount } = stats.keyFacts;
  const cells: FactCell[] = [
    {
      key: "trailing",
      label: `${trailing12.months} months to ${stats.asOf.monthLabel}`,
      value: trailing12.total,
      detail: trailingDetail(stats),
    },
  ];

  if (topTwo) {
    cells.push({
      key: "top-two",
      label: "Held by two coins",
      value: formatPercentFromRatio(topTwo.share, 1),
      detail: `${topTwo.symbols[0]} and ${topTwo.symbols[1]}: ${formatCemeteryPeak(topTwo.sum)} of ${formatCemeteryPeak(topTwo.recordedTotal)} combined peak (${topTwo.knownCount} of ${topTwo.total} recorded).`,
    });
  }

  cells.push({
    key: "median",
    label: "Median peak",
    value: medianPeak.value === null ? NOT_RECORDED_VALUE : formatCemeteryPeak(medianPeak.value),
    detail:
      medianPeak.value === null
        ? "No record has a recorded peak market cap."
        : `Half of the recorded deaths peaked below this. ${atLeastOneBillionCount} peaked at ${CEMETERY_PEAK_BUCKET_LABELS["1b-plus"]}.`,
  });

  const recordsNoun = trackedCount === 1 ? "record" : "records";
  cells.push({
    key: "tracked",
    label: "Tracked before death",
    value: trackedCount,
    detail: (
      <>
        Monitored live, then frozen. Archived pages stay online.
        {trackedCount > 0 ? (
          <>
            {" "}
            <Link href={buildRegisterHref({ record: "tracked" })} className="pharos-prose-link text-foreground/85">
              Show the {trackedCount} tracked-archive {recordsNoun} in the register
            </Link>
          </>
        ) : null}
      </>
    ),
  });

  return cells;
}

/** Four neutral figures under the hero; each fact here has no other home on the page. */
export function CemeteryKeyFacts({ stats, datasetMeta }: CemeteryKeyFactsProps) {
  const cells = buildCells(stats);
  // `updatedAt` is the latest record's `recordedAt`, when a record was last added; the checksum identifies the revision.
  const rail = [
    stats.updatedAt ? `Latest record added ${formatRecordedAt(stats.updatedAt)}` : null,
    `Latest recorded death ${stats.asOf.label}`,
    `Dataset schema ${datasetMeta.schemaVersion}`,
  ].filter((part): part is string => part !== null);

  return (
    <section id="key-facts" aria-labelledby="key-facts-heading" className="scroll-mt-24">
      <h2 id="key-facts-heading" className="sr-only">
        Key facts
      </h2>
      <div className="pharos-card-shell overflow-hidden">
        <dl className={cells.length === 4 ? "grid grid-cols-2 md:grid-cols-4" : "grid grid-cols-2 md:grid-cols-3"}>
          {cells.map((cell, index) => (
            <div
              key={cell.key}
              className={`${styles.fact} min-w-0 border-border/60 px-4 py-4 md:px-5 md:py-5 ${CELL_POSITION_CLASSES[index]} ${cells.length === 3 && index === 2 ? "col-span-2 md:col-span-1" : ""}`}
            >
              <dt className="pharos-kicker">{cell.label}</dt>
              <dd className="pharos-numeric text-[1.35rem] font-semibold leading-tight text-foreground md:text-[1.75rem]">
                {cell.value}
              </dd>
              <dd className="pharos-meta">{cell.detail}</dd>
            </div>
          ))}
        </dl>
        <p className="pharos-numeric border-t border-border/60 px-4 py-2.5 text-[11px] uppercase tracking-[0.08em] text-muted-foreground md:px-5">
          {/* Each fact stays on one line; a wrap falls only after a separator. */}
          {rail.map((part) => (
            <Fragment key={part}>
              <span className="whitespace-nowrap">{part}</span>
              {"\u00a0· "}
            </Fragment>
          ))}
          <span className="whitespace-nowrap">
            checksum <span className="normal-case">{datasetMeta.sourceChecksumShort}</span>
          </span>
        </p>
      </div>
    </section>
  );
}
