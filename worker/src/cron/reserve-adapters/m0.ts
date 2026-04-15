import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchJsonPostWithRetry,
  parseTimestampLikeToUnixSeconds,
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

function getLatestM0SourceTimestamp(payload: M0GraphQlResponse): number | null {
  const candidates = [
    payload.data?.collateralUpdateds?.[0]?.timestamp,
    payload.data?.collateralUpdateds?.[0]?.blockTimestamp,
    payload.data?.minterGateway_latestUpdateTimestampSnapshots?.[0]?.value,
    payload.data?.minterGateway_latestUpdateTimestampSnapshots?.[0]?.timestamp,
  ]
    .map((value) => parseTimestampLikeToUnixSeconds(value))
    .filter((value): value is number => value != null);

  return candidates.length > 0 ? Math.max(...candidates) : null;
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
  const cashValue = scaleM0CashToReserveUnits(current.totalCash);
  const normalizedReserveTotal = current.totalTreasuries + tokenCollateralTotal + cashValue;
  const sourceTimestamp = getLatestM0SourceTimestamp(payload);
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
    metadata: {
      ...(sourceTimestamp != null
        ? verifiedFreshnessMetadata(sourceTimestamp)
        : unverifiedFreshnessMetadata(
            "dashboard-graphql",
            "M0 CollateralCurrent does not expose a trustworthy upstream disclosure timestamp",
          )),
      cashScaleApplied: M0_CASH_SCALE,
      cashUnits: "milli-usd-to-micro-usd",
      ...(sourceTimestamp != null ? { latestCollateralSourceTimestamp: sourceTimestamp } : {}),
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
