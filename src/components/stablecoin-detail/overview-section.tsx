"use client";

import { AiSummary } from "@/components/ai-summary";
import { DEWSDetail } from "@/components/dews-detail";
import { ReserveTreemap } from "@/components/reserve-treemap";
import { ApiFetchError } from "@/lib/api";
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
  reserveFetchError: unknown | null;
  isNavToken: boolean;
}

function isNetworkFetchError(error: unknown): boolean {
  return error instanceof TypeError
    && /failed to fetch|networkerror|load failed|network request failed/i.test(error.message);
}

function buildReserveFetchNotice(
  error: unknown,
  reserves: ReserveResult | null,
): { title: string; message: string; toneClass: string } {
  const mode = reserves?.mode;
  const hasFallbackView = !!reserves;
  const isUnavailable = error instanceof ApiFetchError && error.status === 503;
  const isNetwork = isNetworkFetchError(error);

  if (mode === "live" || mode === "live-stale") {
    return {
      title: "Live reserve refresh delayed",
      message: "Showing the last worker-resolved reserve snapshot while refresh retries.",
      toneClass: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
    };
  }

  if (mode === "curated-fallback") {
    return {
      title: "Live reserve feed unavailable",
      message: "Unable to load the live reserve feed right now. Showing curated reserve baseline.",
      toneClass: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
    };
  }

  if (mode === "template-fallback") {
    return {
      title: "Live reserve feed unavailable",
      message: "Unable to load the live reserve feed right now. Showing the estimated reserve template.",
      toneClass: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
    };
  }

  if (isUnavailable) {
    return {
      title: "Live reserve data not yet available",
      message: hasFallbackView
        ? "The live reserve feed has not been populated yet. Showing the current fallback view."
        : "The live reserve feed has not been populated yet. Please check back shortly.",
      toneClass: "border-border/60 bg-muted/40 text-muted-foreground",
    };
  }

  if (isNetwork) {
    return {
      title: "Connection issue",
      message: hasFallbackView
        ? "Unable to reach the live reserve API. Showing the current fallback view."
        : "Unable to reach the live reserve API right now. Please check your connection and try again.",
      toneClass: hasFallbackView
        ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
        : "border-destructive/50 bg-destructive/10 text-destructive",
    };
  }

  return {
    title: "Live reserve feed unavailable",
    message: hasFallbackView
      ? "Unable to load the live reserve feed right now. Showing the current fallback view."
      : error instanceof Error
        ? error.message
        : "Unable to load reserve composition right now.",
    toneClass: hasFallbackView
      ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
      : "border-destructive/50 bg-destructive/10 text-destructive",
  };
}

export function OverviewSection({
  stablecoinId,
  coin,
  summary,
  reserves,
  reserveFetchError,
  isNavToken,
}: OverviewSectionProps) {
  const hasLeft = !!(summary || reserves || reserveFetchError);
  const hasDews = !isNavToken;
  const isLiveEnabled = !!coin.liveReservesConfig;
  const reserveFetchNotice = reserveFetchError
    ? buildReserveFetchNotice(reserveFetchError, reserves)
    : null;

  return (
    <section id="overview">
      {!hasLeft && !hasDews ? null : !hasLeft ? (
        <DEWSDetail stablecoinId={stablecoinId} />
      ) : (
        <div className={`grid grid-cols-1 gap-6 ${hasDews ? "lg:grid-cols-2" : ""}`}>
          <div className="flex flex-col gap-6">
            {summary && <AiSummary {...summary} />}
            {reserveFetchNotice ? (
              <div
                role="status"
                aria-live="polite"
                className={`rounded-lg border px-4 py-3 text-sm leading-relaxed shadow-sm ${reserveFetchNotice.toneClass}`}
              >
                <p className="font-medium">{reserveFetchNotice.title}</p>
                <p className="mt-1">{reserveFetchNotice.message}</p>
              </div>
            ) : null}
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
