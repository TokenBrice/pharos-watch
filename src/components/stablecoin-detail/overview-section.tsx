"use client";

import { AiSummary } from "@/components/ai-summary";
import { DEWSDetail } from "@/components/dews-detail";
import { ReserveTreemap } from "@/components/reserve-treemap";
import type { ReserveResult } from "@/lib/reserve-templates";
import type { StablecoinMeta } from "@/lib/types";

interface SummaryData {
  title: string;
  text: string;
  updatedAt: string;
}

interface OverviewSectionProps {
  stablecoinId: string;
  coin: StablecoinMeta;
  summary: SummaryData | null;
  reserves: ReserveResult | null;
  isNavToken: boolean;
}

export function OverviewSection({
  stablecoinId,
  coin,
  summary,
  reserves,
  isNavToken,
}: OverviewSectionProps) {
  const hasLeft = !!(summary || reserves);
  const hasDews = !isNavToken;

  return (
    <section id="overview">
      {!hasLeft && !hasDews ? null : !hasLeft ? (
        <DEWSDetail stablecoinId={stablecoinId} />
      ) : (
        <div className={`grid grid-cols-1 gap-6 ${hasDews ? "lg:grid-cols-2" : ""}`}>
          <div className="flex flex-col gap-6">
            {summary && <AiSummary {...summary} />}
            {reserves && (
              <div>
                <ReserveTreemap reserves={reserves.reserves} />
                {reserves.estimated && (
                  <p className="mt-1 text-center text-xs text-muted-foreground">
                    Estimated composition based on {coin.flags.backing.replace("-", " ")} classification
                  </p>
                )}
              </div>
            )}
          </div>
          {hasDews && <DEWSDetail stablecoinId={stablecoinId} />}
        </div>
      )}
    </section>
  );
}
