"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { ShowAllToggle } from "@/components/stablecoin-detail/disclosure-toggles";
import { useLogos } from "@/hooks/use-logos";
import { buildStablecoinUrl } from "@/lib/urls";
import type { CollateralUsageEntry } from "@/lib/collateral-usage-model";
import { DETAIL_MODULE_TITLE_CLASS } from "@/components/stablecoin-detail/section-title-class";

const PREVIEW_COUNT = 9;

const TIER_DEFS = [
  { key: "primary", label: "Primary backing", test: (w: number) => w >= 0.5 },
  { key: "partial", label: "Partial", test: (w: number) => w >= 0.1 && w < 0.5 },
  { key: "minor", label: "Minor exposure", test: (w: number) => w < 0.1 },
] as const;

function CollateralUsageItem({ entry, logoSrc }: { entry: CollateralUsageEntry; logoSrc: string | undefined }) {
  const pct = Math.round(entry.weight * 100);

  return (
    <Link
      href={buildStablecoinUrl(entry.coin.id)}
      className="pharos-focus-ring flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors hover:bg-muted/40"
    >
      <StablecoinLogo src={logoSrc} name={entry.coin.name} size={24} />
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {/* Tickers are short bounded strings — never ellipsize them; the type
            chip is the flexible element if the cell ever runs out of room. */}
        <span className="shrink-0 text-sm font-medium">{entry.coin.symbol}</span>
        {entry.type !== "collateral" && (
          <span className="min-w-0 truncate rounded-sm bg-muted/50 px-1.5 text-[10px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
            {entry.type}
          </span>
        )}
      </div>
      <span className="shrink-0 font-mono text-sm tabular-nums text-foreground">
        {pct}%
      </span>
    </Link>
  );
}

interface CollateralUsageSectionProps {
  entries: readonly CollateralUsageEntry[];
}

export function CollateralUsageSection({ entries }: CollateralUsageSectionProps) {
  const usage = useMemo(() => [...entries].sort((a, b) => b.weight - a.weight), [entries]);
  const { data: logos } = useLogos();
  const [showAll, setShowAll] = useState(false);

  if (usage.length === 0) return null;

  const needsCollapse = usage.length > PREVIEW_COUNT;
  const visible = showAll ? usage : usage.slice(0, PREVIEW_COUNT);

  const wrapperCount = usage.filter((e) => e.type === "wrapper").length;
  const collateralCount = usage.length - wrapperCount;

  // Group visible items into weight tiers
  const tierSections = TIER_DEFS
    .map((def) => ({ key: def.key, label: def.label, items: visible.filter((e) => def.test(e.weight)) }))
    .filter((t) => t.items.length > 0);

  // Show tier labels only when items span multiple weight tiers
  const showTierLabels = usage.length > 3 && tierSections.length > 1;

  // <=3 items: compact flex row; >3: structured grid (with optional tiers)
  const isCompact = usage.length <= 3;

  const renderItem = (entry: CollateralUsageEntry) => (
    <CollateralUsageItem key={entry.coin.id} entry={entry} logoSrc={logos?.[entry.coin.id]} />
  );

  // Container-query columns: this section mounts both full-width and inside
  // the half-width Dependency Context split, so viewport breakpoints
  // over-column the narrow case and squeeze tickers into ellipsis.
  const GRID_CLASSES = "grid grid-cols-1 gap-0.5 @lg:grid-cols-2 @3xl:grid-cols-3";
  const showsTypeBreakdown = usage.length > 3 && wrapperCount > 0;

  return (
    <section id="collateral-usage" className="@container animate-in fade-in space-y-2.5 duration-300">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-2.5">
        <h3 className={DETAIL_MODULE_TITLE_CLASS}>
          Used by <span className="ml-1 font-normal text-muted-foreground tabular-nums">{usage.length}</span>
        </h3>
        {showsTypeBreakdown && (
          <span className="pharos-meta">
            {collateralCount > 0 && `${collateralCount} collateral`}
            {collateralCount > 0 && wrapperCount > 0 && " · "}
            {wrapperCount > 0 && `${wrapperCount} wrapper${wrapperCount !== 1 ? "s" : ""}`}
          </span>
        )}
      </div>
      <div className={showAll ? "max-h-96 overflow-y-auto" : undefined}>
        {isCompact ? (
          <div className="flex flex-col gap-0.5 sm:flex-row sm:flex-wrap sm:gap-4">
            {visible.map(renderItem)}
          </div>
        ) : showTierLabels ? (
          <div className="space-y-3">
            {tierSections.map((tier) => (
              <div key={tier.key}>
                <p className="pharos-kicker mb-1 px-2.5">{tier.label}</p>
                <div className={GRID_CLASSES}>{tier.items.map(renderItem)}</div>
              </div>
            ))}
          </div>
        ) : (
          <div className={GRID_CLASSES}>{visible.map(renderItem)}</div>
        )}
      </div>
      {needsCollapse && (
        <ShowAllToggle
          open={showAll}
          onToggle={() => setShowAll((prev) => !prev)}
          total={usage.length}
          noun="stablecoins"
        />
      )}
    </section>
  );
}
