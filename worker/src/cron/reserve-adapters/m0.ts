import type { LiveReservesConfig, ReserveSlice, StablecoinMeta } from "@shared/types";
import type { AdapterContext, AdapterResult } from "./types";
import { fetchJsonPostWithRetry, getAdapterTimeout, requireJsonInputFromConfig, slicesFromValues } from "./helpers";

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
  }
`;

function adaptM0Collateral(payload: M0GraphQlResponse): AdapterResult {
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

  // The M0 dashboard renders treasury and token collateral fields in micro-USD,
  // while `totalCash` is surfaced in milli-USD. Upscale cash so the mix matches
  // the dashboard's reserve totals before converting to percentages.
  const cashValue = current.totalCash * 1_000;
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
      cashScaleApplied: 1_000,
      remainingTermDays: current.remainingTerm,
      totalCashScaled: cashValue,
      totalTokenCollateral: tokenCollateralTotal,
      totalTreasuries: current.totalTreasuries,
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
  _ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primaryInput = requireJsonInputFromConfig(config, "m0");
  const payload = await fetchJsonPostWithRetry<M0GraphQlResponse>(
    primaryInput.url,
    { query: M0_COLLATERAL_QUERY },
    signal,
    getAdapterTimeout(config, 12_000),
  );
  if (payload.errors?.length) {
    const message = payload.errors.map((error) => error.message).filter(Boolean).join("; ");
    throw new Error(message || "M0 GraphQL returned errors");
  }

  return adaptM0Collateral(payload);
}
