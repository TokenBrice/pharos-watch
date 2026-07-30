import type { DdrResponse, DdrV2ResponseRow, DdrV2Row } from "../../types/depeg-resolver";
import { DDR_HASH_DOMAINS, stableJsonHashV1 } from "./hash";

export type DdrPublicContractValidationResult =
  | { ok: true; basePayloadHash: string }
  | { ok: false; reason: string };

function stripLive(row: DdrV2ResponseRow): DdrV2Row {
  const { live: _live, ...baseRow } = row;
  const prediction = recordValue(baseRow.prediction);
  if (!prediction) return baseRow as DdrV2Row;
  const { lockTrigger: rawLockTrigger, readiness, backstop, ...stablePrediction } = prediction;
  const lockTrigger = hashableLockTrigger(rawLockTrigger);
  if (lockTrigger !== undefined) stablePrediction.lockTrigger = lockTrigger;
  if (readiness != null) stablePrediction.readiness = readiness;
  if (backstop != null) stablePrediction.backstop = backstop;
  return {
    ...baseRow,
    prediction: stablePrediction,
  } as DdrV2Row;
}

function sortedPredictionIds(rows: readonly DdrV2ResponseRow[]): number[] {
  return rows
    .map((row) => row.prediction.publicPredictionId)
    .filter((id): id is number => id != null)
    .sort((a, b) => a - b);
}

function rowHashMap(rows: readonly DdrV2ResponseRow[]): Record<string, string> {
  const pairs = rows
    .map((row) => {
      const id = row.prediction.publicPredictionId;
      const rowHash = row.prediction.rowHash;
      return id != null && rowHash ? ([String(id), rowHash] as const) : null;
    })
    .filter((entry): entry is readonly [string, string] => entry != null)
    .sort(([left], [right]) => Number(left) - Number(right));
  return Object.fromEntries(pairs);
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function predictionRecord(row: Record<string, unknown>): Record<string, unknown> {
  const prediction = recordValue(row.prediction);
  if (!prediction) throw new Error("DDR public row is missing prediction metadata");
  return prediction;
}

function hashableLockTrigger(value: unknown): unknown {
  return value === "scheduled_24h" ? undefined : value;
}

function canonicalPredictionForHash(row: Record<string, unknown>): Record<string, unknown> {
  const prediction = predictionRecord(row);
  return {
    incidentKey: prediction.incidentKey ?? row.incidentKey,
    eligibleAt: prediction.eligibleAt,
    lockedAt: prediction.lockedAt,
    eventAgeAtLockSec: prediction.eventAgeAtLockSec,
    lockTiming: prediction.lockTiming,
    lockTrigger: hashableLockTrigger(prediction.lockTrigger),
    readiness: prediction.readiness ?? undefined,
    backstop: prediction.backstop ?? undefined,
    policyDelaySec: prediction.policyDelaySec,
    predictionPolicyVersion: prediction.predictionPolicyVersion,
    predictionMethodologyVersion: prediction.predictionMethodologyVersion,
    predictionMethodologyVersionLabel: prediction.predictionMethodologyVersionLabel,
    resolutionRubricVersion: prediction.resolutionRubricVersion,
    durationModelVersion: prediction.durationModelVersion,
    incidentGroupingVersion: prediction.incidentGroupingVersion,
    supportRulesVersion: prediction.supportRulesVersion,
  };
}

function canonicalBaseRowForHash(row: Record<string, unknown>): Record<string, unknown> {
  return {
    eventId: row.eventId,
    incidentKey: row.incidentKey,
    stablecoinId: row.stablecoinId,
    symbol: row.symbol,
    name: row.name,
    pegCurrency: row.pegCurrency,
    governance: row.governance,
    status: row.status ?? null,
    direction: row.direction,
    startedAt: row.startedAt,
  };
}

export function computeDdrPublicRowHash(row: unknown): string {
  const rowRecord = recordValue(row);
  if (!rowRecord) throw new Error("DDR public row hash payload must be an object");
  const kind = rowRecord.kind;
  if (kind !== "prediction" && kind !== "no_call" && kind !== "invalidated_prediction") {
    throw new Error("DDR public row hash is only defined for prediction, no_call, and invalidated rows");
  }
  const originalKind = kind === "invalidated_prediction" ? rowRecord.originalKind : kind;
  if (originalKind !== "prediction" && originalKind !== "no_call") {
    throw new Error("DDR invalidated row is missing original prediction kind");
  }
  const outcomeKey = originalKind === "prediction" ? "frozen" : "noCall";
  const outcome = kind === "invalidated_prediction"
    ? rowRecord.originalOutcome ?? rowRecord[outcomeKey]
    : rowRecord[outcomeKey];
  if (outcome == null) throw new Error(`DDR ${kind} row is missing ${outcomeKey} payload`);

  const payload = {
    ...canonicalBaseRowForHash(rowRecord),
    kind: originalKind,
    prediction: canonicalPredictionForHash(rowRecord),
    [outcomeKey]: outcome,
  };
  const domain = originalKind === "prediction" ? DDR_HASH_DOMAINS.publicPrediction : DDR_HASH_DOMAINS.publicNoCall;
  return stableJsonHashV1(domain, payload);
}

export function attachDdrPublicRowHash<T extends Record<string, unknown>>(row: T, rowHash: string): T {
  const prediction = predictionRecord(row);
  return {
    ...row,
    prediction: {
      ...prediction,
      rowHash,
    },
  };
}

export function buildDdrManifestBasePayload(response: DdrResponse): unknown {
  return {
    _meta: {
      schemaVersion: response._meta.schemaVersion,
      snapshotGeneration: response._meta.snapshotGeneration,
      publicPredictionIds: response._meta.publicPredictionIds,
      publicPredictionRowHashes: response._meta.publicPredictionRowHashes,
      publicWarning: response._meta.publicWarning,
      resolutionRubricVersion: response._meta.resolutionRubricVersion,
      durationModelVersion: response._meta.durationModelVersion,
      durationBand: response._meta.durationBand,
      incidentGroupingVersion: response._meta.incidentGroupingVersion,
      supportRulesVersion: response._meta.supportRulesVersion,
      lineage: response._meta.lineage,
    },
    rows: response.rows.map(stripLive),
    methodology: response.methodology,
  };
}

export function computeDdrManifestBasePayloadHash(response: DdrResponse): string {
  return stableJsonHashV1(DDR_HASH_DOMAINS.publicationManifest, buildDdrManifestBasePayload(response));
}

export function validateDdrPublicCacheContract(response: DdrResponse): DdrPublicContractValidationResult {
  if (response._meta.schemaVersion !== 2) {
    return { ok: false, reason: "schema-version-mismatch" };
  }

  const actualIds = sortedPredictionIds(response.rows);
  if (JSON.stringify(actualIds) !== JSON.stringify(response._meta.publicPredictionIds)) {
    return { ok: false, reason: "public-prediction-id-set-mismatch" };
  }

  for (const row of response.rows) {
    if (row.prediction.publicPredictionId != null && !row.prediction.rowHash) {
      return { ok: false, reason: "public-prediction-row-hash-missing" };
    }
  }

  const metaHashIds = Object.keys(response._meta.publicPredictionRowHashes).map(Number).sort((left, right) => left - right);
  if (JSON.stringify(metaHashIds) !== JSON.stringify(response._meta.publicPredictionIds)) {
    return { ok: false, reason: "public-prediction-row-hash-key-set-mismatch" };
  }

  const actualRowHashes = rowHashMap(response.rows);
  // Prediction ids are canonical numeric object keys, so JSON.stringify emits
  // them in numeric property order; rowHashMap sorts first to make row order irrelevant.
  if (JSON.stringify(actualRowHashes) !== JSON.stringify(response._meta.publicPredictionRowHashes)) {
    return { ok: false, reason: "public-prediction-row-hash-map-mismatch" };
  }

  const idsHash = stableJsonHashV1(DDR_HASH_DOMAINS.publicPredictionIds, actualIds);
  if (idsHash.length !== 64) {
    return { ok: false, reason: "public-prediction-id-hash-invalid" };
  }

  const basePayloadHash = computeDdrManifestBasePayloadHash(response);
  if (response._meta.basePayloadHash != null && response._meta.basePayloadHash !== basePayloadHash) {
    return { ok: false, reason: "base-payload-hash-mismatch" };
  }

  return { ok: true, basePayloadHash };
}
