import {
  getLiveReserveAdapterDefinition,
} from "@shared/lib/live-reserve-adapters";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import type {
  LiveReserveAdapterKey,
  LiveReserveEvidenceClass,
  LiveReserveFreshnessMode,
  LiveReserveRedemptionCapacityKind,
  LiveReserveRedemptionFreshnessKind,
  LiveReserveRedemptionRouteStatus,
  LiveReserveSnapshotMetadata,
  LiveReserveSourceModel,
  LiveReserveWarning,
} from "@shared/types/live-reserves";
import type { ReserveSlice } from "@shared/types/core";
import { decodeJsonString } from "./cache-json";
import { shouldUseLegacySnapshotFallback } from "./live-reserves-store-legacy";
import type {
  ReserveCompositionRecord,
  ReserveCompositionRow,
  ReserveSyncStateRecord,
  SnapshotIntegrityIssue,
} from "./live-reserves-store-shared";

const VALID_RISKS = new Set(["very-low", "low", "medium", "high", "very-high"]);
const VALID_SOURCE_MODELS = new Set<LiveReserveSourceModel>(["dynamic-mix", "validated-static", "single-bucket"]);
const VALID_EVIDENCE_CLASSES = new Set<LiveReserveEvidenceClass>(["independent", "static-validated", "weak-live-probe"]);
const VALID_WARNING_EFFECTS = new Set(["info", "degraded", "fatal"]);
const VALID_FRESHNESS_MODES = new Set<LiveReserveFreshnessMode>(["verified", "unverified", "not-applicable"]);
const VALID_REDEMPTION_CAPACITY_KINDS = new Set<LiveReserveRedemptionCapacityKind>([
  "live-direct",
  "live-direct-bounded",
  "live-queue",
  "live-proxy-validated",
  "documented-bound",
  "documented-eventual",
  "heuristic",
]);
const VALID_REDEMPTION_FRESHNESS_KINDS = new Set<LiveReserveRedemptionFreshnessKind>([
  "verified-source-timestamp",
  "same-run-onchain",
  "same-run-api",
  "reviewed-static",
  "unverified",
]);
const VALID_REDEMPTION_ROUTE_STATUSES = new Set<LiveReserveRedemptionRouteStatus>([
  "open",
  "degraded",
  "paused",
  "cohort-limited",
  "unknown",
]);
const STORED_SLICE_SUM_TOLERANCE = 2;

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  const decoded = decodeJsonString<Record<string, unknown>, "json-parse-failed" | "invalid-payload">(value, {
    mode: "best-effort",
    parseErrorReason: "json-parse-failed",
    normalize: (parsed) => (
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? { ok: true, payload: parsed as Record<string, unknown> }
        : { ok: false, reason: "invalid-payload" }
    ),
  });
  return decoded.payload ?? {};
}

function coerceFiniteMetadataNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeSnapshotMetadata(metadata: Record<string, unknown>): LiveReserveSnapshotMetadata {
  const normalized: LiveReserveSnapshotMetadata = { ...metadata };
  const knownNumberKeys: Array<keyof LiveReserveSnapshotMetadata> = [
    "sourceTimestamp",
    "unknownExposurePct",
    "supplyUsd",
    "totalReserveUsd",
    "totalAssetsUsd",
    "totalLiabilitiesUsd",
    "shareholderEquityUsd",
    "collateralizationRatio",
    "immediateRedeemableUsd",
    "immediateRedeemableRatio",
    "redemptionFeeBps",
    "buyFeeBpsMin",
    "buyFeeBpsMax",
  ];

  for (const key of knownNumberKeys) {
    const value = coerceFiniteMetadataNumber(metadata[key]);
    if (value == null) {
      delete normalized[key];
    } else {
      normalized[key] = value;
    }
  }

  const freshnessMode = metadata.freshnessMode;
  if (typeof freshnessMode === "string" && VALID_FRESHNESS_MODES.has(freshnessMode as LiveReserveFreshnessMode)) {
    normalized.freshnessMode = freshnessMode as LiveReserveFreshnessMode;
  } else {
    delete normalized.freshnessMode;
  }

  if (metadata.details && typeof metadata.details === "object" && !Array.isArray(metadata.details)) {
    normalized.details = metadata.details as Record<string, unknown>;
  } else {
    delete normalized.details;
  }

  if (metadata.redemption && typeof metadata.redemption === "object" && !Array.isArray(metadata.redemption)) {
    const rawRedemption = metadata.redemption as Record<string, unknown>;
    const redemption: NonNullable<LiveReserveSnapshotMetadata["redemption"]> = { ...rawRedemption };
    const knownRedemptionNumberKeys: Array<keyof NonNullable<LiveReserveSnapshotMetadata["redemption"]>> = [
      "capacityUsd",
      "capacityRatioOfSupply",
      "sourceTimestamp",
      "blockNumber",
      "settlementDelaySec",
      "queueDepthUsd",
      "dailyLimitUsd",
      "minRedeemUsd",
      "feeBps",
    ];
    for (const key of knownRedemptionNumberKeys) {
      const value = coerceFiniteMetadataNumber(rawRedemption[key]);
      if (value == null) {
        delete redemption[key];
      } else {
        redemption[key] = value;
      }
    }

    if (
      typeof rawRedemption.capacityKind === "string" &&
      VALID_REDEMPTION_CAPACITY_KINDS.has(rawRedemption.capacityKind as LiveReserveRedemptionCapacityKind)
    ) {
      redemption.capacityKind = rawRedemption.capacityKind as LiveReserveRedemptionCapacityKind;
    } else {
      delete redemption.capacityKind;
    }
    if (
      typeof rawRedemption.freshnessKind === "string" &&
      VALID_REDEMPTION_FRESHNESS_KINDS.has(rawRedemption.freshnessKind as LiveReserveRedemptionFreshnessKind)
    ) {
      redemption.freshnessKind = rawRedemption.freshnessKind as LiveReserveRedemptionFreshnessKind;
    } else {
      delete redemption.freshnessKind;
    }
    if (
      typeof rawRedemption.routeStatus === "string" &&
      VALID_REDEMPTION_ROUTE_STATUSES.has(rawRedemption.routeStatus as LiveReserveRedemptionRouteStatus)
    ) {
      redemption.routeStatus = rawRedemption.routeStatus as LiveReserveRedemptionRouteStatus;
    } else {
      delete redemption.routeStatus;
    }
    if (typeof rawRedemption.routeStatusReason === "string") {
      redemption.routeStatusReason = rawRedemption.routeStatusReason;
    } else {
      delete redemption.routeStatusReason;
    }
    if (typeof rawRedemption.holderEligibility === "string") {
      redemption.holderEligibility = rawRedemption.holderEligibility;
    } else {
      delete redemption.holderEligibility;
    }
    if (Array.isArray(rawRedemption.sourceUrls)) {
      redemption.sourceUrls = rawRedemption.sourceUrls.filter((url): url is string => typeof url === "string");
    } else {
      delete redemption.sourceUrls;
    }
    normalized.redemption = redemption;
  } else {
    delete normalized.redemption;
  }

  return normalized;
}

export function parseSnapshotMetadata(value: string | null | undefined): LiveReserveSnapshotMetadata {
  return normalizeSnapshotMetadata(parseJsonObject(value));
}

export function parseWarnings(value: string | null): LiveReserveWarning[] {
  if (!value) return [];
  const decoded = decodeJsonString<LiveReserveWarning[], "json-parse-failed">(value, {
    mode: "best-effort",
    parseErrorReason: "json-parse-failed",
    normalize: (parsed) => ({
      ok: true,
      payload: Array.isArray(parsed)
        ? parsed.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const code = typeof item.code === "string" ? item.code : null;
          const message = typeof item.message === "string" ? item.message : null;
          if (!code || !message) return [];
          const severity = item.severity === "info" ? "info" : "warning";
          const effect = typeof item.effect === "string" && VALID_WARNING_EFFECTS.has(item.effect)
            ? item.effect as LiveReserveWarning["effect"]
            : severity === "info"
              ? "info"
              : "degraded";
          return [{ code, message, severity, effect }];
        })
        : [],
    }),
  });
  return decoded.payload ?? [];
}

function isValidSlice(item: unknown): item is ReserveSlice {
  if (!item || typeof item !== "object") return false;
  const slice = item as Partial<ReserveSlice>;
  return (
    typeof slice.name === "string"
    && slice.name.length > 0
    && typeof slice.pct === "number"
    && Number.isFinite(slice.pct)
    && slice.pct > 0
    && typeof slice.risk === "string"
    && VALID_RISKS.has(slice.risk)
  );
}

function parseSlicesStrict(value: string): { slices: ReserveSlice[] } | { issue: SnapshotIntegrityIssue } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return {
      issue: {
        code: "invalid-json",
        message: "stored reserve snapshot JSON could not be parsed",
      },
    };
  }

  if (!Array.isArray(parsed)) {
    return {
      issue: {
        code: "invalid-payload",
        message: "stored reserve snapshot is not a slice array",
      },
    };
  }

  if (parsed.length === 0) {
    return {
      issue: {
        code: "empty-slices",
        message: "stored reserve snapshot contains zero slices",
      },
    };
  }

  const slices: ReserveSlice[] = [];
  for (const item of parsed) {
    if (!isValidSlice(item)) {
      return {
        issue: {
          code: "invalid-slice",
          message: "stored reserve snapshot contains invalid slice entries",
        },
      };
    }
    slices.push(item);
  }

  const sum = slices.reduce((acc, slice) => acc + slice.pct, 0);
  if (Math.abs(sum - 100) > STORED_SLICE_SUM_TOLERANCE) {
    return {
      issue: {
        code: "invalid-sum",
        message: `stored reserve snapshot percentages sum to ${sum.toFixed(1)}%`,
      },
    };
  }

  return { slices };
}

function resolveSnapshotSourceModel(
  row: ReserveCompositionRow,
  fallbackAdapterKey: string,
): LiveReserveSourceModel {
  if (row.adapter_source_model && VALID_SOURCE_MODELS.has(row.adapter_source_model as LiveReserveSourceModel)) {
    return row.adapter_source_model as LiveReserveSourceModel;
  }
  return getLiveReserveAdapterDefinition(fallbackAdapterKey as LiveReserveAdapterKey).sourceModel;
}

function resolveSnapshotEvidenceClass(
  row: ReserveCompositionRow,
  fallbackAdapterKey: string,
): LiveReserveEvidenceClass {
  if (row.adapter_evidence_class && VALID_EVIDENCE_CLASSES.has(row.adapter_evidence_class as LiveReserveEvidenceClass)) {
    return row.adapter_evidence_class as LiveReserveEvidenceClass;
  }
  return getLiveReserveAdapterDefinition(fallbackAdapterKey as LiveReserveAdapterKey).evidenceClass;
}

export function parseReserveCompositionRow(
  row: ReserveCompositionRow,
  syncState: ReserveSyncStateRecord | null,
): { record: ReserveCompositionRecord | null; issue: SnapshotIntegrityIssue | null } {
  const parsedSlices = parseSlicesStrict(row.slices);
  if ("issue" in parsedSlices) {
    return { record: null, issue: parsedSlices.issue };
  }

  const fallbackAdapterKey = syncState?.adapterKey
    ?? TRACKED_META_BY_ID.get(row.stablecoin_id)?.liveReservesConfig?.adapter
    ?? row.source;
  const metadata = parseSnapshotMetadata(row.metadata);
  const warnings = parseWarnings(row.warnings ?? null);
  const allowLegacyRecovery = shouldUseLegacySnapshotFallback(syncState, {
    fetchedAt: row.fetched_at,
    attemptId: row.attempt_id ?? null,
  });
  const legacyMetadata = allowLegacyRecovery
    ? normalizeSnapshotMetadata(syncState?.metadata ?? {})
    : {};
  const finalMetadata = Object.keys(metadata).length === 0 && Object.keys(legacyMetadata).length > 0 ? legacyMetadata : metadata;
  const finalWarnings = warnings.length === 0 && allowLegacyRecovery
    ? syncState?.warnings ?? []
    : warnings;
  const warningCount = typeof row.warning_count === "number" && Number.isFinite(row.warning_count)
    ? row.warning_count
    : finalWarnings.length;

  return {
    record: {
      stablecoinId: row.stablecoin_id,
      slices: parsedSlices.slices,
      fetchedAt: row.fetched_at,
      source: row.source,
      attemptId: row.attempt_id ?? null,
      metadata: finalMetadata,
      warningCount,
      warnings: finalWarnings,
      adapterSourceModel: resolveSnapshotSourceModel(row, fallbackAdapterKey),
      adapterEvidenceClass: resolveSnapshotEvidenceClass(row, fallbackAdapterKey),
    },
    issue: null,
  };
}
