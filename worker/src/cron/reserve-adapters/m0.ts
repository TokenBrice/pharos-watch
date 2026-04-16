import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchJsonPostWithRetry,
  reserveDegradedWarning,
  SOURCE_TIMESTAMP_SPREAD_DEGRADE_SEC,
  summarizeSourceTimestamps,
  requireJsonInputFromConfig,
  slicesFromValues,
  unverifiedFreshnessMetadata,
  verifiedFreshnessMetadata,
} from "./helpers";

interface M0GraphQlResponse {
  data?: {
    CollateralCurrent?: {
      totalCash: number;
      eligibleTreasuries: number;
      nonEligibleTreasuries: number;
      totalTreasuries: number;
      totalTokenCollateral: number | null;
      eligibleTokenCollateral: number | null;
      nonEligibleTokenCollateral: number | null;
      remainingTerm: number;
      yieldToMaturity: number;
    };
    collateralUpdateds?: Array<{
      timestamp?: string | number;
      blockTimestamp?: string | number;
    }>;
    minterGateway_latestUpdateTimestampSnapshots?: Array<{
      timestamp?: string | number;
      value?: string | number;
    }>;
  };
  errors?: Array<{ message?: string }>;
}

const M0_COLLATERAL_QUERY = `
  query LiveReserveCurrent {
    CollateralCurrent {
      totalCash
      eligibleTreasuries
      nonEligibleTreasuries
      totalTreasuries
      totalTokenCollateral
      eligibleTokenCollateral
      nonEligibleTokenCollateral
      remainingTerm
      yieldToMaturity
    }
    collateralUpdateds(first: 1, orderBy: timestamp, orderDirection: desc) {
      timestamp
      blockTimestamp
    }
    minterGateway_latestUpdateTimestampSnapshots(first: 1, orderBy: timestamp, orderDirection: desc) {
      timestamp
      value
    }
  }
`;

const M0_CASH_SCALE = 1_000;

function scaleM0CashToReserveUnits(rawCash: number): number {
  return rawCash * M0_CASH_SCALE;
}

function getM0SourceTimestampSummary(payload: M0GraphQlResponse) {
  const candidates = [
    payload.data?.collateralUpdateds?.[0]?.timestamp,
    payload.data?.collateralUpdateds?.[0]?.blockTimestamp,
    payload.data?.minterGateway_latestUpdateTimestampSnapshots?.[0]?.value,
    payload.data?.minterGateway_latestUpdateTimestampSnapshots?.[0]?.timestamp,
  ];

  return summarizeSourceTimestamps(candidates);
}

export function adaptM0Collateral(payload: M0GraphQlResponse): AdapterResult {
  const current = payload.data?.CollateralCurrent;
  if (!current) {
    throw new Error("M0 GraphQL response missing CollateralCurrent");
  }

  if (
    current.totalTreasuries > 0
    && Math.abs((current.eligibleTreasuries + current.nonEligibleTreasuries) - current.totalTreasuries) > 1
  ) {
    throw new Error("M0 GraphQL treasury subtotals do not reconcile to totalTreasuries");
  }
  const tokenCollateralTotal = current.totalTokenCollateral ?? 0;
  const eligibleTokenCollateral = current.eligibleTokenCollateral ?? tokenCollateralTotal;
  const nonEligibleTokenCollateral = current.nonEligibleTokenCollateral ?? 0;
  if (
    tokenCollateralTotal > 0
    && Math.abs((eligibleTokenCollateral + nonEligibleTokenCollateral) - tokenCollateralTotal) > 1
  ) {
    throw new Error("M0 GraphQL token collateral subtotals do not reconcile to totalTokenCollateral");
  }

  // The live dashboard currently exposes `totalCash` three decimal orders below the
  // treasury/token collateral fields. Normalize it into the same reserve unit
  // before composing the mix, and keep the applied scale explicit in metadata/tests.
  // Sanity check: if the raw cash figure is already near the treasury scale (e.g. the
  // dashboard stopped reporting milli-USD), multiplying by 1000 would materially
  // inflate the reserve total. Reject the snapshot so operators catch the upstream
  // unit change before it is written downstream.
  if (current.totalCash > 0 && current.totalTreasuries > 0) {
    const rawCashVsTreasuriesRatio = current.totalCash / current.totalTreasuries;
    // Raw cash within 10% of treasuries magnitude (or larger) indicates the scale is
    // already applied upstream. Under the documented 1000x scale the raw ratio is
    // expected to be <=~0.001.
    if (rawCashVsTreasuriesRatio > 0.1) {
      throw new Error(
        `M0 cash-scale anomaly: raw totalCash (${current.totalCash}) is ${(rawCashVsTreasuriesRatio * 100).toFixed(1)}% of totalTreasuries (${current.totalTreasuries}); cash*${M0_CASH_SCALE} would exceed treasury scale`,
      );
    }
  }
  const cashValue = scaleM0CashToReserveUnits(current.totalCash);
  const normalizedReserveTotal = current.totalTreasuries + tokenCollateralTotal + cashValue;
  const timestampSummary = getM0SourceTimestampSummary(payload);
  const warnings = [];
  if (
    timestampSummary
    && timestampSummary.sourceTimestampSpreadSec > SOURCE_TIMESTAMP_SPREAD_DEGRADE_SEC
  ) {
    warnings.push(reserveDegradedWarning(
      "source-timestamp-spread",
      `M0 collateral timestamp candidates span ${timestampSummary.sourceTimestampSpreadSec}s`,
    ));
  }
  const slices = slicesFromValues([
    {
      name: "Eligible U.S. Treasuries",
      value: current.eligibleTreasuries,
      risk: "very-low",
    },
    {
      name: "Tokenized treasury collateral",
      value: eligibleTokenCollateral,
      risk: "low",
    },
    {
      name: "Cash",
      value: cashValue,
      risk: "very-low",
    },
    {
      name: "Non-eligible U.S. Treasuries",
      value: current.nonEligibleTreasuries,
      risk: "low",
    },
    {
      name: "Non-eligible token collateral",
      value: current.nonEligibleTokenCollateral ?? 0,
      risk: "medium",
    },
  ]);

  return {
    slices,
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...(timestampSummary != null
        ? verifiedFreshnessMetadata(timestampSummary.sourceTimestamp)
        : unverifiedFreshnessMetadata(
            "dashboard-graphql",
            "M0 CollateralCurrent does not expose a trustworthy upstream disclosure timestamp",
          )),
      cashScaleApplied: M0_CASH_SCALE,
      cashUnits: "milli-usd-to-micro-usd",
      ...(timestampSummary != null
        ? {
            earliestCollateralSourceTimestamp: timestampSummary.sourceTimestamp,
            latestCollateralSourceTimestamp: timestampSummary.latestSourceTimestamp,
            sourceTimestampSpreadSec: timestampSummary.sourceTimestampSpreadSec,
            timestampCandidateCount: timestampSummary.timestampCount,
          }
        : {}),
      remainingTermDays: current.remainingTerm,
      totalCashScaled: cashValue,
      totalTokenCollateral: tokenCollateralTotal,
      totalTreasuries: current.totalTreasuries,
      normalizedReserveTotal,
      yieldToMaturity: current.yieldToMaturity,
    },
  };
}

export function adaptM0Current(payload: M0GraphQlResponse): ReserveSlice[] {
  return adaptM0Collateral(payload).slices;
}

export async function fetchM0Reserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primaryInput = requireJsonInputFromConfig(config, "m0");
  const payload = await fetchJsonPostWithRetry<M0GraphQlResponse>(
    primaryInput.url,
    { query: M0_COLLATERAL_QUERY },
    signal,
    12_000,
    ctx,
  );
  if (payload.errors?.length) {
    const message = payload.errors.map((error) => error.message).filter(Boolean).join("; ");
    throw new Error(message || "M0 GraphQL returned errors");
  }

  return adaptM0Collateral(payload);
}
