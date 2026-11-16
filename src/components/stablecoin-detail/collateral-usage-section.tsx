"use client";

import { createContext, useMemo, useState } from "react";
import Link from "next/link";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { SafetyGradeBadge } from "@/components/safety-scores/safety-grade-badge";
import { ShowAllToggle } from "@/components/stablecoin-detail/disclosure-toggles";
import { logosById } from "@/lib/logos";
import { formatCompactUsd } from "@shared/lib/format";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { getVariantAccessibleLabel } from "@shared/lib/variant-display";
import type { ReportCardsV9DependencyEdge } from "@shared/types/report-cards-v9";
import type { DependencyType } from "@shared/types/dependency-types";
import type { ReportCardGrade } from "@shared/types/report-card-grade";
import type { VariantKind } from "@shared/types/stablecoin-taxonomy";
import { DEPENDENCY_RELATIONSHIP_LABELS } from "@shared/lib/classification";
import { DETAIL_MODULE_TITLE_CLASS } from "@/components/stablecoin-detail/section-title-class";
import { formatDependencyShare } from "./dependency-context-model";

export interface PublishedCollateralUsageEntry {
  coin: { id: string; name: string; symbol: string };
  edgeType: ReportCardsV9DependencyEdge["kind"];
  relationshipType: DependencyType | "serial-claim";
  weight: number | null;
  marketCap: number | null;
  /** The counterparty's published Safety grade; undefined when it has no card. */
  grade?: ReportCardGrade | null;
  /** Set when the dependent is a tracked variant of this coin ("Savings", "Strategy vault"). */
  variantKind?: VariantKind;
}

/**
 * Ids Dependency context already ranks ("Used by" and the depends-on list).
 * The variant cards beside them leave those rows out, so a token appears in
 * one list only; outside Dependency context the set is empty.
 */
export const ListedDependencyIdsContext = createContext<ReadonlySet<string>>(new Set());

const PREVIEW_COUNT = 8;

/** "Savings variant" → "Savings": the list heading already says Variants. Neutral text, not a category color. */
export function variantKindLabel(kind: VariantKind): string {
  return getVariantAccessibleLabel(kind).replace(/ variant$/, "");
}

/**
 * Role and share as one phrase: "Collateral · 64.3% of backing", or the bare
 * role for a serial claim, with the variant kind when the dependent is one of
 * this coin's variants ("Wrapper · Savings").
 */
export function dependencyRoleDetail(
  entry: Pick<PublishedCollateralUsageEntry, "edgeType" | "relationshipType" | "weight" | "variantKind">,
): string {
  const role = DEPENDENCY_RELATIONSHIP_LABELS[entry.relationshipType];
  if (entry.edgeType !== "basket") return entry.variantKind ? `${role} · ${variantKindLabel(entry.variantKind)}` : role;
  if (entry.weight === null) return `${role} · share unknown`;
  // A zero basket share is not a publishable link; keep the row, not a "0%".
  if (entry.weight === 0) return `${role} · share n/a`;
  return `${role} · ${formatDependencyShare(entry.weight)} of backing`;
}

/** A serial claim is a full claim; a basket link carries its published share. */
export function dependencyEntryShare(entry: Pick<PublishedCollateralUsageEntry, "edgeType" | "weight">): number | null {
  if (entry.edgeType === "serial") return 1;
  return entry.weight === null || entry.weight === 0 ? null : entry.weight;
}

function GradeChip({ grade }: { grade: ReportCardGrade | null }) {
  return grade === null ? (
    <span className="inline-flex w-9 justify-center text-xs text-muted-foreground" title="No published Safety grade">–</span>
  ) : (
    <SafetyGradeBadge grade={grade} size="xs" className="min-w-9 justify-center" />
  );
}

/**
 * One ranked dependency row: logo, ticker, role phrase, an optional figure and
 * grade, and an optional neutral bar under the name. `barFraction` null draws a
 * dashed track (unknown), never an empty fill.
 */
export function DependencyRow({ id, name, symbol, detail, value, barFraction, grade, ariaLabel }: {
  id: string;
  name: string;
  symbol: string;
  detail: string;
  /** undefined: no figure column; null: unavailable ("–"). */
  value?: string | null;
  barFraction?: number | null;
  grade?: ReportCardGrade | null;
  ariaLabel: string;
}) {
  const hasTrailing = value !== undefined || grade !== undefined;
  return (
    <li>
      <Link
        href={buildStablecoinUrl(id)}
        aria-label={ariaLabel}
        title={name}
        className="pharos-focus-ring flex min-h-10 items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/40"
      >
        <StablecoinLogo src={logosById[id]} name={name} size={20} />
        <span className="min-w-0 flex-1 space-y-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-sm font-medium text-foreground">{symbol}</span>
            <span className="text-xs text-muted-foreground">{detail}</span>
          </span>
          {barFraction === undefined ? null : barFraction === null ? (
            <span aria-hidden="true" className="block h-0 border-t border-dashed border-border" />
          ) : (
            <span aria-hidden="true" className="block h-1 overflow-hidden rounded-full bg-muted">
              <span
                className="block h-full rounded-full bg-foreground/40"
                style={{ width: `${barFraction > 0 ? Math.max(barFraction * 100, 1) : 0}%` }}
              />
            </span>
          )}
        </span>
        {/* A fixed trailing width keeps figures, grades and bar ends aligned across rows. */}
        {hasTrailing ? (
          <span className="flex w-28 shrink-0 items-center justify-end gap-2.5">
            {value === undefined ? null : (
              <span className={value === null ? "font-mono text-sm text-muted-foreground" : "font-mono text-sm tabular-nums text-foreground"}>
                {value ?? "–"}
              </span>
            )}
            {grade === undefined ? null : <GradeChip grade={grade} />}
          </span>
        ) : null}
      </Link>
    </li>
  );
}

export function dependencyRowAriaLabel(symbol: string, detail: string, extras: readonly (string | null)[]): string {
  return [symbol, detail.replace(" · ", ", "), ...extras].filter((part): part is string => part !== null).join(", ");
}

/**
 * "Used by": every published dependent, ranked by known exposure (market cap
 * times the share of its backing held in this coin). Unknown exposure ranks
 * last and draws a dashed bar instead of a zero.
 */
export function CollateralUsageSection({ entries, symbol }: { entries: readonly PublishedCollateralUsageEntry[]; symbol: string }) {
  const rows = useMemo(() => entries.map((entry) => {
    const share = dependencyEntryShare(entry);
    const exposure = share === null || entry.marketCap === null ? null : share * entry.marketCap;
    return { entry, share, exposure };
  }).sort((a, b) => {
    if (a.exposure === null && b.exposure !== null) return 1;
    if (b.exposure === null && a.exposure !== null) return -1;
    return (b.exposure ?? 0) - (a.exposure ?? 0)
      || (b.share ?? -1) - (a.share ?? -1)
      || a.entry.coin.symbol.localeCompare(b.entry.coin.symbol);
  }), [entries]);
  const [showAll, setShowAll] = useState(false);

  if (rows.length === 0) return null;

  const maxExposure = Math.max(0, ...rows.map((row) => row.exposure ?? 0));
  const visible = showAll ? rows : rows.slice(0, PREVIEW_COUNT);

  return (
    <section id="collateral-usage" aria-labelledby="collateral-usage-title" className="space-y-2">
      <div className="space-y-0.5">
        <h3 id="collateral-usage-title" className={DETAIL_MODULE_TITLE_CLASS}>
          Used by <span className="ml-1 font-mono font-normal tabular-nums">{rows.length}</span>
        </h3>
        <p className="text-xs text-muted-foreground">
          Ranked by known exposure (market cap × share backed by {symbol}).
        </p>
      </div>
      {/* -mx-2: the rows' hover fill bleeds while their content keeps the card's text edge. */}
      <ul className={showAll && rows.length > PREVIEW_COUNT ? "-mx-2 max-h-[30rem] space-y-0.5 overflow-y-auto" : "-mx-2 space-y-0.5"}>
        {visible.map(({ entry, exposure }) => {
          const detail = dependencyRoleDetail(entry);
          const value = exposure === null ? null : formatCompactUsd(exposure);
          return (
            <DependencyRow
              key={`${entry.coin.id}:${entry.edgeType}`}
              id={entry.coin.id}
              name={entry.coin.name}
              symbol={entry.coin.symbol}
              detail={detail}
              value={value}
              barFraction={maxExposure === 0 ? undefined : exposure === null ? null : exposure / maxExposure}
              grade={entry.grade}
              ariaLabel={dependencyRowAriaLabel(entry.coin.symbol, detail, [
                value === null ? "exposure unavailable" : `${value} known exposure`,
                entry.grade ? `Safety grade ${entry.grade}` : null,
              ])}
            />
          );
        })}
      </ul>
      {rows.length > PREVIEW_COUNT ? (
        <ShowAllToggle open={showAll} onToggle={() => setShowAll((prev) => !prev)} total={rows.length} noun="dependents" className="-ml-2.5" />
      ) : null}
    </section>
  );
}
