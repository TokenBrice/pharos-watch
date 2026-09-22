import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import { toErrorMessage } from "@shared/lib/error-utils";
import {
  buildRedemptionSnapshotMetadata,
  fetchJsonWithRetry,
  freshnessMetadataFromTimestamp,
  parseTimestampLikeToUnixSeconds,
  requireJsonInputFromConfig,
  slicesFromValues,
} from "./helpers";
import { fetchWithBrowserFallback } from "./request";

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
  // USDC from user subscriptions awaiting T-Bill conversion; part of
  // reserveAssetsInUsd but locked in the subscription pipeline, so it
  // is excluded from immediate-redemption capacity.
  pendingUsdc?: number;
  reserveAssetsInUsd: number;
  ratio: number;
}


export function adaptOpenEdenUsdo(payload: OpenEdenReserveCompositionResponse): AdapterResult {
  for (const [field, value] of [
    ["reserveAssetsInUsd", payload.reserveAssetsInUsd],
    ["usdoAmount", payload.usdoAmount],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(
        `openeden-usdo ${field} is not a finite non-negative number: ${String(value)}`,
      );
    }
  }
  const sourceTimestamp = parseTimestampLikeToUnixSeconds(payload.date ?? null);
  const componentTotal =
    payload.totalTbillAmountInUsd
    + payload.usdcAmount
    + (payload.rlusdAmount ?? 0)
    + payload.buidlAmount
    + payload.vbillAmount
    + payload.usycAmountInUsd
    + payload.benjiAmount
    + (payload.pendingUsdc ?? 0);
  if (
    payload.reserveAssetsInUsd > 0
    && Math.abs(componentTotal - payload.reserveAssetsInUsd) / payload.reserveAssetsInUsd > 0.01
  ) {
    throw new Error(
      `openeden-usdo reserve components sum to ${componentTotal.toFixed(2)}, expected ${payload.reserveAssetsInUsd.toFixed(2)}`,
    );
  }

  // OpenEden's reserve API returns `ratio` in one of two observed scales:
  //  * Percent-scale (>2): historical values in the 100-101 range → /100 to
  //    normalize into a decimal ratio.
  //  * Decimal-scale (<=2): values in the 0.99-1.01 range → accept as-is.
  // Anything else (undefined, NaN, non-positive) indicates the upstream
  // contract changed and we should fail closed.
  if (!Number.isFinite(payload.ratio) || payload.ratio <= 0) {
    throw new Error(
      `openeden-usdo reserve ratio is non-numeric or non-positive: ${payload.ratio}`,
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
      name: "Pending USDC",
      value: payload.pendingUsdc ?? 0,
      risk: "very-low",
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
      ...freshnessMetadataFromTimestamp(
        sourceTimestamp,
        "issuer-api",
        "OpenEden reserve composition payload does not include a trustworthy source timestamp",
      ),
      reserveAssetsInUsd: payload.reserveAssetsInUsd,
      reserveRatio: normalizedRatio,
      supplyUsd: payload.usdoAmount,
      totalReserveUsd: payload.reserveAssetsInUsd,
      componentTotalUsd: componentTotal,
      ...buildRedemptionSnapshotMetadata({
        capacityUsd: payload.usdcAmount,
        ...(payload.usdoAmount > 0 ? { capacityRatioOfSupply: payload.usdcAmount / payload.usdoAmount } : {}),
        capacityKind: "live-direct-bounded",
        freshnessKind: sourceTimestamp != null ? "verified-source-timestamp" : "unverified",
        ...(sourceTimestamp != null ? { sourceTimestamp } : {}),
        routeStatus: "unknown",
        routeStatusSource: "static-config",
        holderEligibility: "verified-customer",
        sourceUrls: ["https://openeden.com/usdo/transparency"],
      }),
    },
  };
}

// The fetch budget keeps all retry attempts inside the orchestrator's 20s
// per-attempt wall, so a slow or unreachable gateway surfaces a labeled fetch
// error in attempt history instead of a bare "adapter-timeout".
const OPENEDEN_PER_ATTEMPT_TIMEOUT_MS = 8_000;
const OPENEDEN_TOTAL_TIMEOUT_MS = 16_000;

async function fetchOpenEdenReserveComposition(
  url: string,
  signal: AbortSignal,
  deadline: AbortSignal,
  ctx?: AdapterContext,
): Promise<OpenEdenReserveCompositionResponse> {
  const attemptSignal = AbortSignal.any([signal, deadline]);
  try {
    return await fetchWithBrowserFallback(
      "https://openeden.com",
      "https://openeden.com/usdo/transparency",
      (headers) => fetchJsonWithRetry<OpenEdenReserveCompositionResponse>(
        url,
        attemptSignal,
        OPENEDEN_PER_ATTEMPT_TIMEOUT_MS,
        ctx,
        { headers },
      ),
      attemptSignal,
    );
  } catch (fallbackError) {
    if (signal.aborted || deadline.aborted) throw fallbackError;
    try {
      return await fetchJsonWithRetry<OpenEdenReserveCompositionResponse>(
        url,
        attemptSignal,
        OPENEDEN_PER_ATTEMPT_TIMEOUT_MS,
        ctx,
      );
    } catch (defaultError) {
      if (signal.aborted || deadline.aborted) throw defaultError;
      throw new Error(
        `${toErrorMessage(fallbackError)}; default fetch failed: ${toErrorMessage(defaultError)}`,
      );
    }
  }
}

export async function fetchOpenEdenUsdoReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primaryInput = requireJsonInputFromConfig(config, "openeden-usdo");
  const deadline = AbortSignal.timeout(OPENEDEN_TOTAL_TIMEOUT_MS);
  let payload: OpenEdenReserveCompositionResponse;
  try {
    payload = await fetchOpenEdenReserveComposition(primaryInput.url, signal, deadline, ctx);
  } catch (error) {
    if (signal.aborted) throw error;
    if (deadline.aborted) {
      throw new Error(
        `openeden-usdo reserve composition fetch timed out after ${OPENEDEN_TOTAL_TIMEOUT_MS}ms: ${primaryInput.url}`,
      );
    }
    const detail = toErrorMessage(error);
    throw new Error(`openeden-usdo reserve composition fetch failed: ${detail}`);
  }
  return adaptOpenEdenUsdo(payload);
}
