"use client";

import { AiSummary } from "@/components/ai-summary";
import { DEWSDetail } from "@/components/dews-detail";
import { ReserveTreemap } from "@/components/reserve-treemap";
import type { ReserveResult } from "@shared/lib/reserve-templates";
import type { StablecoinMeta } from "@shared/types";

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
  const isLiveEnabled = !!coin.liveReservesConfig;

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
                <ReserveTreemap
                  reserves={reserves.reserves}
                  isLive={!!reserves.liveAt}
                />
                <div className="mt-1 flex items-center justify-center gap-2 text-xs text-muted-foreground">
                  {reserves.mode === "live" ? (
                    <>
                      <span>
                        Updated{" "}
                        {reserves.liveAt
                          ? new Date(reserves.liveAt * 1000).toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                            timeZoneName: "short",
                          })
                          : "just now"}
                      </span>
                      {reserves.displayUrl && (
                        <>
                          <span aria-hidden>·</span>
                          <a
                            href={reserves.displayUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline underline-offset-2 hover:text-foreground transition-colors"
                          >
                            Source
                          </a>
                        </>
                      )}
                    </>
                  ) : reserves.mode === "live-stale" ? (
                    <>
                      <span>
                        Live snapshot stale; showing last successful sync from{" "}
                        {reserves.liveAt
                          ? new Date(reserves.liveAt * 1000).toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                            timeZoneName: "short",
                          })
                          : "the previous successful run"}
                      </span>
                      {reserves.displayUrl && (
                        <>
                          <span aria-hidden>·</span>
                          <a
                            href={reserves.displayUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline underline-offset-2 hover:text-foreground transition-colors"
                          >
                            Source
                          </a>
                        </>
                      )}
                    </>
                  ) : isLiveEnabled && reserves.mode === "curated-fallback" ? (
                    <span>Live sync unavailable; showing curated reserve baseline</span>
                  ) : isLiveEnabled && reserves.mode === "template-fallback" ? (
                    <span>Live sync unavailable; showing estimated classification template</span>
                  ) : reserves.mode === "unavailable" ? (
                    <span>Reserve composition unavailable</span>
                  ) : reserves.estimated ? (
                    <span>
                      Estimated composition based on {coin.flags.backing.replace("-", " ")} classification
                    </span>
                  ) : null}
                </div>
                {reserves.sync?.warnings && reserves.sync.warnings.length > 0 && (
                  <div className="mt-2 text-center text-xs text-amber-700 dark:text-amber-300">
                    Operator note: {reserves.sync.warnings.join("; ")}
                  </div>
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
