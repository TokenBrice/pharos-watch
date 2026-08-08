"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { getSafetyGradeMetadata } from "@/lib/report-card-ui";
import { cn } from "@/lib/utils";
import type { ReportCardGrade } from "@shared/types";
import type { HeroSignalRailItem } from "./hero-card-metrics";
import { DETAIL_MODULE_TITLE_CLASS } from "@/components/stablecoin-detail/section-title-class";

/**
 * Compact safety summary for the detail right rail (Figma coin template):
 * inline "B+ · 72/100" grade line over hairline-divided mono rows
 * (PEG / LIQUIDITY / DEWS). Reuses the hero signals-rail view models; the
 * hero hides its inline copy at xl+ where this card takes over.
 */
export function RailSafetySummary({ items }: { items: HeroSignalRailItem[] }) {
  const [hero, ...rest] = items;
  if (!hero) return null;

  const gradeClass =
    hero.primary !== "—"
      ? getSafetyGradeMetadata(hero.primary as ReportCardGrade).pulse.accentClassName
      : "text-muted-foreground";

  return (
    <div className="pharos-card-shell p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className={DETAIL_MODULE_TITLE_CLASS}>Safety</h2>
        <Link
          href="#report-card"
          aria-label="Jump to the full safety report card"
          className="pharos-focus-ring flex h-6 w-6 items-center justify-center rounded-md border border-border/60 text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
        </Link>
      </div>
      <Link
        href={hero.href}
        className="pharos-focus-ring mt-2.5 inline-flex items-baseline gap-2 rounded-md"
      >
        <span className={cn("pharos-numeric text-5xl font-extrabold leading-none tracking-tight", gradeClass)}>
          {hero.primary}
        </span>
        {hero.secondary ? (
          <span className="font-mono text-base text-muted-foreground">· {hero.secondary}</span>
        ) : null}
      </Link>
      <div className="mt-3 divide-y divide-border/40 border-t border-border/40">
        {rest.map((item) => (
          <Link
            key={item.key}
            href={item.href}
            className="pharos-focus-ring flex items-baseline justify-between gap-3 rounded-sm py-2 transition-colors hover:text-foreground"
          >
            <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
              {item.label}
            </span>
            <span className="flex items-baseline gap-1.5">
              <span className={cn("pharos-numeric text-sm font-semibold", item.colorClass)}>
                {item.primary}
              </span>
              {item.secondary ? (
                <span className="font-mono text-[10px] uppercase text-muted-foreground">· {item.secondary}</span>
              ) : null}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
