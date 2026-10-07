import { ApiFetchError } from "@/lib/api";
import type { ReserveQualityClientSummary } from "@/lib/stablecoin-detail-reserve-quality-client";
import type { ReserveLookThroughClientSummary } from "@/lib/stablecoin-detail-reserve-look-through-client";
import type { ReserveResult } from "@shared/lib/reserve-templates";
import type { ReserveRisk, ReserveSlice } from "@shared/types";
import { formatIsoDate, formatIsoTimestamp } from "@shared/lib/format";

/** `neutral` is informational; `watch` is an active condition (amber). Nothing here is red. */
export type ReserveNoticeTone = "neutral" | "watch";

export interface ReserveNoticeModel {
  title: string;
  message: string;
  tone: ReserveNoticeTone;
}

export interface ReserveReferenceLink {
  label: string;
  url: string;
}

export interface ReserveFootnoteModel {
  text: string | null;
  references: ReserveReferenceLink[];
}

/**
 * Ops/pipeline state of the reserve feed, shaped for a header chip plus a
 * disclosure (D6): `label` is the chip, `summary` its tooltip, `rows` the
 * disclosure detail. `reason` is the machine-readable cause (data-integrity
 * rules R3/R4: the freshness budget and the reason stay visible).
 */
export interface ReserveFeedStatusModel {
  label: string;
  tone: ReserveNoticeTone;
  reason: string;
  summary: string;
  rows: string[];
  /** True when the state came from a failed fetch, so a retry can help. */
  retryable: boolean;
}

export interface ReserveSourceChipModel {
  label: string;
  /** The provenance sentence that used to sit under the module as an all-caps footnote. */
  tooltip: string | null;
}

/** One tile/segment of the reserve visual, whichever snapshot it came from. */
export interface ReserveCompositionSlice {
  key: string;
  label: string;
  pct: number;
  risk: ReserveRisk;
  /** Obligor / asset-class line for tooltips; never rendered as tile text. */
  detail: string | null;
  /** The slice's reviewed role in the basket (its asset class label), when classified. */
  role?: string | null;
}

const SECONDS_PER_DAY = 86_400;
const SECONDS_PER_HOUR = 3_600;

function isNetworkFetchError(error: unknown): boolean {
  return error instanceof TypeError
    && /failed to fetch|networkerror|load failed|network request failed/i.test(error.message);
}

/** A configured live adapter that has never attempted a sync: nothing failed yet. */
function isAwaitingFirstLiveSync(reserves: ReserveResult | null): boolean {
  const sync = reserves?.sync;
  return !!sync
    && sync.enabled
    && sync.bootstrap
    && sync.status === "skipped"
    && sync.lastAttemptedAt == null
    && !sync.lastError
    && !sync.failureCategory
    && !sync.uncertainWrite
    && !sync.warnings?.length;
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
      tone: "watch",
    };
  }

  if (mode === "curated-fallback") {
    return {
      title: "Live reserve feed unavailable",
      message: "Unable to load the live reserve feed right now. Showing curated reserve baseline.",
      tone: "watch",
    };
  }

  if (mode === "template-fallback") {
    return {
      title: "Live reserve feed unavailable",
      message: "Unable to load the live reserve feed right now. Showing the estimated reserve template.",
      tone: "watch",
    };
  }

  if (isUnavailable) {
    return {
      title: "Live reserve data not yet available",
      message: hasFallbackView
        ? "The live reserve feed has not been populated yet. Showing the current fallback view."
        : "The live reserve feed has not been populated yet. Please check back shortly.",
      tone: "neutral",
    };
  }

  if (isNetwork) {
    return {
      title: "Connection issue",
      message: hasFallbackView
        ? "Unable to reach the live reserve API. Showing the current fallback view."
        : "Unable to reach the live reserve API right now. Please check your connection and try again.",
      tone: "watch",
    };
  }

  return {
    title: "Live reserve feed unavailable",
    message: hasFallbackView
      ? "Unable to load the live reserve feed right now. Showing the current fallback view."
      : "Unable to load reserve composition right now.",
    tone: "watch",
  };
}

/** `YYYY-MM-DD HH:MM UTC`: the `as of` half of the sentence is UTC, so both halves share one frame. */
function formatReserveUpdatedAt(timestamp: number | undefined): string {
  return timestamp && Number.isFinite(timestamp)
    ? `${formatIsoTimestamp(timestamp).slice(0, 16).replace("T", " ")} UTC`
    : "the previous successful run";
}

export function formatReserveSnapshotLabel(reserves: ReserveResult): string {
  const sourceTimestamp = reserves.metadata?.sourceTimestamp;
  const sourceDate = typeof sourceTimestamp === "number" && Number.isFinite(sourceTimestamp)
    ? formatIsoDate(sourceTimestamp)
    : null;
  const assurance = reserves.metadata?.details?.assurance;
  const reportDate = assurance && typeof assurance === "object" && "reportDate" in assurance
    && typeof assurance.reportDate === "string" ? assurance.reportDate : null;
  const asOf = reportDate ? `Report as of ${reportDate}` : sourceDate ? `Source as of ${sourceDate}` : "Source date unavailable";
  const stale = reserves.mode === "live-stale" ? " · Stale" : "";
  return `${asOf}${stale} · Checked ${formatReserveUpdatedAt(reserves.liveAt)}`;
}

function formatReserveCompositionLabel(reserves: ReserveResult): string {
  const details = reserves.metadata?.details;
  const compositionAsOf = details?.compositionAsOf;
  const hasCompositionDate = typeof compositionAsOf === "string"
    && /^\d{4}-\d{2}-\d{2}$/.test(compositionAsOf)
    && Number.isFinite(Date.parse(compositionAsOf))
    && new Date(compositionAsOf).toISOString().slice(0, 10) === compositionAsOf;
  if (!hasCompositionDate && details?.compositionSource !== "reviewed-config" && reserves.source !== "tether-transparency") {
    return formatReserveSnapshotLabel(reserves);
  }

  // A totals observation cannot date a separately reviewed reserve mix.
  const asOf = hasCompositionDate ? `Composition as of ${compositionAsOf}` : "Composition date unavailable";
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
        text: formatReserveCompositionLabel(reserves),
        references,
      };
    case "live-stale":
      return {
        text: formatReserveCompositionLabel(reserves),
        references,
      };
    case "curated-fallback":
      return isLiveEnabled
        ? {
            text: isAwaitingFirstLiveSync(reserves)
              ? "Live sync pending first run; showing curated reserve baseline"
              : "Live sync unavailable; showing curated reserve baseline",
            references: [],
          }
        : null;
    case "template-fallback":
      return isLiveEnabled
        ? {
            text: isAwaitingFirstLiveSync(reserves)
              ? "Live sync pending first run; showing estimated classification template"
              : "Live sync unavailable; showing estimated classification template",
            references: [],
          }
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
  if (reserves.metadata?.balanceSheetScope === "shared-sky-maker"
    && reserves.metadata.sharedBookAssetIds?.includes("dai-makerdao")
    && reserves.metadata.sharedBookAssetIds.includes("usds-sky")) {
    notes.push("Composition covers the shared Sky/Maker balance sheet backing DAI and USDS; shared totals are not additive across these assets.");
  }
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
      tone: "neutral",
    };
  }

  if (reserves.displayBadge?.kind === "proof") {
    return {
      title: "Reserve evidence",
      message: "This reserve view reflects a dated attestation, proof, or liveness check. The checked date records collection; it does not advance the underlying evidence date.",
      tone: "neutral",
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
        tone: "neutral",
      };
    case "static-validated":
      return {
        title: "Live reserve disclosure",
        message: "This reserve view comes from a live reserve feed, but the current source is not treated as independent evidence for collateral scoring.",
        tone: "neutral",
      };
    case "weak-live-probe":
      return {
        title: "Proof-based reserve view",
        message: "This reserve view reflects a live proof, attestation, or liveness check rather than a full live reserve composition feed.",
        tone: "neutral",
      };
    default:
      return null;
  }
}

/**
 * The source-type chip ("Attestation", "Live proof", "Proof", "Live"): the
 * adapter's own badge label, with the provenance sentence as its tooltip.
 * Absent for curated and template views, which carry no live badge.
 */
export function buildReserveSourceChip(reserves: ReserveResult | null): ReserveSourceChipModel | null {
  const badge = reserves?.displayBadge;
  if (!reserves || !badge) return null;
  const isLiveProof = badge.kind === "proof" && reserves.provenance?.evidenceClass === "weak-live-probe";
  return {
    label: isLiveProof ? "Live proof" : badge.label,
    tooltip: buildReserveProvenanceNotice(reserves)?.message ?? null,
  };
}

function formatDuration(seconds: number): string {
  if (seconds >= SECONDS_PER_DAY) {
    const days = Math.round((seconds / SECONDS_PER_DAY) * 10) / 10;
    return `${days} ${days === 1 ? "day" : "days"}`;
  }
  if (seconds >= SECONDS_PER_HOUR) return `${Math.round((seconds / SECONDS_PER_HOUR) * 10) / 10} h`;
  return `${Math.round(seconds / 60)} min`;
}

function formatBudget(seconds: number): string {
  if (seconds >= SECONDS_PER_DAY) {
    const days = Math.round((seconds / SECONDS_PER_DAY) * 10) / 10;
    return `${days}-day budget`;
  }
  return `${Math.max(1, Math.round(seconds / SECONDS_PER_HOUR))}-hour budget`;
}

/** "1066290s old … (max 604800s)" becomes "12.3 days old … (max 7 days)": ages read in days, never raw seconds. */
function humanizeDurations(text: string): string {
  return text.replace(/\b(\d{3,})s\b/g, (_match, seconds: string) => formatDuration(Number(seconds)));
}

/** Date of the evidence the feed last collected: attested report date first, else the source timestamp. */
function reserveEvidenceDate(reserves: ReserveResult): number | null {
  const assurance = reserves.metadata?.details?.assurance;
  const reportDate = assurance && typeof assurance === "object" && "reportDate" in assurance
    && typeof assurance.reportDate === "string" ? Date.parse(assurance.reportDate) : Number.NaN;
  if (Number.isFinite(reportDate)) return reportDate;
  const sourceTimestamp = reserves.sync?.freshness?.sourceTimestamp ?? reserves.metadata?.sourceTimestamp;
  return typeof sourceTimestamp === "number" && Number.isFinite(sourceTimestamp) ? sourceTimestamp * 1000 : null;
}

/** A stale-source-age diagnostic, as the adapter validators and the sync warning both word it. */
const SOURCE_AGE_DIAGNOSTIC = /source timestamp is (\d+)s old.*?\(max (\d+)s\)/i;

function buildSyncFeedStatus(reserves: ReserveResult): ReserveFeedStatusModel | null {
  const sync = reserves.sync;
  if (!sync || (sync.status === "ok" && !sync.uncertainWrite)) return null;

  if (isAwaitingFirstLiveSync(reserves)) {
    return {
      label: "Live sync pending first run",
      tone: "neutral",
      reason: "bootstrap-pending",
      summary: "The first scheduled live reserve sync has not run yet.",
      rows: ["The first scheduled live reserve sync has not run yet."],
      retryable: false,
    };
  }

  const diagnostics = [...(sync.lastError ? [sync.lastError] : []), ...(sync.warnings ?? [])];
  const ageDiagnostics = diagnostics.map((text) => SOURCE_AGE_DIAGNOSTIC.exec(text));
  const isAgeOnly = (sync.status === "degraded" || sync.status === "error")
    && !sync.uncertainWrite
    && diagnostics.length > 0
    && ageDiagnostics.every((match) => match != null);

  if (isAgeOnly) {
    const ageMatch = ageDiagnostics.find((match) => match != null) ?? null;
    const budgetSec = sync.freshness?.sourceAgeBudgetSec ?? (ageMatch ? Number(ageMatch[2]) : null);
    const ageSec = sync.freshness?.sourceAgeSec ?? (ageMatch ? Number(ageMatch[1]) : null);
    const evidenceDate = reserveEvidenceDate(reserves);
    const label = [
      "Reserve feed stale",
      // en-US month abbreviation: en-GB spells September "Sept".
      ...(evidenceDate != null
        ? [`last report ${new Date(evidenceDate).getUTCDate()} ${new Date(evidenceDate).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" })}`]
        : []),
      ...(budgetSec != null ? [formatBudget(budgetSec)] : []),
    ].join(" · ");
    const rows = [
      "Reason: source-age",
      ...(ageSec != null && budgetSec != null
        ? [`Source age: ${formatDuration(ageSec)} (budget ${formatDuration(budgetSec)})`]
        : []),
      "The latest collected disclosure is older than this source’s accepted reporting window.",
      formatReserveSnapshotLabel(reserves),
    ];
    return {
      label,
      tone: "watch",
      reason: "source-age",
      summary: "The latest collected disclosure is older than this source’s accepted reporting window.",
      rows,
      retryable: false,
    };
  }

  const reason = sync.failureCategory
    ?? (sync.uncertainWrite
      ? "uncertain-write"
      : sync.lastError ? "unclassified" : sync.warnings?.length ? "warnings" : sync.status);
  const base = sync.status === "error" ? "Reserve sync error" : "Reserve sync degraded";
  const rows = [
    `Reason: ${reason}`,
    `Sync status: ${sync.status}`,
    ...(sync.lastError ? [`Last error: ${humanizeDurations(sync.lastError)}`] : []),
    ...(sync.uncertainWrite ? ["Latest write state uncertain"] : []),
    ...(sync.warnings ?? []).map(humanizeDurations),
  ];
  return {
    label: reason === sync.status ? base : `${base} · ${reason}`,
    tone: "watch",
    reason,
    summary: `Live reserve sync reported ${sync.status}. The reviewed reserve composition is unaffected.`,
    rows,
    retryable: false,
  };
}

/**
 * The reserve feed's ops state as one amber/neutral header chip plus disclosure
 * rows: a failed fetch first (it is the freshest signal), else the sync state.
 * Never carries raw adapter error text; ages read in days.
 */
export function buildReserveFeedStatus(
  reserves: ReserveResult | null,
  fetchError: unknown | null,
): ReserveFeedStatusModel | null {
  const sync = reserves ? buildSyncFeedStatus(reserves) : null;
  if (!fetchError) return sync;

  const notice = buildReserveFetchNotice(fetchError, reserves);
  const reason = fetchError instanceof ApiFetchError && fetchError.status === 503
    ? "api-unavailable"
    : isNetworkFetchError(fetchError) ? "network" : "fetch-failed";
  return {
    label: notice.title,
    tone: notice.tone,
    reason,
    summary: notice.message,
    rows: [`Reason: ${reason}`, notice.message, ...(sync?.rows ?? [])],
    retryable: true,
  };
}

/**
 * A reserve name that is a contract/facilitator identifier ("GhoDirectFacilitator
 * GSMs Mainnet", a bare address) rather than words a reader can parse: a long
 * CamelCase token. A parenthetical expansion ("cbBTC (Coinbase Wrapped BTC)")
 * counts as human, and short tickers ("wstETH", "stataUSDT") are left alone.
 */
function isIdentifierLike(name: string): boolean {
  if (name.includes("(")) return false;
  if (/0x[0-9a-f]{6,}/i.test(name)) return true;
  return name.split(/\s+/).some((token) =>
    token.length >= 12 && (token.match(/[a-z][A-Z]/g)?.length ?? 0) >= 2,
  );
}

/**
 * The label a reader sees on a tile or bar segment. Identifier-like names fall
 * back to the reviewed obligor description ("Aave V3 Plasma market"), else to the
 * name with its CamelCase split; contract identifiers never reach the visual.
 */
export function reserveSliceLabel(name: string, obligor: string | null | undefined): string {
  if (!isIdentifierLike(name)) return name;
  return obligor?.trim() ? obligor.trim() : name.replace(/([a-z])([A-Z])/g, "$1 $2");
}

export function reviewedCompositionSlices(summary: ReserveQualityClientSummary): ReserveCompositionSlice[] {
  return summary.slices
    .map((slice) => ({
      key: slice.key,
      label: reserveSliceLabel(slice.name, slice.obligor),
      pct: slice.pct,
      risk: slice.risk,
      detail: [slice.obligor, slice.assetClassLabel, slice.horizonLabel].filter(Boolean).join(" · ") || null,
      role: slice.assetClassLabel,
    }))
    .sort((a, b) => b.pct - a.pct);
}

/** The wrapped parent's reviewed slices, drawn in the wrapper's Reserves module as a look-through. */
export function lookThroughCompositionSlices(lookThrough: ReserveLookThroughClientSummary): ReserveCompositionSlice[] {
  return lookThrough.slices
    .filter((slice) => Number.isFinite(slice.pct) && slice.pct > 0)
    .map((slice) => ({
      key: slice.key,
      label: reserveSliceLabel(slice.name, slice.obligor),
      pct: slice.pct,
      risk: slice.risk,
      detail: [slice.obligor, slice.assetClassLabel].filter(Boolean).join(" · ") || null,
      role: slice.assetClassLabel,
    }))
    .sort((a, b) => b.pct - a.pct);
}

export function compositionSlices(slices: readonly ReserveSlice[]): ReserveCompositionSlice[] {
  return slices
    .filter((slice) => Number.isFinite(slice.pct) && slice.pct > 0)
    .map((slice, index) => ({
      key: `${slice.name}:${index}`,
      label: reserveSliceLabel(slice.name, slice.issuerOrObligor),
      pct: slice.pct,
      risk: slice.risk,
      detail: slice.issuerOrObligor ?? null,
    }))
    .sort((a, b) => b.pct - a.pct);
}

/** Largest per-rank share gap, in points, below which two snapshots read as the same composition. */
const SAME_COMPOSITION_TOLERANCE_PCT = 0.5;

/** Identity key for a slice: lowercase alphanumerics of the name, ignoring any parenthetical expansion. */
function sliceIdentity(label: string): string {
  return label.replace(/\(.*?\)/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Whether the live attestation/proof composition differs from the reviewed
 * slices. It reads as the same only when, rank by rank, both the share (within
 * half a point) and the slice identity (normalized name) match: 100% ETH against
 * 100% USDC has identical shares and is still a different composition. Reviewed
 * and live feeds often name the same asset differently, so a "differs" result
 * means "not provably the same", which is the conservative wording.
 */
export function liveCompositionDiffers(
  live: readonly ReserveCompositionSlice[],
  reviewed: readonly ReserveCompositionSlice[],
): boolean {
  if (live.length !== reviewed.length) return true;
  return live.some((slice, index) => {
    const counterpart = reviewed[index]!;
    return Math.abs(slice.pct - counterpart.pct) > SAME_COMPOSITION_TOLERANCE_PCT
      || sliceIdentity(slice.label) !== sliceIdentity(counterpart.label);
  });
}
