import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchJsonWithRetry,
  parseTimestampLikeToUnixSeconds,
  requireJsonInputFromConfig,
  slicesFromValues,
  unverifiedFreshnessMetadata,
} from "./helpers";

interface OpenEdenReserveCompositionResponse {
  date?: string;
  usdoAmount: number;
  totalTbillAmountInUsd: number;
  usdcAmount: number;
  rlusdAmount?: number;
  buidlAmount: number;
  vbillAmount: number;
  usycAmountInUsd: number;
  benjiAmount: number;
  reserveAssetsInUsd: number;
  ratio: number;
}

const OPENEDEN_BROWSER_HEADERS = {
  Origin: "https://openeden.com",
  Referer: "https://openeden.com/usdo/transparency",
  "Accept-Language": "en-US,en;q=0.9",
};

function adaptOpenEdenReserveComposition(payload: OpenEdenReserveCompositionResponse): AdapterResult {
  const sourceTimestamp = parseTimestampLikeToUnixSeconds(payload.date ?? null);
  const componentTotal =
    payload.totalTbillAmountInUsd
    + payload.usdcAmount
    + (payload.rlusdAmount ?? 0)
    + payload.buidlAmount
    + payload.vbillAmount
    + payload.usycAmountInUsd
    + payload.benjiAmount;
  if (
    payload.reserveAssetsInUsd > 0
    && Math.abs(componentTotal - payload.reserveAssetsInUsd) / payload.reserveAssetsInUsd > 0.01
  ) {
    throw new Error(
      `openeden-usdo reserve components sum to ${componentTotal.toFixed(2)}, expected ${payload.reserveAssetsInUsd.toFixed(2)}`,
    );
  }

  const normalizedRatio = payload.ratio > 2 ? payload.ratio / 100 : payload.ratio;
  const derivedRatio = payload.usdoAmount > 0 ? payload.reserveAssetsInUsd / payload.usdoAmount : null;
  if (
    normalizedRatio > 0
    && derivedRatio != null
    && Math.abs(normalizedRatio - derivedRatio) / normalizedRatio > 0.02
  ) {
    throw new Error(
      `openeden-usdo reserve ratio ${normalizedRatio.toFixed(6)} does not match derived ratio ${derivedRatio.toFixed(6)}`,
    );
  }

  const slices = slicesFromValues([
    {
      name: "OpenEden TBILL",
      value: payload.totalTbillAmountInUsd,
      risk: "very-low",
      coinId: "tbill-openeden",
    },
    {
      name: "BlackRock BUIDL",
      value: payload.buidlAmount,
      risk: "low",
      coinId: "buidl-blackrock",
    },
    {
      name: "OpenEden VBILL",
      value: payload.vbillAmount,
      risk: "low",
    },
    {
      name: "USDC buffer",
      value: payload.usdcAmount,
      risk: "low",
      coinId: "usdc-circle",
    },
    {
      name: "RLUSD buffer",
      value: payload.rlusdAmount ?? 0,
      risk: "low",
      coinId: "rlusd-ripple",
    },
    {
      name: "Hashnote USYC",
      value: payload.usycAmountInUsd,
      risk: "low",
      coinId: "usyc-hashnote",
    },
    {
      name: "Franklin Templeton BENJI",
      value: payload.benjiAmount,
      risk: "low",
    },
  ]);

  return {
    slices,
    metadata: {
      ...(sourceTimestamp != null
        ? { sourceTimestamp, freshnessMode: "verified" as const }
        : unverifiedFreshnessMetadata(
          "issuer-api",
          "OpenEden reserve composition payload does not include a trustworthy source timestamp",
        )),
      reserveAssetsInUsd: payload.reserveAssetsInUsd,
      reserveRatio: normalizedRatio,
      supplyUsd: payload.usdoAmount,
      totalReserveUsd: payload.reserveAssetsInUsd,
      componentTotalUsd: componentTotal,
      immediateRedeemableUsd: payload.usdcAmount,
      ...(payload.usdoAmount > 0 ? { immediateRedeemableRatio: payload.usdcAmount / payload.usdoAmount } : {}),
      redemption: {
        capacityUsd: payload.usdcAmount,
        ...(payload.usdoAmount > 0 ? { capacityRatioOfSupply: payload.usdcAmount / payload.usdoAmount } : {}),
        capacityKind: "live-direct-bounded" as const,
        freshnessKind: sourceTimestamp != null ? "verified-source-timestamp" as const : "unverified" as const,
        ...(sourceTimestamp != null ? { sourceTimestamp } : {}),
        routeStatus: "open" as const,
        holderEligibility: "verified-customer",
        sourceUrls: ["https://openeden.com/usdo/transparency"],
      },
    },
  };
}

export function adaptOpenEdenUsdo(
  payload: OpenEdenReserveCompositionResponse,
): AdapterResult {
  return adaptOpenEdenReserveComposition(payload);
}

export async function fetchOpenEdenUsdoReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primaryInput = requireJsonInputFromConfig(config, "openeden-usdo");
  const payload = await fetchJsonWithRetry<OpenEdenReserveCompositionResponse>(
    primaryInput.url,
    signal,
    12_000,
    ctx,
    { headers: OPENEDEN_BROWSER_HEADERS },
  );
  return adaptOpenEdenReserveComposition(payload);
}
