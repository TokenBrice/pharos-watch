import Link from "next/link";
import { Fragment, type CSSProperties, type ReactNode } from "react";
import { CAUSE_META, type CauseOfDeath } from "@shared/lib/cause-of-death";
import { CAUSE_BG_CLASS, causeColorVars } from "@/lib/cemetery-cause-style";
import { buildRegisterHref, cemeteryCauseAnchor } from "@/lib/cemetery-selection";
import { formatCemeteryPeak, type CemeteryCauseStats, type CemeteryStats } from "@/lib/cemetery-stats";
import styles from "./cemetery-below-fold.module.css";
import { CemeterySectionHeader } from "./cemetery-section-header";

export interface CemeteryCausesProps {
  stats: CemeteryStats;
}

const ALGORITHMIC_MECHANISM_HREF = "/learn/mechanisms/algorithmic/";

/** Whole-percent share; a non-zero share that rounds to 0 prints "<1%". */
function formatShare(ratio: number): string {
  if (ratio > 0 && ratio < 0.005) return "<1%";
  return `${Math.round(ratio * 100)}%`;
}

interface StripSegment {
  cause: CauseOfDeath;
  ratio: number;
  /** Label printed inside a wide segment. */
  full: string;
  /** Label printed inside a medium segment. */
  short: string;
}

/**
 * Container-query label visibility per row: a label prints only when its
 * segment is wide enough to hold it, never truncated. Narrow segments rely on
 * the cause columns below, which print every figure.
 */
const STRIP_LABEL_CLASSES = {
  deaths: {
    full: "hidden @min-[4.75rem]:inline",
    short: "hidden @min-[2.75rem]:inline @min-[4.75rem]:hidden",
  },
  peak: {
    full: "hidden @min-[6.5rem]:inline",
    short: "hidden @min-[2.75rem]:inline @min-[6.5rem]:hidden",
  },
} as const;

const STRIP_LABEL_BASE =
  "pharos-numeric ml-1 whitespace-nowrap rounded-sm bg-background/90 px-1 text-[10px] font-medium leading-4 text-foreground";

function ShareBar({ kind, label, segments }: { kind: keyof typeof STRIP_LABEL_CLASSES; label: string; segments: StripSegment[] }) {
  const labelClasses = STRIP_LABEL_CLASSES[kind];
  return (
    <div role="img" aria-label={label} className="flex h-7 w-full gap-[2px] overflow-hidden rounded-md">
      {segments
        .filter((segment) => segment.ratio > 0)
        .map((segment) => (
          <span
            key={segment.cause}
            data-cause={segment.cause}
            className={`@container flex min-w-0 basis-0 grow-[var(--segment-share)] items-center ${CAUSE_BG_CLASS}`}
            style={{ ...causeColorVars(segment.cause), "--segment-share": String(segment.ratio) } as CSSProperties}
          >
            <span className={`${STRIP_LABEL_BASE} ${labelClasses.full}`}>{segment.full}</span>
            <span className={`${STRIP_LABEL_BASE} ${labelClasses.short}`}>{segment.short}</span>
          </span>
        ))}
    </div>
  );
}

function StripRow({ title, detail, children }: { title: string; detail: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5 md:grid-cols-[minmax(0,17rem)_minmax(0,1fr)] md:items-center md:gap-4">
      <p className="text-sm leading-snug">
        <span className="font-medium text-foreground">{title}</span>
        <span className="text-muted-foreground"> · {detail}</span>
      </p>
      {children}
    </div>
  );
}

function PairedShareStrip({ stats }: { stats: CemeteryStats }) {
  const { causes, total, peak } = stats;
  const deathsSegments: StripSegment[] = causes.map((c) => {
    const pct = formatShare(c.share);
    return { cause: c.cause, ratio: c.share, full: `${c.count} · ${pct}`, short: pct };
  });
  const deathsLabel = `Share of deaths by cause, ${total} records: ${causes
    .map((c) => `${CAUSE_META[c.cause].label} ${c.count} (${formatShare(c.share)})`)
    .join("; ")}.`;

  const recordedTotal = peak.recordedTotal;
  const peakDetail =
    recordedTotal === null
      ? `not recorded for any of the ${total} records`
      : `${formatCemeteryPeak(recordedTotal)} (${peak.knownCount} of ${total} recorded)`;
  const peakSegments: StripSegment[] = causes.map((c) => {
    const ratio = c.peakShare ?? 0;
    const pct = formatShare(ratio);
    return {
      cause: c.cause,
      ratio,
      full: c.recordedPeakSum === null ? pct : `${formatCemeteryPeak(c.recordedPeakSum)} · ${pct}`,
      short: pct,
    };
  });
  const peakLabel =
    recordedTotal === null
      ? ""
      : `Share of recorded peak market cap by cause, ${formatCemeteryPeak(recordedTotal)} across ${peak.knownCount} of ${total} records: ${causes
          .map((c) =>
            c.count === 0
              ? `${CAUSE_META[c.cause].label} no records`
              : c.recordedPeakSum === null || c.peakShare === null
                ? `${CAUSE_META[c.cause].label} not recorded`
                : `${CAUSE_META[c.cause].label} ${formatCemeteryPeak(c.recordedPeakSum)} (${formatShare(c.peakShare)})`,
          )
          .join("; ")}.`;

  return (
    <div className="space-y-3 px-4 py-4 md:px-5">
      <StripRow title="Share of deaths" detail={`${total} ${total === 1 ? "record" : "records"}`}>
        <ShareBar kind="deaths" label={deathsLabel} segments={deathsSegments} />
      </StripRow>
      <StripRow title="Share of recorded peak market cap" detail={peakDetail}>
        {recordedTotal === null ? (
          <p className="pharos-meta">No peak market cap is recorded.</p>
        ) : (
          <ShareBar kind="peak" label={peakLabel} segments={peakSegments} />
        )}
      </StripRow>
    </div>
  );
}

function sharesParts(c: CemeteryCauseStats): string[] {
  if (c.count === 0) return ["0% of deaths"];
  return [`${formatShare(c.share)} of deaths`, c.peakShare === null ? "peak not recorded" : `${formatShare(c.peakShare)} of recorded peak`];
}

function peakParts(c: CemeteryCauseStats): string[] {
  if (c.count === 0) return ["No records"];
  if (c.knownCount === 0) return ["No recorded peak", `${c.unrecordedCount} not recorded`];
  const parts = [c.medianPeak === null ? "Median peak not recorded" : `Median peak ${formatCemeteryPeak(c.medianPeak)}`];
  if (c.largest) parts.push(`largest ${c.largest.symbol} ${formatCemeteryPeak(c.largest.peak)}`);
  if (c.unrecordedCount > 0) parts.push(`${c.unrecordedCount} not recorded`);
  return parts;
}

/** " · "-joined phrases that wrap only after a separator, never inside a figure. */
function PhraseList({ parts }: { parts: string[] }) {
  return parts.map((part, index) => (
    <Fragment key={part}>
      {index > 0 ? <span className={styles.phraseSeparator}>{"\u00a0· "}</span> : null}
      <span className={`${styles.phrase} whitespace-nowrap`}>{part}</span>
    </Fragment>
  ));
}

function CauseColumn({ causeStats }: { causeStats: CemeteryCauseStats }) {
  const { cause, count } = causeStats;
  const meta = CAUSE_META[cause];
  return (
    <li
      id={cemeteryCauseAnchor(cause)}
      className={`${styles.causeColumn} relative min-w-0 scroll-mt-24 px-4 pb-5 pt-5 md:px-5 lg:border-l lg:border-border/60 lg:first:border-l-0`}
      style={causeColorVars(cause)}
    >
      <div aria-hidden="true" className={`absolute inset-x-0 top-0 h-[3px] ${CAUSE_BG_CLASS}`} />
      <h3 className="text-sm font-semibold text-foreground">{meta.label}</h3>
      <p className="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="pharos-numeric text-xl font-semibold leading-none text-foreground">{count}</span>
        <span className="sr-only"> {count === 1 ? "record" : "records"}, </span>
        <span className="pharos-numeric text-[11px] text-muted-foreground">
          <PhraseList parts={sharesParts(causeStats)} />
        </span>
      </p>
      <p className="mt-2 hidden text-[13px] leading-relaxed text-foreground/80 md:block">{meta.definition}</p>
      <details className="group mt-2 md:hidden">
        <summary className="pharos-focus-ring -my-1.5 w-fit cursor-pointer rounded-sm py-1.5 text-xs text-muted-foreground hover:text-foreground">
          Definition
        </summary>
        <p className="mt-1.5 text-[13px] leading-relaxed text-foreground/80">{meta.definition}</p>
      </details>
      <p className="pharos-numeric mt-2 text-[11px] leading-relaxed text-muted-foreground">
        <PhraseList parts={peakParts(causeStats)} />
      </p>
      {count > 0 || cause === "algorithmic-failure" ? (
        <p className="mt-3 flex flex-col items-start gap-1.5 text-[13px]">
          {count > 0 ? (
            <Link href={buildRegisterHref({ cause })} className="pharos-prose-link text-foreground/85">
              Show {count} in the register
            </Link>
          ) : null}
          {cause === "algorithmic-failure" ? (
            <Link href={ALGORITHMIC_MECHANISM_HREF} className="pharos-prose-link text-foreground/85">
              How algorithmic designs fail <span aria-hidden="true">→</span>
            </Link>
          ) : null}
        </p>
      ) : null}
    </li>
  );
}

/** "How stablecoins die": paired share strip plus one column per cause, the home of cause counts and shares. */
export function CemeteryCauses({ stats }: CemeteryCausesProps) {
  const pattern = stats.patterns.find((p) => p.key === "abandoned-most-common");
  return (
    <section id="causes" aria-labelledby="causes-heading" className="scroll-mt-24 space-y-3">
      <CemeterySectionHeader
        id="causes-heading"
        kicker="Causes of death"
        title="How stablecoins die"
        meta="Each record carries one primary cause. Most deaths are small; most of the recorded peak market cap sits in a few large failures."
      />
      <div className="pharos-card-shell overflow-hidden">
        {pattern ? (
          <div className="border-b border-border/60 px-4 py-3 md:px-5">
            <p className="text-sm font-semibold text-foreground">{pattern.headline}</p>
            <p className="pharos-meta mt-0.5">
              {pattern.body}{" "}
              <Link href={buildRegisterHref(pattern.registerFilter)} className="pharos-prose-link">
                Show these records in the register
              </Link>
            </p>
          </div>
        ) : null}
        <PairedShareStrip stats={stats} />
        <ul role="list" className="grid border-t border-border/60 lg:grid-cols-5">
          {stats.causes.map((causeStats) => (
            <CauseColumn key={causeStats.cause} causeStats={causeStats} />
          ))}
        </ul>
      </div>
    </section>
  );
}
