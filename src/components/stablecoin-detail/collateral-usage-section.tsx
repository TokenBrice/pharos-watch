"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { useLogos } from "@/hooks/use-logos";
import { DETAIL_SECTION_TITLE_CLASS } from "@/components/stablecoin-detail/section-title";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import { deriveDependencies } from "@shared/lib/reserve-templates";
import type { DependencyType, StablecoinMeta } from "@shared/types";

interface CollateralUsageEntry {
  coin: StablecoinMeta;
  weight: number;
  type: DependencyType;
}

const PREVIEW_COUNT = 9;

const TIER_DEFS = [
  { key: "primary", label: "Primary backing", test: (w: number) => w >= 0.5 },
  { key: "partial", label: "Partial", test: (w: number) => w >= 0.1 && w < 0.5 },
  { key: "minor", label: "Minor exposure", test: (w: number) => w < 0.1 },
] as const;

function useCollateralUsage(stablecoinId: string): CollateralUsageEntry[] {
  return useMemo(() => {
    const usage: CollateralUsageEntry[] = [];
    for (const coin of TRACKED_STABLECOINS) {
      if (coin.id === stablecoinId) continue;
      for (const dep of deriveDependencies(coin)) {
        if (dep.id === stablecoinId) {
          usage.push({ coin, weight: dep.weight, type: dep.type ?? "collateral" });
        }
      }
    }
    return usage.sort((a, b) => b.weight - a.weight);
  }, [stablecoinId]);
}

/** Percentage text color scaled by dependency significance */
function weightColorClass(weight: number): string {
  if (weight >= 0.5) return "text-foreground";
  if (weight >= 0.1) return "text-foreground/70";
  return "text-muted-foreground";
}

function CollateralUsageItem({ entry, logoSrc }: { entry: CollateralUsageEntry; logoSrc: string | undefined }) {
  const pct = Math.round(entry.weight * 100);

  return (
    <Link
      href={`/stablecoin/${entry.coin.id}`}
      className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors hover:bg-muted/50"
    >
      <StablecoinLogo src={logoSrc} name={entry.coin.name} size={24} />
      <span className="min-w-0 truncate text-sm font-medium">{entry.coin.symbol}</span>
      {entry.type !== "collateral" && (
        <span className="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 text-[11px] text-muted-foreground">
          {entry.type}
        </span>
      )}
      <span className={`ml-auto shrink-0 font-mono text-sm tabular-nums ${weightColorClass(entry.weight)}`}>
        {pct}%
      </span>
    </Link>
  );
}

interface CollateralUsageSectionProps {
  stablecoinId: string;
}

export function CollateralUsageSection({ stablecoinId }: CollateralUsageSectionProps) {
  const usage = useCollateralUsage(stablecoinId);
  const { data: logos } = useLogos();
  const [showAll, setShowAll] = useState(false);
  const ticker = TRACKED_STABLECOINS.find((c) => c.id === stablecoinId)?.symbol ?? "This Stablecoin";

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

  const GRID_CLASSES = "grid grid-cols-1 gap-0.5 sm:grid-cols-2 lg:grid-cols-3";

  return (
    <section id="collateral-usage">
      <Card className="rounded-xl border-l-[3px] border-l-amber-500 animate-in fade-in duration-300">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <CardTitle as="h2" className={DETAIL_SECTION_TITLE_CLASS}>
              {ticker} Is Used as Collateral by:
            </CardTitle>
            <Badge variant="outline" className="text-[11px]">
              {usage.length} {usage.length === 1 ? "stablecoin" : "stablecoins"}
            </Badge>
          </div>
          {usage.length > 3 && wrapperCount > 0 && (
            <p className="text-xs text-muted-foreground mt-1">
              {collateralCount > 0 && `${collateralCount} collateral`}
              {collateralCount > 0 && wrapperCount > 0 && " · "}
              {wrapperCount > 0 && `${wrapperCount} wrapper${wrapperCount !== 1 ? "s" : ""}`}
            </p>
          )}
        </CardHeader>
        <CardContent>
          {isCompact ? (
            <div className="flex flex-col gap-0.5 sm:flex-row sm:flex-wrap sm:gap-4">
              {visible.map(renderItem)}
            </div>
          ) : showTierLabels ? (
            <div className="space-y-3">
              {tierSections.map((tier) => (
                <div key={tier.key}>
                  <p className="mb-1 px-2.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    {tier.label}
                  </p>
                  <div className={GRID_CLASSES}>{tier.items.map(renderItem)}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className={GRID_CLASSES}>{visible.map(renderItem)}</div>
          )}
          {needsCollapse && (
            <button
              onClick={() => setShowAll((prev) => !prev)}
              className="pharos-focus-ring mt-3 inline-flex min-h-11 items-center rounded-md px-2.5 text-sm text-muted-foreground transition-colors hover:text-foreground lg:min-h-9"
            >
              {showAll ? "Show less" : `Show all ${usage.length} stablecoins`}
            </button>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
