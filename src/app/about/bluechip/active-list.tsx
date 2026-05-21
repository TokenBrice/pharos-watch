"use client";

import Link from "next/link";
import { useBluechipRatings, useReportCards } from "@/hooks/api-hooks";
import { GRADE_ORDER } from "@/lib/bluechip";
import { getReportCardGradeRank } from "@shared/lib/report-card-core";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";

/**
 * Coins that currently hold both an A-tier external Bluechip rating and an
 * A-tier Pharos report-card grade. The intersection prevents this page from
 * presenting Bluechip's external rating as if it were Pharos's floor result.
 */
const BLUECHIP_ACTIVE_ORDER_FLOOR = 10;
const PHAROS_ACTIVE_GRADE_FLOOR = getReportCardGradeRank("A-") ?? 0;

function gradeBucket(order: number): string {
  return order >= BLUECHIP_ACTIVE_ORDER_FLOOR ? "Top tier" : "Other";
}

export function BluechipActiveList() {
  const { data: ratingsMap, isLoading, error } = useBluechipRatings();
  const {
    data: reportCardsData,
    isLoading: reportCardsLoading,
    error: reportCardsError,
  } = useReportCards();

  if (isLoading || reportCardsLoading) {
    return (
      <p className="font-mono text-xs uppercase tracking-[0.08em] text-muted-foreground">
        Loading active Bluechip roster…
      </p>
    );
  }

  if (error || reportCardsError || !ratingsMap || !reportCardsData) {
    return (
      <p className="font-mono text-xs uppercase tracking-[0.08em] text-muted-foreground">
        Bluechip roster temporarily unavailable.
      </p>
    );
  }

  const reportCardById = new Map(reportCardsData.cards.map((card) => [card.id, card]));
  const active = Object.entries(ratingsMap)
    .map(([stablecoinId, rating]) => {
      const meta = CLIENT_TRACKED_META_BY_ID.get(stablecoinId);
      const order = GRADE_ORDER[rating.grade] ?? 0;
      const reportCard = reportCardById.get(stablecoinId);
      const pharosGradeRank = getReportCardGradeRank(reportCard?.overallGrade);
      return { stablecoinId, rating, meta, order, reportCard, pharosGradeRank };
    })
    .filter(
      (entry) =>
        entry.order >= BLUECHIP_ACTIVE_ORDER_FLOOR &&
        entry.meta &&
        entry.pharosGradeRank != null &&
        entry.pharosGradeRank >= PHAROS_ACTIVE_GRADE_FLOOR,
    )
    .sort((a, b) => {
      if ((b.pharosGradeRank ?? 0) !== (a.pharosGradeRank ?? 0)) {
        return (b.pharosGradeRank ?? 0) - (a.pharosGradeRank ?? 0);
      }
      if (b.order !== a.order) return b.order - a.order;
      return (a.meta?.name ?? "").localeCompare(b.meta?.name ?? "");
    });

  if (active.length === 0) {
    return (
      <p className="font-mono text-xs uppercase tracking-[0.08em] text-muted-foreground">
        No coins currently clear every Bluechip floor.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <p className="font-mono text-xs uppercase tracking-[0.08em] text-muted-foreground">
        {active.length} {active.length === 1 ? "asset" : "assets"} · {gradeBucket(active[0]!.order)}
      </p>
      <ul className="divide-y divide-border/60 border-y border-border/60">
        {active.map(({ stablecoinId, rating, meta, reportCard }) => {
          if (!meta) return null;
          return (
            <li
              key={stablecoinId}
              className="grid gap-1 py-3 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto] sm:items-baseline sm:gap-6"
            >
              <Link
                href={`/stablecoin/${stablecoinId}/`}
                className="pharos-focus-ring inline-flex items-baseline gap-2 rounded-sm text-foreground hover:underline hover:underline-offset-4"
              >
                <span className="text-sm font-semibold tracking-tight">{meta.name}</span>
                <span className="font-mono text-xs text-muted-foreground">{meta.symbol}</span>
              </Link>
              <span className="font-mono text-sm font-semibold text-emerald-700 dark:text-emerald-400">
                Pharos {reportCard?.overallGrade}
              </span>
              <span className="font-mono text-sm font-semibold text-emerald-700 dark:text-emerald-400">
                Bluechip {rating.grade}
              </span>
              <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-muted-foreground">
                since {rating.dateOfRating?.slice(0, 7) ?? "—"}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Roster refreshed from the Bluechip rating sync and Pharos report cards. A coin must remain
        A-tier in both systems to stay in this editorial roster.
      </p>
    </div>
  );
}
