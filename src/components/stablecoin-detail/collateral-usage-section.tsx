"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { ShowAllToggle } from "@/components/stablecoin-detail/disclosure-toggles";
import { logosById } from "@/lib/logos";
import { buildStablecoinUrl } from "@shared/lib/urls";
import type { ReportCardsV9DependencyEdge } from "@shared/types/report-cards-v9";
import type { DependencyType } from "@shared/types";
import { DEPENDENCY_RELATIONSHIP_LABELS } from "@shared/lib/classification";
import { DETAIL_MODULE_TITLE_CLASS } from "@/components/stablecoin-detail/section-title-class";

export interface PublishedCollateralUsageEntry {
  coin: { id: string; name: string; symbol: string };
  edgeType: ReportCardsV9DependencyEdge["kind"];
  relationshipType: DependencyType | "serial-claim";
  weight: number | null;
  marketCap: number | null;
}

const PREVIEW_COUNT = 5;

function CollateralUsageItem({ entry }: { entry: PublishedCollateralUsageEntry }) {
  const share = entry.weight === null
    ? "share unknown"
    : entry.weight === 0
      ? "n/a"
      : entry.weight > 0 && entry.weight < 0.01
        ? "<1%"
        : `${Number((entry.weight * 100).toFixed(1))}%`;
  const relationshipLabel = DEPENDENCY_RELATIONSHIP_LABELS[entry.relationshipType];

  return (
    <Link
      href={buildStablecoinUrl(entry.coin.id)}
      aria-label={`${entry.coin.symbol} ${relationshipLabel}${entry.edgeType === "basket" ? ` ${share}` : ""}`}
      className="pharos-focus-ring flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors hover:bg-muted/40"
    >
      <StablecoinLogo src={logosById[entry.coin.id]} name={entry.coin.name} size={24} />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{entry.coin.symbol}</span>
      {entry.edgeType === "basket" ? (
        <span className="shrink-0 font-mono text-sm tabular-nums text-foreground">{share}</span>
      ) : null}
    </Link>
  );
}

export function CollateralUsageSection({ entries }: { entries: readonly PublishedCollateralUsageEntry[] }) {
  const usage = useMemo(() => [...entries].sort((a, b) => {
    if (a.edgeType !== b.edgeType) return a.edgeType === "basket" ? -1 : 1;
    const aValue = a.edgeType === "basket" ? a.weight : a.marketCap;
    const bValue = b.edgeType === "basket" ? b.weight : b.marketCap;
    if (aValue === null && bValue !== null) return 1;
    if (bValue === null && aValue !== null) return -1;
    return (bValue ?? 0) - (aValue ?? 0) || a.coin.id.localeCompare(b.coin.id);
  }), [entries]);
  const [showAll, setShowAll] = useState(false);

  if (usage.length === 0) return null;

  const needsCollapse = usage.length > PREVIEW_COUNT;
  const visible = showAll ? usage : usage.slice(0, PREVIEW_COUNT);
  const visibleGroups = [...visible.reduce((groups, entry) => {
    const label = DEPENDENCY_RELATIONSHIP_LABELS[entry.relationshipType];
    return groups.set(label, [...(groups.get(label) ?? []), entry]);
  }, new Map<string, PublishedCollateralUsageEntry[]>())];
  const relationshipCounts = Object.entries(DEPENDENCY_RELATIONSHIP_LABELS)
    .map(([kind, label]) => ({ label, count: usage.filter((entry) => entry.relationshipType === kind).length }))
    .filter(({ count }) => count > 0);

  return (
    <section id="collateral-usage" className="@container animate-in fade-in space-y-2.5 duration-300">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-2.5">
        <h3 className={DETAIL_MODULE_TITLE_CLASS}>
          Used by <span className="ml-1 font-normal text-muted-foreground tabular-nums">{usage.length}</span>
        </h3>
        {usage.length > 3 && relationshipCounts.length > 1 ? (
          <span className="pharos-meta">
            {relationshipCounts.map(({ label, count }) => `${count} ${label}`).join(" · ")}
          </span>
        ) : null}
      </div>
      <div className={showAll ? "max-h-96 overflow-y-auto" : undefined}>
        {/* The relationship tag heads each group once instead of repeating on every row. */}
        <div className="space-y-2">
          {visibleGroups.map(([label, groupEntries]) => (
            <div key={label} className="space-y-0.5">
              <p className="px-2.5 text-[10px] font-medium uppercase tracking-[0.06em] text-muted-foreground">{label}</p>
              <div className={usage.length <= 3
                ? "flex flex-col gap-0.5 sm:flex-row sm:flex-wrap sm:gap-4"
                : "grid grid-cols-1 gap-0.5 @lg:grid-cols-2 @3xl:grid-cols-3"}>
                {groupEntries.map((entry) => <CollateralUsageItem key={`${entry.coin.id}:${entry.edgeType}`} entry={entry} />)}
              </div>
            </div>
          ))}
        </div>
      </div>
      {needsCollapse ? (
        <ShowAllToggle open={showAll} onToggle={() => setShowAll((prev) => !prev)} total={usage.length} noun="stablecoins" />
      ) : null}
    </section>
  );
}
