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

function CollateralUsageItem({ entry, logoSrc }: { entry: CollateralUsageEntry; logoSrc: string | undefined }) {
  return (
    <Link
      href={`/stablecoin/${entry.coin.id}`}
      className="flex items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-muted/50"
    >
      <StablecoinLogo src={logoSrc} name={entry.coin.name} size={28} />
      <div className="min-w-0 flex-1">
        <span className="text-sm font-medium">{entry.coin.symbol}</span>
        <p className="text-xs text-muted-foreground">{entry.type}</p>
      </div>
      <span className="font-mono text-sm tabular-nums">{Math.round(entry.weight * 100)}%</span>
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

  if (usage.length === 0) return null;

  const needsCollapse = usage.length > PREVIEW_COUNT;
  const visible = showAll ? usage : usage.slice(0, PREVIEW_COUNT);

  return (
    <section id="collateral-usage">
      <Card className="rounded-xl border-l-[3px] border-l-amber-500 animate-in fade-in duration-300">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <CardTitle as="h2" className={DETAIL_SECTION_TITLE_CLASS}>
              Used as Collateral
            </CardTitle>
            <Badge variant="outline" className="text-[10px]">
              {usage.length} {usage.length === 1 ? "stablecoin" : "stablecoins"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3">
            {visible.map((entry) => (
              <CollateralUsageItem
                key={entry.coin.id}
                entry={entry}
                logoSrc={logos?.[entry.coin.id]}
              />
            ))}
          </div>
          {needsCollapse && (
            <button
              onClick={() => setShowAll((prev) => !prev)}
              className="pharos-focus-ring mt-3 inline-flex min-h-11 items-center rounded-md px-2.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              {showAll ? "Show less" : `Show all ${usage.length} stablecoins`}
            </button>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
