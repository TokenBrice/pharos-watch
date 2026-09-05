import { ApiFetchError } from "@/lib/api";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
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
      toneClass: SEVERITY_TONE_CLASS.watch.pill,
    };
  }

  if (mode === "curated-fallback") {
    return {
      title: "Live reserve feed unavailable",
      message: "Unable to load the live reserve feed right now. Showing curated reserve baseline.",
      toneClass: SEVERITY_TONE_CLASS.watch.pill,
    };
  }

  if (mode === "template-fallback") {
    return {
      title: "Live reserve feed unavailable",
      message: "Unable to load the live reserve feed right now. Showing the estimated reserve template.",
      toneClass: SEVERITY_TONE_CLASS.watch.pill,
    };
  }

  if (isUnavailable) {
    return {
      title: "Live reserve data not yet available",
      message: hasFallbackView
        ? "The live reserve feed has not been populated yet. Showing the current fallback view."
        : "The live reserve feed has not been populated yet. Please check back shortly.",
      toneClass: SEVERITY_TONE_CLASS.neutral.pill,
    };
  }

  if (isNetwork) {
    return {
      title: "Connection issue",
      message: hasFallbackView
        ? "Unable to reach the live reserve API. Showing the current fallback view."
        : "Unable to reach the live reserve API right now. Please check your connection and try again.",
      toneClass: hasFallbackView
        ? SEVERITY_TONE_CLASS.watch.pill
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
      ? SEVERITY_TONE_CLASS.watch.pill
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

export function formatReserveSnapshotLabel(reserves: ReserveResult): string {
  const sourceTimestamp = reserves.metadata?.sourceTimestamp;
  const sourceDate = typeof sourceTimestamp === "number" && Number.isFinite(sourceTimestamp)
    ? new Date(sourceTimestamp * 1000).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })
    : null;
  const assurance = reserves.metadata?.details?.assurance;
  const reportDate = assurance && typeof assurance === "object" && "reportDate" in assurance
    && typeof assurance.reportDate === "string" ? assurance.reportDate : null;
  const asOf = reportDate ? `Report as of ${reportDate}` : sourceDate ? `Source as of ${sourceDate}` : "Source date unavailable";
  const stale = reserves.mode === "live-stale" ? " · Stale" : "";
  return `${asOf}${stale} · Checked ${formatReserveUpdatedAt(reserves.liveAt)}`;
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
        text: formatReserveSnapshotLabel(reserves),
        references,
      };
    case "live-stale":
      return {
        text: formatReserveSnapshotLabel(reserves),
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
      title: "Reserve evidence",
      message: "This reserve view reflects a dated attestation, proof, or liveness check. The checked date records collection; it does not advance the underlying evidence date.",
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

  const staleSourceWarnings = (sync.warnings ?? []).filter((warning) => warning.startsWith("Upstream reserve source timestamp is ") && warning.includes("s old"));
  const sourceAgeOnly = sync.status === "degraded" && !sync.lastError && !sync.uncertainWrite
    && staleSourceWarnings.length > 0 && staleSourceWarnings.length === sync.warnings?.length;
  if (sourceAgeOnly) {
    return {
      title: "Reserve evidence is out of date",
      rows: [
        "The latest collected disclosure is older than this source’s accepted reporting window.",
        formatReserveSnapshotLabel(reserves!),
      ],
      toneClass: SEVERITY_TONE_CLASS.watch.pill,
    };
  }
  const rows = [`Status: ${sync.status}`];
  if (sync.failureCategory) rows.push(`Failure category: ${sync.failureCategory}`);
  if (sync.lastError) rows.push(`Last error: ${sync.lastError}`);
  if (sync.uncertainWrite) rows.push("Latest write state uncertain");
  rows.push(...(sync.warnings ?? []));

  return {
    title: sync.status === "error" ? "Live reserve sync error" : "Live reserve sync degraded",
    rows,
    toneClass: sync.status === "error"
      ? "border-destructive/50 bg-destructive/10 text-destructive"
      : SEVERITY_TONE_CLASS.watch.pill,
  };
}
