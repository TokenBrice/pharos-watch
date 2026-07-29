import { ApiFetchError } from "@/lib/api";
import type { ReserveResult } from "@shared/lib/reserve-templates";

export interface ReserveNoticeModel {
  title: string;
  message: string;
  toneClass: string;
}

export interface ReserveReferenceLink {
  label: string;
  url: string;
}

export interface ReserveFootnoteModel {
  text: string | null;
  references: ReserveReferenceLink[];
}

export interface ReserveSyncNoticeModel {
  title: string;
  rows: string[];
  toneClass: string;
}

function isNetworkFetchError(error: unknown): boolean {
  return error instanceof TypeError
    && /failed to fetch|networkerror|load failed|network request failed/i.test(error.message);
}

export function buildReserveFetchNotice(
  error: unknown,
  reserves: ReserveResult | null,
): ReserveNoticeModel {
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

function reserveReferenceLinks(reserves: ReserveResult): ReserveReferenceLink[] {
  return [
    ...(reserves.displayUrl ? [{ label: "Source", url: reserves.displayUrl }] : []),
    ...((reserves.evidenceUrls ?? []).map((url, index) => ({
      label: index === 0 ? "Evidence" : `Evidence ${index + 1}`,
      url,
    }))),
  ];
}

export function buildReserveFootnoteModel(
  reserves: ReserveResult,
  isLiveEnabled: boolean,
  backingLabel: string,
): ReserveFootnoteModel | null {
  const references = reserveReferenceLinks(reserves);

  switch (reserves.mode) {
    case "live":
      return {
        text: formatReserveSnapshotFreshLabel(reserves),
        references,
      };
    case "live-stale":
      return {
        text: formatReserveSnapshotStaleLabel(reserves),
        references,
      };
    case "curated-fallback":
      return isLiveEnabled
        ? { text: "Live sync unavailable; showing curated reserve baseline", references: [] }
        : null;
    case "template-fallback":
      return isLiveEnabled
        ? { text: "Live sync unavailable; showing estimated classification template", references: [] }
        : reserves.estimated
          ? { text: `Estimated composition based on ${backingLabel} classification`, references: [] }
          : null;
    case "unavailable":
      return { text: "Reserve composition unavailable", references: [] };
    default:
      return reserves.estimated
        ? { text: `Estimated composition based on ${backingLabel} classification`, references: [] }
        : null;
  }
}

export function buildReserveCompositionNote(reserves: ReserveResult | null): string | null {
  if (!reserves || (reserves.mode !== "live" && reserves.mode !== "live-stale")) {
    return null;
  }

  const notes: string[] = [];
  const referenceNavUsd = reserves.metadata?.referenceNavUsd;
  if (typeof referenceNavUsd === "number" && Number.isFinite(referenceNavUsd) && referenceNavUsd > 0) {
    const formattedNav = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 4,
      maximumFractionDigits: 4,
    }).format(referenceNavUsd);
    notes.push(`Strategy reference NAV is ${formattedNav} per share.`);
  }

  const yieldBasisShare = reserves.metadata?.yieldBasisCollateralPct;
  if (typeof yieldBasisShare === "number" && Number.isFinite(yieldBasisShare) && yieldBasisShare > 0) {
    const formattedShare = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(yieldBasisShare);
    notes.push(`Yield Basis positions account for ${formattedShare}% of this live reserve mix.`);
  }

  return notes.length > 0 ? notes.join(" ") : null;
}

export function buildReserveProvenanceNotice(
  reserves: ReserveResult | null,
): ReserveNoticeModel | null {
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

export function buildReserveSyncNotice(
  reserves: ReserveResult | null,
): ReserveSyncNoticeModel | null {
  const sync = reserves?.sync;
  if (!sync || (sync.status === "ok" && !sync.uncertainWrite)) {
    return null;
  }

  const rows = [`Status: ${sync.status}`];
  if (sync.failureCategory) rows.push(`Failure category: ${sync.failureCategory}`);
  if (sync.lastError) rows.push(`Last error: ${sync.lastError}`);
  if (sync.uncertainWrite) rows.push("Latest write state uncertain");

  return {
    title: sync.status === "error" ? "Live reserve sync error" : "Live reserve sync degraded",
    rows,
    toneClass: sync.status === "error"
      ? "border-destructive/50 bg-destructive/10 text-destructive"
      : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  };
}
