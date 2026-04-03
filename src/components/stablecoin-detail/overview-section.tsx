"use client";

import { AiSummary } from "@/components/ai-summary";
import { DEWSDetail } from "@/components/dews-detail";
import { PriceTransparencyCard } from "@/components/stablecoin-detail/price-transparency-card";
import { RedemptionBackstopCard } from "@/components/stablecoin-detail/redemption-backstop-card";
import { ReserveTreemap } from "@/components/reserve-treemap";
import { ApiFetchError } from "@/lib/api";
import type { ReserveResult } from "@shared/lib/reserve-templates";
import type { PegSummaryCoin, RedemptionBackstopEntry, StablecoinMeta, StablecoinData } from "@shared/types";

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
  redemptionBackstop?: RedemptionBackstopEntry;
  isNavToken: boolean;
  coinData?: StablecoinData;
  consensusSources?: string[];
  agreeSources?: string[];
  dexPriceCheck?: PegSummaryCoin["dexPriceCheck"];
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

function formatReserveUpdatedAt(timestamp: number | undefined): string {
  return timestamp
    ? new Date(timestamp * 1000).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
      })
    : "the previous successful run";
}

function formatReserveSnapshotFreshLabel(reserves: ReserveResult): string {
  switch (reserves.displayBadge?.kind) {
    case "curated-validated":
      return `Curated-validated as of ${formatReserveUpdatedAt(reserves.liveAt)}`;
    case "proof":
      return `Proof refreshed ${formatReserveUpdatedAt(reserves.liveAt)}`;
    default:
      return `Updated ${formatReserveUpdatedAt(reserves.liveAt)}`;
  }
}

function formatReserveSnapshotStaleLabel(reserves: ReserveResult): string {
  switch (reserves.displayBadge?.kind) {
    case "curated-validated":
      return `Curated-validated snapshot stale; showing last successful sync from ${formatReserveUpdatedAt(reserves.liveAt)}`;
    case "proof":
      return `Proof snapshot stale; showing last successful sync from ${formatReserveUpdatedAt(reserves.liveAt)}`;
    default:
      return `Live snapshot stale; showing last successful sync from ${formatReserveUpdatedAt(reserves.liveAt)}`;
  }
}

function buildReserveCompositionNote(reserves: ReserveResult | null): string | null {
  if (!reserves || (reserves.mode !== "live" && reserves.mode !== "live-stale")) {
    return null;
  }

  const yieldBasisShare = reserves.metadata?.yieldBasisCollateralPct;
  if (typeof yieldBasisShare !== "number" || !Number.isFinite(yieldBasisShare) || yieldBasisShare <= 0) {
    return null;
  }

  const formattedShare = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(yieldBasisShare);
  return `Yield Basis positions account for ${formattedShare}% of this live reserve mix.`;
}

function buildReserveProvenanceNotice(
  reserves: ReserveResult | null,
): { title: string; message: string; toneClass: string } | null {
  if (!reserves?.provenance || (reserves.mode !== "live" && reserves.mode !== "live-stale")) {
    return null;
  }

  if (reserves.displayBadge?.kind === "curated-validated") {
    return {
      title: "Curated-validated reserve baseline",
      message: "This reserve view uses the reviewed reserve baseline, kept current through live validation rather than a fully independent live reserve composition feed.",
      toneClass: "border-border/60 bg-muted/30 text-muted-foreground",
    };
  }

  if (reserves.displayBadge?.kind === "proof") {
    return {
      title: "Proof-based reserve view",
      message: "This reserve view reflects a live proof, attestation, or liveness check rather than a full live reserve composition feed.",
      toneClass: "border-border/60 bg-muted/30 text-muted-foreground",
    };
  }

  switch (reserves.provenance.evidenceClass) {
    case "independent":
      return {
        title: "Independent live reserve disclosure",
        message: reserves.provenance.scoringEligible
          ? "This reserve view comes from an independently measured live reserve feed."
          : reserves.provenance.freshnessMode === "unverified"
            ? "This reserve view comes from an independently measured live reserve feed, but freshness is not verified strongly enough for collateral scoring."
            : "This reserve view comes from an independently measured live reserve feed, but the current snapshot is not scoring-eligible.",
        toneClass: "border-border/60 bg-muted/30 text-muted-foreground",
      };
    case "static-validated":
      return {
        title: "Live reserve disclosure",
        message: "This reserve view comes from a live reserve feed, but the current source is not treated as independent evidence for collateral scoring.",
        toneClass: "border-border/60 bg-muted/30 text-muted-foreground",
      };
    case "weak-live-probe":
      return {
        title: "Proof-based reserve view",
        message: "This reserve view reflects a live proof, attestation, or liveness check rather than a full live reserve composition feed.",
        toneClass: "border-border/60 bg-muted/30 text-muted-foreground",
      };
    default:
      return null;
  }
}

export function OverviewSection({
  stablecoinId,
  coin,
  summary,
  reserves,
  reserveFetchError,
  redemptionBackstop,
  isNavToken,
  coinData,
  consensusSources,
  agreeSources,
  dexPriceCheck,
}: OverviewSectionProps) {
  const hasLeft = !!(summary || reserves || reserveFetchError || redemptionBackstop);
  const hasDews = !isNavToken;
  const hasPriceTransparency = !!coinData && coinData.price != null;
  const isLiveEnabled = !!coin.liveReservesConfig;
  const reserveFetchNotice = reserveFetchError
    ? buildReserveFetchNotice(reserveFetchError, reserves)
    : null;
  const reserveCompositionNote = buildReserveCompositionNote(reserves);
  const reserveProvenanceNotice = buildReserveProvenanceNotice(reserves);

  const hasRightColumn = hasDews || hasPriceTransparency;
  const hasAnything = hasLeft || hasRightColumn;

  if (!hasAnything) {
    return <section id="overview" />;
  }

  const rightColumnContent = hasRightColumn ? (
    <div className="flex flex-col gap-6">
      {hasDews && <DEWSDetail stablecoinId={stablecoinId} />}
      {hasPriceTransparency && coinData && (
        <div id="price-transparency">
          <PriceTransparencyCard
            coinData={coinData}
            consensusSources={consensusSources ?? []}
            agreeSources={agreeSources ?? []}
            dexPriceCheck={dexPriceCheck}
          />
        </div>
      )}
    </div>
  ) : null;

  if (!hasLeft) {
    return (
      <section id="overview">
        {rightColumnContent}
      </section>
    );
  }

  return (
    <section id="overview">
      <div className={`grid grid-cols-1 gap-6 ${hasRightColumn ? "lg:grid-cols-2" : ""}`}>
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
                  badge={reserves.displayBadge}
                />
                <div className="mt-1 flex items-center justify-center gap-2 text-xs text-muted-foreground">
                  {reserves.mode === "live" ? (
                    <>
                      <span>{formatReserveSnapshotFreshLabel(reserves)}</span>
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
                      <span>{formatReserveSnapshotStaleLabel(reserves)}</span>
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
                {reserveCompositionNote ? (
                  <div className="mt-2 text-center text-xs text-muted-foreground">{reserveCompositionNote}</div>
                ) : null}
                {reserveProvenanceNotice ? (
                  <div className={`mt-2 rounded-lg border px-4 py-3 text-sm leading-relaxed ${reserveProvenanceNotice.toneClass}`}>
                    <p className="font-medium text-foreground">{reserveProvenanceNotice.title}</p>
                    <p className="mt-1">{reserveProvenanceNotice.message}</p>
                  </div>
                ) : null}
                {reserves.sync?.warnings && reserves.sync.warnings.length > 0 && (
                  <div className="mt-2 text-center text-xs text-amber-700 dark:text-amber-300">
                    Operator note: {reserves.sync.warnings.join("; ")}
                  </div>
                )}
              </div>
            )}
            {redemptionBackstop ? (
              <RedemptionBackstopCard entry={redemptionBackstop} />
            ) : null}
          </div>
          {rightColumnContent}
        </div>
    </section>
  );
}
