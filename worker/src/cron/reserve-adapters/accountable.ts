import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { AdapterContext, AdapterResult } from "./types";
import {
  buildCoverageShortfallWarnings,
  buildUnknownExposureWarning,
  computeUnknownExposurePct,
  fetchJsonWithRetry,
  freshnessMetadataFromTimestamp,
  parseTimestampLikeToUnixSeconds,
  requireJsonInputFromConfig,
  reserveDegradedWarning,
  slicesFromValues,
} from "./helpers";
import { toFiniteNumber } from "../../lib/number-utils";

interface AccountableDashboardResponse {
  res: string;
  data?: {
    collateralization: number;
    ts: string;
    reserves?: {
      interval?: string;
      verifiability?: string;
      total_reserves?: unknown;
      type?: Record<string, unknown>;
      reserves_split?: unknown;
      deployment?: Record<string, unknown>;
      type_split?: Record<string, unknown>;
      stablecoin_split?: Record<string, unknown>;
      exposure_split?: Record<string, unknown>;
      protocol_split?: Record<string, unknown>;
    };
  };
}

interface AccountableParams {
  bucket?: "type" | "reserves_split" | "deployment" | "type_split" | "stablecoin_split" | "exposure_split" | "protocol_split";
  riskMap?: Record<string, ReserveSlice["risk"]>;
  renameMap?: Record<string, string>;
  coinIdMap?: Record<string, string>;
  depTypeMap?: Record<string, ReserveSlice["depType"]>;
  totalReservesExcludeBuckets?: string[];
  allowNegativeBuckets?: string[];
  skipTotalReservesValidation?: boolean;
}

const VALID_BUCKETS = new Set(["type", "reserves_split", "deployment", "type_split", "stablecoin_split", "exposure_split", "protocol_split"]);
const TOTAL_RESERVES_RELATIVE_TOLERANCE = 0.01;
const TOTAL_RESERVES_ABSOLUTE_TOLERANCE = 1;

function parseAccountableParams(config: LiveReservesConfig): AccountableParams {
  const params = parseLiveReserveAdapterParams("accountable", config.params);
  if (params.bucket != null && !VALID_BUCKETS.has(params.bucket)) {
    throw new Error(`accountable: invalid bucket "${params.bucket}", expected one of: ${[...VALID_BUCKETS].join(", ")}`);
  }
  return params;
}

function extractAccountableBucketValue(value: unknown, depth = 0): number | null {
  const direct = toFiniteNumber(value);
  if (direct != null) return direct;
  if (depth > 1) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  for (const key of ["value", "usd", "amount", "total"]) {
    const numeric = toFiniteNumber(record[key]);
    if (numeric != null) return numeric;
  }

  const childValues = Object.values(record).map((nested) => extractAccountableBucketValue(nested, depth + 1));
  if (childValues.length === 0 || childValues.some((numeric) => numeric == null)) return null;
  return (childValues as number[]).reduce((sum, numeric) => sum + numeric, 0);
}

function requireAccountableBucketValue(
  name: string,
  value: unknown,
  bucket: string,
  options?: { allowNegative?: boolean },
): number {
  const numeric = extractAccountableBucketValue(value);
  if (numeric == null || (!options?.allowNegative && numeric < 0)) {
    throw new Error(`Accountable ${bucket} bucket "${name}" has invalid value: ${String(value)}`);
  }
  return numeric;
}

function extractRecordBucketEntries(
  entries: Record<string, unknown> | undefined,
  bucket: string,
  options?: { allowNegativeBuckets?: ReadonlySet<string> },
): Array<{ name: string; value: number }> {
  return Object.entries(entries ?? {}).map(([name, value]) => ({
    name,
    value: requireAccountableBucketValue(name, value, bucket, {
      allowNegative: options?.allowNegativeBuckets?.has(name),
    }),
  }));
}

function extractReservesSplitEntries(
  value: unknown,
  options?: { allowNegativeBuckets?: ReadonlySet<string> },
): Array<{ name: string; value: number }> {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new Error("Accountable reserves_split bucket must be an array");
  }

  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Accountable reserves_split entry ${index} is invalid`);
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== "string" || record.name.trim() === "") {
      throw new Error(`Accountable reserves_split entry ${index} has invalid name`);
    }
    return {
      name: record.name,
      value: requireAccountableBucketValue(record.name, record.value, "reserves_split", {
        allowNegative: options?.allowNegativeBuckets?.has(record.name),
      }),
    };
  });
}

function extractBucketEntries(
  reserves: NonNullable<NonNullable<AccountableDashboardResponse["data"]>["reserves"]>,
  bucket: NonNullable<AccountableParams["bucket"]>,
  options?: { allowNegativeBuckets?: ReadonlySet<string> },
): Array<{ name: string; value: number }> {
  switch (bucket) {
    case "type":
      return extractRecordBucketEntries(reserves.type, bucket, options);
    case "reserves_split":
      return extractReservesSplitEntries(reserves.reserves_split, options);
    case "deployment":
      return extractRecordBucketEntries(reserves.deployment, bucket, options);
    case "type_split":
      return extractRecordBucketEntries(reserves.type_split, bucket, options);
    case "stablecoin_split":
      return extractRecordBucketEntries(reserves.stablecoin_split, bucket, options);
    case "exposure_split":
      return extractRecordBucketEntries(reserves.exposure_split, bucket, options);
    case "protocol_split":
      return extractRecordBucketEntries(reserves.protocol_split, bucket, options);
    default:
      return [];
  }
}

function extractTotalReserves(value: unknown): number | undefined {
  if (value == null) return undefined;
  const numeric = extractAccountableBucketValue(value);
  if (numeric == null || numeric <= 0) {
    throw new Error(`Accountable total_reserves has invalid value: ${String(value)}`);
  }
  return numeric;
}

function validateMappedBucketValues(
  mapped: Array<{ name: string; value: number }>,
  bucket: string,
  options?: { allowNegativeBuckets?: ReadonlySet<string> },
): void {
  const invalid = mapped.filter((entry) => entry.value <= 0 && !options?.allowNegativeBuckets?.has(entry.name));
  if (invalid.length > 0) {
    throw new Error(`Accountable ${bucket} mapped bucket has non-positive value: ${invalid.map((entry) => entry.name).sort().join(", ")}`);
  }
}

function validateBucketTotalAgainstReserves(
  breakdown: Array<{ name: string; value: number }>,
  totalReserves: number | undefined,
  bucket: string,
  options?: {
    excludeBuckets?: ReadonlySet<string>;
    skipValidation?: boolean;
  },
): void {
  if (totalReserves == null) return;
  const totalValue = breakdown
    .filter((entry) => !(options?.excludeBuckets?.has(entry.name)))
    .reduce((sum, entry) => sum + entry.value, 0);
  const tolerance = Math.max(TOTAL_RESERVES_ABSOLUTE_TOLERANCE, totalReserves * TOTAL_RESERVES_RELATIVE_TOLERANCE);
  if (options?.skipValidation) return;
  if (Math.abs(totalValue - totalReserves) > tolerance) {
    throw new Error(`Accountable ${bucket} bucket total ${totalValue} does not match total_reserves ${totalReserves}`);
  }
}

function buildSignedBucketWarning(
  signedBuckets: Array<{ name: string; value: number }>,
  totalValue: number,
) {
  const signedValue = signedBuckets.reduce((sum, entry) => sum + Math.abs(entry.value), 0);
  const exposurePct = computeUnknownExposurePct(signedValue, totalValue);
  return reserveDegradedWarning(
    "signed-negative-bucket",
    `Accountable signed exposure buckets are omitted from reserve slices: ${
      signedBuckets.map((entry) => entry.name).sort().join(", ")
    } (${exposurePct.toFixed(2)}% of positive reserve buckets)`,
  );
}

function buildSkippedTotalValidationWarning(
  breakdown: Array<{ name: string; value: number }>,
  totalReserves: number | undefined,
  bucket: string,
) {
  if (totalReserves == null) return null;
  const totalValue = breakdown.reduce((sum, entry) => sum + entry.value, 0);
  const tolerance = Math.max(TOTAL_RESERVES_ABSOLUTE_TOLERANCE, totalReserves * TOTAL_RESERVES_RELATIVE_TOLERANCE);
  if (Math.abs(totalValue - totalReserves) <= tolerance) return null;
  return reserveDegradedWarning(
    "total-reserves-unreconciled",
    `Accountable ${bucket} bucket total ${totalValue} does not match total_reserves ${totalReserves}`,
  );
}

function buildDeploymentSnapshotMetadata(
  breakdown: Array<{ name: string; value: number }>,
  dashboardTimestamp: string,
  totalReserves: number | undefined,
) {
  const bucketTotal = breakdown.reduce((sum, entry) => sum + entry.value, 0);
  return {
    buckets: breakdown.map(({ name, value }) => ({ name, value })),
    bucketTotal,
    totalReserves: totalReserves ?? null,
    reconciliationResidual: totalReserves != null ? totalReserves - bucketTotal : null,
    dashboardTimestamp,
  };
}

export function adaptAccountableDashboard(
  payload: AccountableDashboardResponse,
  params: AccountableParams,
): AdapterResult {
  if (payload.res !== "ok" || !payload.data?.reserves) {
    throw new Error("Accountable dashboard returned an invalid response");
  }

  const bucket = params.bucket ?? "type";
  const allowNegativeBuckets = new Set(params.allowNegativeBuckets ?? []);
  const breakdown = extractBucketEntries(payload.data.reserves, bucket, { allowNegativeBuckets });
  if (breakdown.length === 0) {
    throw new Error(`Unsupported Accountable bucket: ${bucket}`);
  }

  const riskMap = params.riskMap ?? {};
  const renameMap = params.renameMap ?? {};
  const coinIdMap = params.coinIdMap ?? {};
  const depTypeMap = params.depTypeMap ?? {};
  const totalReservesExcludeBuckets = new Set(params.totalReservesExcludeBuckets ?? []);
  const signedBuckets = breakdown.filter((entry) => entry.value < 0);
  const reconciledBreakdown = breakdown.filter((entry) => !(totalReservesExcludeBuckets.has(entry.name)));
  const positiveBreakdown = reconciledBreakdown.filter((entry) => entry.value > 0);
  const mappedForValidation = breakdown.filter(({ name }) => name in riskMap);
  validateMappedBucketValues(mappedForValidation, bucket, { allowNegativeBuckets });
  const mapped = positiveBreakdown.filter(({ name }) => name in riskMap);
  const totalReserves = extractTotalReserves(payload.data.reserves.total_reserves);
  validateBucketTotalAgainstReserves(breakdown, totalReserves, bucket, {
    excludeBuckets: totalReservesExcludeBuckets,
    skipValidation: params.skipTotalReservesValidation,
  });
  const totalValidationWarning = params.skipTotalReservesValidation
    ? buildSkippedTotalValidationWarning(breakdown, totalReserves, bucket)
    : null;
  const unknown = positiveBreakdown.filter(({ name }) => !(name in riskMap));
  const totalValue = positiveBreakdown.reduce((sum, entry) => sum + entry.value, 0);
  const unknownValue = unknown.reduce((sum, entry) => sum + entry.value, 0);
  const unknownExposurePct = computeUnknownExposurePct(unknownValue, totalValue);
  const collateralizationRatio = toFiniteNumber(payload.data.collateralization);
  if (collateralizationRatio == null || collateralizationRatio < 0) {
    throw new Error(`Accountable dashboard returned invalid collateralization: ${String(payload.data.collateralization)}`);
  }
  const collateralizationWarnings = buildCoverageShortfallWarnings({
    code: "reserve-undercollateralized",
    message: (pct) => `Accountable dashboard reports ${pct}% collateralization`,
    coverageRatio: collateralizationRatio,
  });

  const slices = slicesFromValues(
    [
      ...mapped.map(({ name, value }) => ({
        name: renameMap[name] ?? name,
        value,
        risk: riskMap[name]!,
        ...(coinIdMap[name] ? { coinId: coinIdMap[name] } : {}),
        ...(depTypeMap[name] ? { depType: depTypeMap[name] } : {}),
      })),
      ...(unknownValue > 0
        ? [{
            name: "Unknown / unmapped Accountable buckets",
            value: unknownValue,
            risk: "high" as const,
          }]
        : []),
    ].map(({ name, value, risk, coinId, depType }) => ({
      name,
      value,
      risk,
      ...(coinId ? { coinId } : {}),
      ...(depType ? { depType } : {}),
    })),
  );

  const sourceTimestamp = parseTimestampLikeToUnixSeconds(payload.data.ts);

  return {
    slices,
    ...((unknownExposurePct > 0 || signedBuckets.length > 0 || totalValidationWarning || collateralizationWarnings.length > 0)
      ? {
          warnings: [
            ...(unknownExposurePct > 0
              ? [buildUnknownExposureWarning({
                  code: "unmapped-bucket",
                  message: `Accountable bucket mapping is missing: ${unknown.map((entry) => entry.name).sort().join(", ")}`,
                  unknownExposurePct,
                })]
              : []),
            ...(signedBuckets.length > 0 ? [buildSignedBucketWarning(signedBuckets, totalValue)] : []),
            ...(totalValidationWarning ? [totalValidationWarning] : []),
            ...collateralizationWarnings,
          ],
        }
      : {}),
    metadata: {
      bucket,
      breakdownCount: breakdown.length,
      mappedBucketCount: mapped.length,
      ...(unknown.length > 0 ? { unknownBucketCount: unknown.length } : {}),
      ...(unknown.length > 0 ? { unknownBucketNames: unknown.map((entry) => entry.name).sort() } : {}),
      ...(unknownExposurePct > 0 ? { unknownExposurePct } : {}),
      collateralization: payload.data.collateralization,
      collateralizationRatio,
      interval: payload.data.reserves.interval,
      verifiability: payload.data.reserves.verifiability,
      totalReserves,
      ...(bucket === "deployment"
        ? {
            deploymentSnapshot: buildDeploymentSnapshotMetadata(
              breakdown,
              payload.data.ts,
              totalReserves,
            ),
          }
        : {}),
      ...(totalReservesExcludeBuckets.size > 0
        ? { totalReservesExcludedBuckets: Array.from(totalReservesExcludeBuckets).sort() }
        : {}),
      ...(params.skipTotalReservesValidation ? { totalReservesValidationSkipped: true } : {}),
      ...(signedBuckets.length > 0
        ? {
            signedBucketCount: signedBuckets.length,
            signedBucketNames: signedBuckets.map((entry) => entry.name).sort(),
            signedBucketValue: signedBuckets.reduce((sum, entry) => sum + entry.value, 0),
          }
        : {}),
      dashboardTimestamp: payload.data.ts,
      ...freshnessMetadataFromTimestamp(
        sourceTimestamp,
        "accountable-dashboard",
        "Accountable dashboard payload does not expose a readable upstream timestamp",
      ),
    },
  };
}

export async function fetchAccountableReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primaryInput = requireJsonInputFromConfig(config, "accountable");
  const params = parseAccountableParams(config);
  const payload = await fetchJsonWithRetry<AccountableDashboardResponse>(
    primaryInput.url,
    signal,
    12_000,
    ctx,
  );
  return adaptAccountableDashboard(payload, params);
}
