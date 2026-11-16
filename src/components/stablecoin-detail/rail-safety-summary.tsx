"use client";

import { FigureLeadText } from "./figure-lead-text";
import Link from "next/link";
import { IntentLink } from "@/components/intent-link";
import { ArrowUpRight } from "lucide-react";
import { getSafetyGradeMetadata } from "@/lib/report-card-ui";
import { cn } from "@/lib/utils";
import type { ReportCardGrade } from "@shared/types/report-card-grade";
import type { HeroSignalRailItem } from "./hero-card-metrics";
import { DETAIL_MODULE_TITLE_CLASS } from "@/components/stablecoin-detail/section-title-class";
import type { V9ConsumerCard } from "@/lib/safety-score-v9-consumers";
import { buildSafetyVerdictLine } from "@/lib/stablecoin-detail-hero-metrics";
import { scoreToGrade } from "@shared/lib/report-card-core";

const PILLAR_ROWS = [
  { key: "backing", label: "Backing" },
  { key: "exit", label: "Exit" },
  { key: "control", label: "Economic Control" },
] as const;

/**
 * The three pillars as compact bars: the grade's decomposition at a glance,
 * each bar in its own grade's color with the score and letter beside it.
 */
function RailPillarBars({ card }: { card: V9ConsumerCard }) {
  return (
    <ul className="mt-3 space-y-1.5" aria-label="Safety Score pillars">
      {PILLAR_ROWS.map(({ key, label }) => {
        const score = card.pillars[key]?.score;
        if (score == null || !Number.isFinite(score)) {
          return (
            <li key={key} className="grid grid-cols-[6.5rem_minmax(0,1fr)_2.75rem] items-center gap-2 text-xs">
              <span className="text-muted-foreground">{label}</span>
              <span className="h-1.5 rounded-full border border-dashed border-border" aria-hidden="true" />
              <span className="text-right text-muted-foreground">—</span>
            </li>
          );
        }
        const grade = scoreToGrade(score);
        const meta = getSafetyGradeMetadata(grade);
        return (
          <li key={key} className="grid grid-cols-[6.5rem_minmax(0,1fr)_2.75rem] items-center gap-2 text-xs">
            <span className="text-muted-foreground">{label}</span>
            <span className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
              <span className={cn("block h-full rounded-full", meta.barClassName)} style={{ width: `${Math.max(2, Math.min(100, score))}%` }} />
            </span>
            <span className="flex items-baseline justify-end gap-1">
              <span className="pharos-numeric font-semibold text-foreground">{Math.round(score)}</span>
              <span className={cn("pharos-numeric text-2xs font-semibold", meta.pulse.accentClassName)}>{grade}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** The grade's one reason (binding cap, else weakest pillar), in words. */
function RailVerdict({ card }: { card: V9ConsumerCard }) {
  const line = buildSafetyVerdictLine(card);
  if (!line) return null;
  return (
    <p className="mt-2 text-xs leading-snug" data-safety-verdict-line>
      <span className="font-medium text-foreground">{line.lead}</span>
      <span aria-hidden="true" className="text-muted-foreground/60"> · </span>
      <span className="text-muted-foreground">{line.detail}</span>
    </p>
  );
}

/** The signal view models render a missing value as an em dash. */
const UNAVAILABLE = "—";

/**
 * A signal row earns its place with a reading: a pending read keeps its
 * placeholder, but a row with no value (DEWS on a NAV token or a frozen
 * archive, a missing liquidity score) or a NAV token's "NAV" peg, which
 * only restates that the peg check does not apply, is left out.
 */
function hasSignalReading(item: HeroSignalRailItem, navToken: boolean): boolean {
  if (item.pending) return true;
  if (item.primary === UNAVAILABLE || item.primary === "") return false;
  return !(item.key === "peg" && navToken);
}

/**
 * Compact safety summary for the detail right rail (Figma coin template):
 * inline "B+ · 72/100" grade line over hairline-divided mono rows
 * (PEG / LIQUIDITY / DEWS). Reuses the hero signals-rail view models; the
 * hero hides its inline copy at xl+ where this card takes over.
 *
 * Without a published grade the headline is words, never a display-size dash:
 * "Not scored", or "Frozen · not scored" for a frozen archive.
 */
export function RailSafetySummary({
  items,
  navToken = false,
  frozen = false,
  gradeRead = "settled",
  liveAsOf = null,
  card = null,
}: {
  /** The live card: its binding cap or weakest pillar is the grade's one-line reason, its pillars the bars. */
  card?: V9ConsumerCard | null;
  items: HeroSignalRailItem[];
  /** NAV tokens have no peg reading: their "NAV" peg row is left out. */
  navToken?: boolean;
  /** Frozen archives are no longer scored. */
  frozen?: boolean;
  /**
   * The report-card read behind the grade. "Not scored" is a finding, so it
   * needs a settled read: a first fetch in flight shows a placeholder and a
   * failed read says the grade is unavailable.
   */
  gradeRead?: "settled" | "pending" | "failed";
  /**
   * The live card's own clock ("as of 2026-11-14 22:03 UTC"). The dated line
   * holds its height in both graded states, so the modules below never move
   * when the live card lands.
   */
  liveAsOf?: string | null;
}) {
  const [hero, ...signals] = items;
  if (!hero) return null;
  const rest = signals.filter((item) => hasSignalReading(item, navToken));

  const graded = hero.primary !== UNAVAILABLE;
  const gradeClass = graded
    ? getSafetyGradeMetadata(hero.primary as ReportCardGrade).pulse.accentClassName
    : "text-muted-foreground";

  return (
    <div className="pharos-card-shell p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className={DETAIL_MODULE_TITLE_CLASS}>Safety Score</h2>
        <Link
          href="#report-card"
          prefetch={false}
          aria-label="Jump to the full safety report card"
          className="pharos-focus-ring flex h-6 w-6 items-center justify-center rounded-md border border-border/60 text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
        </Link>
      </div>
      {graded ? (
        <Link
          href={hero.href}
          prefetch={false}
          className="pharos-focus-ring mt-2.5 inline-flex items-baseline gap-2 rounded-md"
        >
          <span className={cn("pharos-numeric text-5xl font-extrabold leading-none tracking-tight", gradeClass)}>
            {hero.primary}
          </span>
          {hero.secondary ? (
            <span className="font-mono text-base text-muted-foreground">· {hero.secondary}</span>
          ) : null}
        </Link>
      ) : gradeRead === "pending" && !frozen ? (
        <div className="mt-2.5" role="status" aria-label="Loading Safety Score" data-safety-state="loading">
          <span aria-hidden="true" className="block h-12 w-28 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
        </div>
      ) : gradeRead === "failed" && !frozen ? (
        <p className="mt-2.5 text-lg font-semibold leading-tight text-muted-foreground" data-safety-state="unavailable">
          Grade unavailable
        </p>
      ) : (
        <p className="mt-2.5 flex items-baseline gap-1.5" data-safety-state={frozen ? "frozen" : "not-scored"}>
          <span className="text-lg font-semibold leading-tight text-foreground">
            {frozen ? "Frozen" : "Not scored"}
          </span>
          {frozen ? <span className="text-sm text-muted-foreground">· not scored</span> : null}
        </p>
      )}
      {graded ? (
        // One dated line under the grade in either state: the saved release
        // names its date, the live card its own clock. The row reserves the
        // text-2xs line height even without a stamp, so the cards below the
        // rail summary never shift when the live card replaces the saved one.
        <p className="mt-1 min-h-4 text-2xs text-muted-foreground" data-safety-state={hero.note ? "saved" : "live"}>
          {hero.note ?? liveAsOf ?? null}
        </p>
      ) : null}
      {graded && card ? <RailVerdict card={card} /> : null}
      {graded && card && card.ratingStatus === "rated" ? <RailPillarBars card={card} /> : null}
      {rest.length > 0 ? (
        <div className="mt-3 divide-y divide-border/40 border-t border-border/40">
          {rest.map((item) => (
            <IntentLink
              key={item.key}
              href={item.href}
              className="pharos-focus-ring flex items-baseline justify-between gap-3 rounded-sm py-2 transition-colors hover:text-foreground"
            >
              <span className="pharos-label">
                {item.label}
              </span>
              <span className="flex items-baseline gap-1.5">
                {item.pending ? (
                  <span aria-hidden="true" className="block h-4 w-10 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
                ) : (
                  <span className={cn("pharos-numeric text-sm font-semibold", item.colorClass)}>
                    {item.primary}
                  </span>
                )}
                {item.secondary ? (
                  <span className="text-xs text-muted-foreground">· <FigureLeadText text={item.secondary} /></span>
                ) : null}
              </span>
            </IntentLink>
          ))}
        </div>
      ) : null}
    </div>
  );
}
