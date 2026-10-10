import { getLiveReserveAdapterDefinition } from "@shared/lib/live-reserve-adapters";
import { WORKER_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import {
  decodeLiveReserveRedemptionTelemetry,
  LiveReserveDiagnosticsSchema,
  LIVE_RESERVE_SOURCE_MODEL_VALUES,
  LIVE_RESERVE_EVIDENCE_CLASS_VALUES,
  LIVE_RESERVE_WARNING_EFFECT_VALUES,
  LIVE_RESERVE_FRESHNESS_MODE_VALUES,
  MALFORMED_REDEMPTION_TELEMETRY,
  type LiveReserveEvidenceClass,
  type LiveReserveFreshnessMode,
  type LiveReserveSnapshotMetadata,
  type LiveReserveSourceModel,
  type LiveReserveWarning,
} from "@shared/types/live-reserves";
import { ReserveSliceSchema, type ReserveSlice } from "@shared/types/reserves";
import { decodeJsonString } from "../cache-json";
import { shouldUseLegacySnapshotFallback } from "./store-snapshot-state";
import type {
  ReserveCompositionRecord,
  ReserveCompositionRow,
  ReserveSyncStateRecord,
  SnapshotIntegrityIssue,
} from "./store-shared";

const STORED_SLICE_SUM_TOLERANCE = 2;

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  const decoded = decodeJsonString<Record<string, unknown>, "json-parse-failed" | "invalid-payload">(value, {
    parseErrorReason: "json-parse-failed",
    normalize: (parsed) =>
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? { ok: true, payload: parsed as Record<string, unknown> }
        : { ok: false, reason: "invalid-payload" },
  });
  return decoded.payload ?? { diag: { invalidFreshness: true } };
}

function coerceFiniteMetadataNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function hasOwnMetadataKey(record: Record<string, unknown>, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isMalformedMetadataNumber(value: unknown): boolean {
  return typeof value !== "number" || !Number.isFinite(value);
}

function markMalformedRedemptionTelemetry(redemption: object): void {
  Object.defineProperty(redemption, MALFORMED_REDEMPTION_TELEMETRY, {
    value: true,
    enumerable: true,
  });
}

function normalizeSnapshotMetadata(metadata: Record<string, unknown>): LiveReserveSnapshotMetadata {
  const normalized: LiveReserveSnapshotMetadata = { ...metadata };
  const invalidFreshness =
    (hasOwnMetadataKey(metadata, "freshnessMode")
      && !LIVE_RESERVE_FRESHNESS_MODE_VALUES.includes(metadata.freshnessMode as LiveReserveFreshnessMode))
    || (hasOwnMetadataKey(metadata, "sourceTimestamp")
      && (isMalformedMetadataNumber(metadata.sourceTimestamp) || (metadata.sourceTimestamp as number) <= 0));
  if (invalidFreshness && (
    !hasOwnMetadataKey(metadata, "diag") ||
    (metadata.diag && typeof metadata.diag === "object" && !Array.isArray(metadata.diag))
  )) {
    normalized.diag = {
      ...(metadata.diag && typeof metadata.diag === "object" && !Array.isArray(metadata.diag) ? metadata.diag : {}),
      invalidFreshness: true,
    };
  }
  const knownNumberKeys: Array<keyof LiveReserveSnapshotMetadata> = [
    "sourceTimestamp",
    "referenceNavUsd",
    "unknownExposurePct",
    "supplyUsd",
    "totalReserveUsd",
    "supplyTokens",
    "circulatingSupplyTokens",
    "totalReserveQuantity",
    "totalAssetsUsd",
    "totalLiabilitiesUsd",
    "shareholderEquityUsd",
    "collateralizationRatio",
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
  if (typeof freshnessMode === "string" && LIVE_RESERVE_FRESHNESS_MODE_VALUES.includes(freshnessMode as LiveReserveFreshnessMode)) {
    normalized.freshnessMode = freshnessMode as LiveReserveFreshnessMode;
  } else {
    delete normalized.freshnessMode;
  }

  if (metadata.details && typeof metadata.details === "object" && !Array.isArray(metadata.details)) {
    normalized.details = metadata.details as Record<string, unknown>;
  } else {
    delete normalized.details;
  }

  // Normalize legacy fields only here. A present nested block wins even when invalid.
  let telemetryMetadata = metadata;
  if (!hasOwnMetadataKey(metadata, "redemption")) {
    const legacy: Record<string, unknown> = {};
    if (metadata.immediateRedeemableUsd != null) legacy.capacityUsd = metadata.immediateRedeemableUsd;
    if (metadata.immediateRedeemableRatio != null) legacy.capacityRatioOfSupply = metadata.immediateRedeemableRatio;
    if (metadata.redemptionFeeBps != null) legacy.feeBps = metadata.redemptionFeeBps;
    if (Object.keys(legacy).length > 0) telemetryMetadata = { redemption: legacy };
  }
  const decoded = decodeLiveReserveRedemptionTelemetry(telemetryMetadata);
  if (decoded.status === "valid") {
    normalized.redemption = decoded.telemetry;
  } else if (decoded.status === "invalid") {
    // Quarantine the entire claim, not just its invalid constraint. In particular
    // a positive capacity cannot survive a malformed daily limit after JSON.
    normalized.redemption = {};
    markMalformedRedemptionTelemetry(normalized.redemption);
  } else {
    delete normalized.redemption;
  }
  delete normalized.immediateRedeemableUsd;
  delete normalized.immediateRedeemableRatio;
  delete normalized.redemptionFeeBps;

  return normalized;
}

export function parseSnapshotMetadata(value: string | null | undefined): LiveReserveSnapshotMetadata {
  return normalizeSnapshotMetadata(parseJsonObject(value));
}

export function parseWarningsStrict(
  value: string | null | undefined,
  warningCount?: number | null,
): { warnings: LiveReserveWarning[]; issue: null } | { warnings: null; issue: SnapshotIntegrityIssue } {
  const invalid = (message: string) => ({
    warnings: null,
    issue: { code: "invalid-warnings" as const, message },
  });
  let parsed: unknown = [];
  if (value != null) {
    try { parsed = JSON.parse(value); }
    catch { return invalid("stored reserve warnings contain invalid JSON"); }
  }
  if (!Array.isArray(parsed)) return invalid("stored reserve warnings are not an array");
  const warnings: LiveReserveWarning[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
      typeof item.code !== "string" || !item.code.trim() ||
      typeof item.message !== "string" || !item.message.trim() ||
      ("severity" in item && item.severity !== "info" && item.severity !== "warning") ||
      ("effect" in item && !LIVE_RESERVE_WARNING_EFFECT_VALUES.includes(item.effect))) {
      return invalid("stored reserve warnings contain an invalid member");
    }
    const severity = item.severity === "info" ? "info" : "warning";
    const effect = item.effect ?? (severity === "info" ? "info" : "degraded");
    warnings.push({ code: item.code, message: item.message, severity, effect });
  }
  if (warningCount != null && (!Number.isSafeInteger(warningCount) || warningCount !== warnings.length)) {
    return invalid("stored reserve warning count does not match its payload");
  }
  return { warnings, issue: null };
}


function isValidSlice(item: unknown, subjectId: string): item is ReserveSlice {
  const parsed = ReserveSliceSchema.safeParse(item);
  if (!parsed.success) return false;
  const slice = parsed.data;
  if (slice.name.trim().length === 0) return false;
  if (slice.depType != null && !slice.coinId) return false;
  if (slice.coinId === subjectId) return false;
  if (slice.coinId != null && !WORKER_TRACKED_META_BY_ID.has(slice.coinId)) return false;
  return true;
}

function parseSlicesStrict(
  value: string,
  subjectId: string,
): { slices: ReserveSlice[] } | { issue: SnapshotIntegrityIssue } {
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
    if (!isValidSlice(item, subjectId)) {
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
): LiveReserveSourceModel | null {
  if (row.adapter_source_model && LIVE_RESERVE_SOURCE_MODEL_VALUES.includes(row.adapter_source_model as LiveReserveSourceModel)) {
    return row.adapter_source_model as LiveReserveSourceModel;
  }
  return getLiveReserveAdapterDefinition(fallbackAdapterKey)?.sourceModel ?? null;
}

function resolveSnapshotEvidenceClass(
  row: ReserveCompositionRow,
  fallbackAdapterKey: string,
): LiveReserveEvidenceClass | null {
  if (
    row.adapter_evidence_class &&
    LIVE_RESERVE_EVIDENCE_CLASS_VALUES.includes(row.adapter_evidence_class as LiveReserveEvidenceClass)
  ) {
    return row.adapter_evidence_class as LiveReserveEvidenceClass;
  }
  return getLiveReserveAdapterDefinition(fallbackAdapterKey)?.evidenceClass ?? null;
}

export function parseReserveCompositionRow(
  row: ReserveCompositionRow,
  syncState: ReserveSyncStateRecord | null,
): { record: ReserveCompositionRecord | null; issue: SnapshotIntegrityIssue | null } {
  const parsedSlices = parseSlicesStrict(row.slices, row.stablecoin_id);
  if ("issue" in parsedSlices) {
    return { record: null, issue: parsedSlices.issue };
  }

  const fallbackAdapterKey =
    syncState?.adapterKey ?? WORKER_TRACKED_META_BY_ID.get(row.stablecoin_id)?.liveReservesConfig?.adapter ?? row.source;
  const metadata = parseSnapshotMetadata(row.metadata);
  const parsedWarnings = parseWarningsStrict(row.warnings);
  if (parsedWarnings.issue) return { record: null, issue: parsedWarnings.issue };
  const warnings = parsedWarnings.warnings;
  const allowLegacyRecovery = shouldUseLegacySnapshotFallback(syncState, {
    fetchedAt: row.fetched_at,
    attemptId: row.attempt_id ?? null,
  });
  const legacyMetadata = allowLegacyRecovery ? normalizeSnapshotMetadata(syncState?.metadata ?? {}) : {};
  const finalMetadata =
    Object.keys(metadata).length === 0 && Object.keys(legacyMetadata).length > 0 ? legacyMetadata : metadata;
  const finalWarnings = warnings.length === 0 && allowLegacyRecovery ? (syncState?.warnings ?? []) : warnings;
  if (warnings.length === 0 && allowLegacyRecovery && syncState?.warningIntegrityIssue) {
    return { record: null, issue: syncState.warningIntegrityIssue };
  }
  const warningIntegrity = parseWarningsStrict(JSON.stringify(finalWarnings), row.warning_count);
  if (warningIntegrity.issue) return { record: null, issue: warningIntegrity.issue };
  const warningCount = finalWarnings.length;

  const diagnostics = LiveReserveDiagnosticsSchema.safeParse(finalMetadata.diag);
  if (hasOwnMetadataKey(finalMetadata, "diag") && (
    !diagnostics.success ||
    (finalMetadata.diag && hasOwnMetadataKey(finalMetadata.diag, "rawSumDeviation") &&
      !LiveReserveDiagnosticsSchema.shape.rawSumDeviation.unwrap().safeParse(finalMetadata.diag.rawSumDeviation).success)
  )) {
    return {
      record: null,
      issue: { code: "invalid-payload", message: "stored reserve snapshot diagnostics are malformed" },
    };
  }

  const adapterSourceModel = resolveSnapshotSourceModel(row, fallbackAdapterKey);
  const adapterEvidenceClass = resolveSnapshotEvidenceClass(row, fallbackAdapterKey);
  if (adapterSourceModel === null || adapterEvidenceClass === null) {
    return {
      record: null,
      issue: {
        code: "unknown-adapter-source",
        message: `stored reserve snapshot references unknown adapter "${fallbackAdapterKey}"`,
      },
    };
  }

  return {
    record: {
      stablecoinId: row.stablecoin_id,
      slices: parsedSlices.slices,
      fetchedAt: row.fetched_at,
      source: row.source,
      attemptId: row.attempt_id ?? null,
      configFingerprint: row.config_fingerprint ?? null,
      metadata: finalMetadata,
      warningCount,
      warnings: finalWarnings,
      adapterSourceModel,
      adapterEvidenceClass,
    },
    issue: null,
  };
}
