import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { formatPercentFromRatio } from "@shared/lib/format";
import { getLiveReserveAdapterMaxUnknownExposurePct, parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { AdapterContext, AdapterResult } from "./types";
import {
  buildCoverageShortfallWarnings,
  buildUnknownExposureWarning,
  computeUnknownExposurePct,
  fetchJsonAdapterInput,
  freshnessMetadataFromTimestamp,
  parseTimestampLikeToUnixSeconds,
  reserveDegradedWarning,
  reserveInfoWarning,
  slicesFromValues,
} from "./helpers";
import { buildBrowserHeaders } from "./request";
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
      total_supply?: unknown;
      inventory?: unknown;
      pol?: unknown;
      type?: Record<string, unknown>;
      reserves_split?: unknown;
      deployment?: Record<string, unknown>;
      type_split?: Record<string, unknown>;
      stablecoin_split?: Record<string, unknown>;
      exposure_split?: Record<string, unknown>;
      exposure_split_ts?: unknown;
      protocol_split?: Record<string, unknown>;
      timeline?: AccountableTimelinePoint[];
    };
    /** Root-level category breakdown used by the `asset-breakdown` layout. Each key is a
     *  strategy/custody category whose value is an object whose nested entries sum to the
     *  category's USD value (e.g. Tori's four categories). */
    assetBreakdown?: Record<string, unknown>;
  };
}

interface AccountableTimelinePoint {
  ts?: unknown;
  reserves?: unknown;
}

interface AccountableParams {
  bucket?: "type" | "reserves_split" | "deployment" | "type_split" | "stablecoin_split" | "exposure_split" | "protocol_split";
  /** Which composition source to read. `reserves-types` (default) selects a sub-bucket under
   *  `data.reserves` via `bucket`; `asset-breakdown` reads the root-level `data.assetBreakdown`
   *  category tree instead, for feeds whose composition is not published under `reserves`. */
  layout?: "reserves-types" | "asset-breakdown";
  riskMap?: Record<string, ReserveSlice["risk"]>;
  renameMap?: Record<string, string>;
  sourceKeyMap?: Record<string, string>;
  coinIdMap?: Record<string, string>;
  depTypeMap?: Record<string, ReserveSlice["depType"]>;
  totalReservesExcludeBuckets?: string[];
  accountingMode?: "apyx-net-external-reserves";
}

const VALID_BUCKETS = new Set(["type", "reserves_split", "deployment", "type_split", "stablecoin_split", "exposure_split", "protocol_split"]);
const TOTAL_RESERVES_RELATIVE_TOLERANCE = 0.01;
const TOTAL_RESERVES_ABSOLUTE_TOLERANCE = 1;
const EXPOSURE_SPLIT_TIMELINE_MAX_GAP_SECONDS = 24 * 60 * 60;
/** The dashboard publishes `collateralization` to six decimals, so cent-level rounding of the
 *  reserve/supply inputs moves a derived ratio by <1e-6. This stays far below the ~2e-2 spread
 *  between the gross and net-of-protocol-owned bases it has to tell apart. */
const COLLATERALIZATION_RECONCILIATION_TOLERANCE = 1e-4;

function parseAccountableParams(config: LiveReservesConfig): AccountableParams {
  const params = parseLiveReserveAdapterParams("accountable", config.params);
  if (params.bucket != null && !VALID_BUCKETS.has(params.bucket)) {
    throw new Error(`accountable: invalid bucket "${params.bucket}", expected one of: ${[...VALID_BUCKETS].join(", ")}`);
  }
  return params;
}

/** Bucket values arrive in several reviewed shapes: a bare number, the empty-key wrapper the
 *  hosted Accountable feeds now publish for every bucket (`{ "": -7311212.03 }`), a
 *  `{ value: n }` / `{ usd: n }` record, a category-labelled map, or Tori's nested
 *  asset-breakdown tree. Anything that does not resolve to a finite number is a parse failure
 *  and throws; signed values resolve like any other and are reported downstream instead of
 *  failing the snapshot. */
function extractAccountableBucketValue(value: unknown, depth = 0): number | null {
  const direct = toFiniteNumber(value);
  if (direct != null) return direct;
  if (depth > 1) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 1 && keys[0] === "") return toFiniteNumber(record[""]);

  for (const key of ["value", "usd", "amount", "total"]) {
    const numeric = toFiniteNumber(record[key]);
    if (numeric != null) return numeric;
  }

  const childValues = Object.values(record).map((nested) => extractAccountableBucketValue(nested, depth + 1));
  if (childValues.length === 0 || childValues.some((numeric) => numeric == null)) return null;
  return (childValues as number[]).reduce((sum, numeric) => sum + numeric, 0);
}

function requireAccountableBucketValue(name: string, value: unknown, bucket: string): number {
  const numeric = extractAccountableBucketValue(value);
  if (numeric == null) {
    throw new Error(`Accountable ${bucket} bucket "${name}" has invalid value: ${String(value)}`);
  }
  return numeric;
}

function extractRecordBucketEntries(
  entries: Record<string, unknown> | undefined,
  bucket: string,
): Array<{ name: string; value: number }> {
  return Object.entries(entries ?? {}).map(([name, value]) => ({
    name,
    value: requireAccountableBucketValue(name, value, bucket),
  }));
}

function extractReservesSplitEntries(value: unknown): Array<{ name: string; value: number }> {
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
      value: requireAccountableBucketValue(record.name, record.value, "reserves_split"),
    };
  });
}

function extractBucketEntries(
  reserves: NonNullable<NonNullable<AccountableDashboardResponse["data"]>["reserves"]>,
  bucket: NonNullable<AccountableParams["bucket"]>,
): Array<{ name: string; value: number }> {
  switch (bucket) {
    case "type":
      return extractRecordBucketEntries(reserves.type, bucket);
    case "reserves_split":
      return extractReservesSplitEntries(reserves.reserves_split);
    case "deployment":
      return extractRecordBucketEntries(reserves.deployment, bucket);
    case "type_split":
      return extractRecordBucketEntries(reserves.type_split, bucket);
    case "stablecoin_split":
      return extractRecordBucketEntries(reserves.stablecoin_split, bucket);
    case "exposure_split":
      return extractRecordBucketEntries(reserves.exposure_split, bucket);
    case "protocol_split":
      return extractRecordBucketEntries(reserves.protocol_split, bucket);
    default:
      return [];
  }
}

function extractOptionalReserveScalar(
  value: unknown,
  field: string,
  options?: { requirePositive?: boolean },
): number | undefined {
  if (value == null) return undefined;
  const numeric = extractAccountableBucketValue(value);
  if (numeric == null || numeric < 0 || (options?.requirePositive && numeric === 0)) {
    throw new Error(`Accountable ${field} has invalid value: ${String(value)}`);
  }
  return numeric;
}

/** Sum of the reserve components the issuer holds itself (unsold inventory plus
 *  protocol-owned liquidity). Absent unless the feed publishes at least one of them. */
function extractProtocolOwnedUsd(
  reserves: NonNullable<NonNullable<AccountableDashboardResponse["data"]>["reserves"]>,
): number | undefined {
  const inventory = extractOptionalReserveScalar(reserves.inventory, "inventory");
  const pol = extractOptionalReserveScalar(reserves.pol, "pol");
  if (inventory == null && pol == null) return undefined;
  return (inventory ?? 0) + (pol ?? 0);
}

/** Which denominator the dashboard's headline `collateralization` is actually built on.
 *  Most Accountable feeds report gross total_reserves/total_supply, but the self-hosted Apyx
 *  instance reports the ratio net of protocol-owned inventory and liquidity on *both* sides,
 *  which reads ~2pp lower than the gross ratio. Deriving the basis instead of assuming it keeps
 *  the reported number from being curated as a gross coverage fact. */
type CollateralizationBasis = "gross" | "net-of-protocol-owned" | "unreconciled" | "underived";

interface CollateralizationReconciliation {
  basis: CollateralizationBasis;
  reportedRatio: number;
  supplyUsd?: number;
  totalReservesUsd?: number;
  protocolOwnedUsd?: number;
  grossRatio?: number;
  netRatio?: number;
}

function reconcileCollateralization(
  reportedRatio: number,
  totalReserves: number | undefined,
  totalSupply: number | undefined,
  protocolOwnedUsd: number | undefined,
): CollateralizationReconciliation {
  if (totalReserves == null || totalSupply == null) {
    return { basis: "underived", reportedRatio };
  }

  const grossRatio = totalReserves / totalSupply;
  const netDenominator = protocolOwnedUsd == null ? null : totalSupply - protocolOwnedUsd;
  const netRatio =
    protocolOwnedUsd != null && netDenominator != null && netDenominator > 0
      ? (totalReserves - protocolOwnedUsd) / netDenominator
      : null;
  const matches = (candidate: number) =>
    Math.abs(candidate - reportedRatio) <= COLLATERALIZATION_RECONCILIATION_TOLERANCE;

  return {
    basis: matches(grossRatio)
      ? "gross"
      : netRatio != null && matches(netRatio)
        ? "net-of-protocol-owned"
        : "unreconciled",
    reportedRatio,
    supplyUsd: totalSupply,
    totalReservesUsd: totalReserves,
    ...(protocolOwnedUsd != null ? { protocolOwnedUsd } : {}),
    grossRatio,
    ...(netRatio != null ? { netRatio } : {}),
  };
}

/** The only ratios allowed to populate the canonical `collateralizationRatio` field — and the
 *  coverage warnings built from it: a gross or reviewed-net basis, recomputable by any reader
 *  from the published reserve/supply totals. An `unreconciled` headline (matches no derivable
 *  denominator) and an `underived` one (no totals published at all) have no reproducible basis,
 *  so they publish `reportedCollateralizationRatio` instead of claiming measured coverage. */
function canonicalCollateralizationRatio(reconciliation: CollateralizationReconciliation): number | null {
  switch (reconciliation.basis) {
    case "gross":
      return reconciliation.grossRatio!;
    case "net-of-protocol-owned":
      return reconciliation.netRatio!;
    default:
      return null;
  }
}

/** Suffix appended to the undercollateralization warning so the headline percentage can never be
 *  read as gross liability coverage without the denominator it was computed on. */
function collateralizationBasisSuffix(reconciliation: CollateralizationReconciliation): string {
  return reconciliation.basis === "net-of-protocol-owned"
    ? ` net of protocol-owned reserves (gross reserves/supply ${formatPercentFromRatio(reconciliation.grossRatio!)})`
    : "";
}

function buildCollateralizationReconciliationWarning(
  reconciliation: CollateralizationReconciliation,
) {
  if (reconciliation.basis !== "unreconciled") return null;
  const derived = [
    `gross reserves/supply ${reconciliation.grossRatio!.toFixed(6)}`,
    ...(reconciliation.netRatio != null
      ? [`net-of-protocol-owned ${reconciliation.netRatio.toFixed(6)}`]
      : []),
  ].join(", ");
  return reserveDegradedWarning(
    "collateralization-unreconciled",
    `Accountable dashboard collateralization ${reconciliation.reportedRatio} matches no derivable denominator (${derived}); the reported ratio is not a reproducible coverage measurement`,
  );
}

/** A mapped bucket the dashboard reports as exactly zero would vanish from the published mix
 *  without any trace, so it still fails closed. Signed buckets are a distinct, reported case:
 *  they are excluded from slice weights and surfaced as a `signed-negative-bucket` warning
 *  (degraded only when the omitted exposure is material) instead. */
function validateMappedBucketValues(
  mapped: Array<{ name: string; value: number }>,
  bucket: string,
): void {
  const invalid = mapped.filter((entry) => entry.value === 0);
  if (invalid.length > 0) {
    throw new Error(`Accountable ${bucket} mapped bucket has zero value: ${invalid.map((entry) => entry.name).sort().join(", ")}`);
  }
}

/** Coverage guard for the composition buckets. Under-coverage means the feed's own breakdown is
 *  incomplete relative to the reserve total, so the published mix would silently omit backing:
 *  that still fails closed. Over-coverage on a signed (netted) book is the issuer's own
 *  readable inconsistency — the levered gross legs are netted by the negative buckets, so the
 *  net can sit above the reserve total; it returns the signed residual for a degraded warning
 *  instead of failing the snapshot. */
function validateBucketTotalAgainstReserves(
  breakdown: Array<{ name: string; value: number }>,
  totalReserves: number | undefined,
  bucket: string,
  options?: {
    excludeBuckets?: ReadonlySet<string>;
    hasSignedBuckets?: boolean;
  },
): number | null {
  if (totalReserves == null) return null;
  const totalValue = breakdown
    .filter((entry) => !(options?.excludeBuckets?.has(entry.name)))
    .reduce((sum, entry) => sum + entry.value, 0);
  const tolerance = Math.max(TOTAL_RESERVES_ABSOLUTE_TOLERANCE, totalReserves * TOTAL_RESERVES_RELATIVE_TOLERANCE);
  const residual = totalValue - totalReserves;
  if (Math.abs(residual) <= tolerance) return null;
  if (residual > 0 && options?.hasSignedBuckets) return residual;
  throw new Error(`Accountable ${bucket} bucket total ${totalValue} does not match total_reserves ${totalReserves}`);
}

function findNearestExposureSplitReserveTotal(
  reserves: NonNullable<NonNullable<AccountableDashboardResponse["data"]>["reserves"]>,
  sourceTimestamp: number,
): { totalReserves: number; timestamp: number } {
  const timeline = Array.isArray(reserves.timeline) ? reserves.timeline : [];
  const candidates = timeline.flatMap((point) => {
    const timestamp = parseTimestampLikeToUnixSeconds(point?.ts);
    const totalReserves = extractAccountableBucketValue(point?.reserves);
    return timestamp != null && totalReserves != null && totalReserves > 0
      ? [{ totalReserves, timestamp }]
      : [];
  });
  candidates.sort((left, right) =>
    Math.abs(left.timestamp - sourceTimestamp) - Math.abs(right.timestamp - sourceTimestamp));
  const nearest = candidates[0];
  if (!nearest) {
    throw new Error("Accountable exposure_split has no valid timeline reserve total for reconciliation");
  }
  if (Math.abs(nearest.timestamp - sourceTimestamp) > EXPOSURE_SPLIT_TIMELINE_MAX_GAP_SECONDS) {
    throw new Error("Accountable exposure_split has no contemporaneous timeline reserve total for reconciliation");
  }
  return nearest;
}

/** Signed buckets are always omitted from slice weights and named in metadata; the degraded
 *  effect is reserved for material omissions. Materiality rides the same adapter policy
 *  ceiling the `unmapped-bucket` warning uses (5% unless the declaration overrides it), so a
 *  fully unwound loop that nets to dust (observed: -$0.11 on a $64M book) stays informational
 *  while levered books whose netted legs move whole percents of reserves still degrade. A
 *  signed net above the reconciled reserve total is already material by the reconciliation
 *  tolerance, so it keeps the degraded effect regardless of the percentage. */
function buildSignedBucketWarning(
  signedBuckets: Array<{ name: string; value: number }>,
  totalValue: number,
  signedResidual: number | null,
) {
  const signedValue = signedBuckets.reduce((sum, entry) => sum + Math.abs(entry.value), 0);
  const exposurePct = computeUnknownExposurePct(signedValue, totalValue);
  const residualSuffix = signedResidual == null
    ? ""
    : `; their signed total is ${signedResidual.toFixed(2)} USD above the reconciled reserve total`;
  const message = `Accountable signed exposure buckets are omitted from reserve slices: ${
    signedBuckets.map((entry) => entry.name).sort().join(", ")
  } (${exposurePct.toFixed(2)}% of positive reserve buckets)${residualSuffix}`;
  return exposurePct > getLiveReserveAdapterMaxUnknownExposurePct("accountable") || signedResidual != null
    ? reserveDegradedWarning("signed-negative-bucket", message)
    : reserveInfoWarning("signed-negative-bucket", message);
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

/** Reviewed Apyx non-reserve own claims: https://docs.apyx.fi/collateral-and-custody/accountable-dashboard */
function reconcileApyxExternalReserves(
  reserves: NonNullable<NonNullable<AccountableDashboardResponse["data"]>["reserves"]>,
  breakdown: Array<{ name: string; value: number }>,
  reportedRatio: number,
) {
  const grossReservesUsd = extractOptionalReserveScalar(reserves.total_reserves, "total_reserves", { requirePositive: true });
  const grossSupplyUsd = extractOptionalReserveScalar(reserves.total_supply, "total_supply", { requirePositive: true });
  const excludedSelfClaims = [["Inventory", "inventory"], ["Protocol Owned Liquidity", "pol"]].map(([name, field]) => {
    const rows = breakdown.filter((row) => row.name === name);
    const scalar = extractOptionalReserveScalar(reserves[field as "inventory" | "pol"], field);
    if (rows.length !== 1 || scalar == null || !Number.isFinite(scalar) || scalar < 0 || !Number.isFinite(rows[0]!.value) || rows[0]!.value < 0 || Math.abs(rows[0]!.value - scalar) > 1) {
      throw new Error(`Accountable Apyx self-claim ${name} does not reconcile to its reserve scalar`);
    }
    return { name: name!, valueUsd: scalar };
  });
  const excludedSelfClaimsUsd = excludedSelfClaims.reduce((sum, row) => sum + row.valueUsd, 0);
  const grossBucketSum = breakdown.reduce((sum, row) => sum + row.value, 0);
  if (grossReservesUsd == null || grossSupplyUsd == null || !Number.isFinite(grossReservesUsd) || !Number.isFinite(grossSupplyUsd)
    || !Number.isFinite(grossBucketSum) || !Number.isFinite(excludedSelfClaimsUsd)
    || breakdown.some((row) => !Number.isFinite(row.value) || row.value < 0)
    || Math.abs(grossBucketSum - grossReservesUsd) > 1) {
    throw new Error("Accountable Apyx gross asset/supply accounting is incomplete");
  }
  const netExternalReservesUsd = grossReservesUsd - excludedSelfClaimsUsd;
  const netRedeemableClaimsUsd = grossSupplyUsd - excludedSelfClaimsUsd;
  const netCoverageRatio = netExternalReservesUsd / netRedeemableClaimsUsd;
  if (netExternalReservesUsd <= 0 || netRedeemableClaimsUsd <= 0 || !Number.isFinite(netCoverageRatio) || !Number.isFinite(reportedRatio)
    || Math.abs(netCoverageRatio - reportedRatio) > COLLATERALIZATION_RECONCILIATION_TOLERANCE) {
    throw new Error("Accountable Apyx net reserve/claim denominator does not reconcile to collateralization");
  }
  return { basis: "net-external-reserves", grossReservesUsd, grossSupplyUsd, excludedSelfClaims,
    excludedSelfClaimsUsd, netExternalReservesUsd, netRedeemableClaimsUsd, netCoverageRatio };
}

export function adaptAccountableDashboard(
  payload: AccountableDashboardResponse,
  params: AccountableParams,
): AdapterResult {
  if (payload.res !== "ok" || !payload.data?.reserves) {
    throw new Error("Accountable dashboard returned an invalid response");
  }

  const layout = params.layout ?? "reserves-types";
  const bucket = params.bucket ?? "type";
  const breakdownBucket = layout === "asset-breakdown" ? "asset-breakdown" : bucket;
  const breakdown = layout === "asset-breakdown"
    ? extractRecordBucketEntries(payload.data.assetBreakdown, "asset-breakdown")
    : extractBucketEntries(payload.data.reserves, bucket);
  if (breakdown.length === 0) {
    throw new Error(
      layout === "asset-breakdown"
        ? "Accountable asset-breakdown layout returned no asset categories"
        : `Unsupported Accountable bucket: ${bucket}`,
    );
  }

  const riskMap = params.riskMap ?? {};
  const renameMap = params.renameMap ?? {};
  const sourceKeyMap = params.sourceKeyMap ?? {};
  const coinIdMap = params.coinIdMap ?? {};
  const depTypeMap = params.depTypeMap ?? {};
  const totalReservesExcludeBuckets = new Set(params.totalReservesExcludeBuckets ?? []);
  if (params.accountingMode && (layout !== "reserves-types" || bucket !== "reserves_split" || totalReservesExcludeBuckets.size > 0)) {
    throw new Error("Accountable Apyx accounting requires an unmodified reserves_split");
  }
  const selfIssuedAccounting = params.accountingMode
    ? reconcileApyxExternalReserves(payload.data.reserves, breakdown, payload.data.collateralization)
    : null;
  const ownClaimNames = new Set(selfIssuedAccounting?.excludedSelfClaims.map((row) => row.name) ?? []);
  const signedBuckets = breakdown.filter((entry) => entry.value < 0);
  const reconciledBreakdown = breakdown.filter((entry) => !(totalReservesExcludeBuckets.has(entry.name) || ownClaimNames.has(entry.name)));
  const positiveBreakdown = reconciledBreakdown.filter((entry) => entry.value > 0);
  validateMappedBucketValues(breakdown.filter(({ name }) => name in riskMap && !ownClaimNames.has(name)), breakdownBucket);
  const mapped = positiveBreakdown.filter(({ name }) => name in riskMap);
  const totalReserves = extractOptionalReserveScalar(payload.data.reserves.total_reserves, "total_reserves", {
    requirePositive: true,
  });
  const totalSupply = extractOptionalReserveScalar(payload.data.reserves.total_supply, "total_supply", {
    requirePositive: true,
  });
  const protocolOwnedUsd = extractProtocolOwnedUsd(payload.data.reserves);
  const exposureSplitSourceTimestamp = layout === "reserves-types" && bucket === "exposure_split" && payload.data.reserves.exposure_split_ts != null
    ? parseTimestampLikeToUnixSeconds(payload.data.reserves.exposure_split_ts)
    : null;
  if (layout === "reserves-types" && bucket === "exposure_split" && payload.data.reserves.exposure_split_ts != null && exposureSplitSourceTimestamp == null) {
    throw new Error(`Accountable exposure_split_ts is invalid: ${String(payload.data.reserves.exposure_split_ts)}`);
  }
  const exposureSplitTimelineTotal = exposureSplitSourceTimestamp != null
    ? findNearestExposureSplitReserveTotal(payload.data.reserves, exposureSplitSourceTimestamp)
    : null;
  const signedResidual = validateBucketTotalAgainstReserves(
    breakdown,
    exposureSplitTimelineTotal?.totalReserves ?? totalReserves,
    breakdownBucket,
    { excludeBuckets: totalReservesExcludeBuckets, hasSignedBuckets: signedBuckets.length > 0 },
  );
  const unknown = positiveBreakdown.filter(({ name }) => !(name in riskMap));
  const totalValue = positiveBreakdown.reduce((sum, entry) => sum + entry.value, 0);
  const unknownValue = unknown.reduce((sum, entry) => sum + entry.value, 0);
  const unknownExposurePct = computeUnknownExposurePct(unknownValue, totalValue);
  const signedBucketWarning = signedBuckets.length > 0
    ? buildSignedBucketWarning(signedBuckets, totalValue, signedResidual)
    : null;
  const collateralizationRatio = toFiniteNumber(payload.data.collateralization);
  if (collateralizationRatio == null || collateralizationRatio < 0) {
    throw new Error(`Accountable dashboard returned invalid collateralization: ${String(payload.data.collateralization)}`);
  }
  const derivedReconciliation = reconcileCollateralization(
    collateralizationRatio,
    totalReserves,
    totalSupply,
    protocolOwnedUsd,
  );
  const reconciliation = selfIssuedAccounting
    ? { ...derivedReconciliation, basis: "net-of-protocol-owned" as const }
    : derivedReconciliation;
  const canonicalRatio = canonicalCollateralizationRatio(reconciliation);
  const basisSuffix = collateralizationBasisSuffix(reconciliation);
  const collateralizationWarnings = canonicalRatio == null
    ? []
    : buildCoverageShortfallWarnings({
        code: "reserve-undercollateralized",
        message: (pct) => `Accountable dashboard reports ${pct}% collateralization${basisSuffix}`,
        coverageRatio: canonicalRatio,
      });
  const reconciliationWarning = buildCollateralizationReconciliationWarning(reconciliation);
  const protocolOwnedDenominator = totalReserves ?? totalValue;
  const protocolOwnedPct = protocolOwnedUsd == null
    ? 0
    : computeUnknownExposurePct(protocolOwnedUsd, protocolOwnedDenominator);
  const protocolOwnedWarning = protocolOwnedPct > 0 && !selfIssuedAccounting
    ? buildUnknownExposureWarning({ adapterKey: "accountable", code: "protocol-owned-bucket",
    message:
      `Accountable reserves include ${protocolOwnedUsd!.toFixed(2)} USD of issuer-held inventory and protocol-owned liquidity that is not itemized third-party backing`,
    unknownExposurePct: protocolOwnedPct, })
    : null;

  const slices = slicesFromValues(
    [
      ...mapped.map(({ name, value }) => ({
        ...(sourceKeyMap[name] ? { sourceKey: sourceKeyMap[name] } : {}),
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
    ].map(({ sourceKey, name, value, risk, coinId, depType }) => ({
      ...(sourceKey ? { sourceKey } : {}),
      name,
      value,
      risk,
      ...(coinId ? { coinId } : {}),
      ...(depType ? { depType } : {}),
    })),
  );

  const sourceTimestamp = exposureSplitSourceTimestamp ?? parseTimestampLikeToUnixSeconds(payload.data.ts);

  return {
    slices,
    ...((unknownExposurePct > 0
      || signedBucketWarning
      || protocolOwnedWarning
      || reconciliationWarning
      || collateralizationWarnings.length > 0)
      ? {
          warnings: [
            ...(unknownExposurePct > 0
              ? [buildUnknownExposureWarning({ adapterKey: "accountable", code: "unmapped-bucket",
              message: `Accountable bucket mapping is missing: ${unknown.map((entry) => entry.name).sort().join(", ")}`,
              unknownExposurePct, })]
              : []),
            ...(signedBucketWarning ? [signedBucketWarning] : []),
            ...(protocolOwnedWarning ? [protocolOwnedWarning] : []),
            ...(reconciliationWarning ? [reconciliationWarning] : []),
            ...collateralizationWarnings,
          ],
        }
      : {}),
    metadata: {
      bucket: breakdownBucket,
      layout,
      breakdownCount: breakdown.length,
      mappedBucketCount: mapped.length,
      ...(unknown.length > 0 ? { unknownBucketCount: unknown.length } : {}),
      ...(unknown.length > 0 ? { unknownBucketNames: unknown.map((entry) => entry.name).sort() } : {}),
      ...(unknownExposurePct > 0 ? { unknownExposurePct } : {}),
      collateralization: payload.data.collateralization,
      ...(canonicalRatio != null
        ? { collateralizationRatio: canonicalRatio }
        : { reportedCollateralizationRatio: collateralizationRatio }),
      collateralizationBasis: reconciliation.basis,
      ...(selfIssuedAccounting ? { selfIssuedAccounting } : {}),
      collateralizationReconciliation: reconciliation,
      interval: payload.data.reserves.interval,
      verifiability: payload.data.reserves.verifiability,
      totalReserves,
      ...(exposureSplitSourceTimestamp != null
        ? {
            exposureSplitTimestamp: payload.data.reserves.exposure_split_ts,
            exposureSplitTimelineTimestamp: exposureSplitTimelineTotal!.timestamp,
            exposureSplitTimelineTotalReserves: exposureSplitTimelineTotal!.totalReserves,
          }
        : {}),
      ...(totalSupply != null ? { supplyUsd: totalSupply } : {}),
      ...(protocolOwnedUsd != null
        ? { protocolOwnedUsd, protocolOwnedPctOfReserves: protocolOwnedPct }
        : {}),
      ...(layout === "reserves-types" && bucket === "deployment"
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
      ...(signedBuckets.length > 0
        ? {
            signedBucketCount: signedBuckets.length,
            signedBucketNames: signedBuckets.map((entry) => entry.name).sort(),
            signedBucketValue: signedBuckets.reduce((sum, entry) => sum + entry.value, 0),
            ...(signedResidual != null ? { signedBucketTotalResidual: signedResidual } : {}),
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
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const params = parseAccountableParams(config);
  const payload = await fetchJsonAdapterInput<AccountableDashboardResponse>(
    config,
    "accountable",
    signal,
    12_000,
    ctx,
    coin.id === "apxusd-apyx"
      ? { headers: buildBrowserHeaders("https://accountable.apyx.fi", "https://accountable.apyx.fi/") }
      : undefined,
  );
  return adaptAccountableDashboard(payload, params);
}
