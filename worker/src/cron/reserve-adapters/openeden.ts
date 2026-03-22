import type { LiveReservesConfig, ReserveSlice, StablecoinMeta } from "@shared/types";
import type { AdapterContext, AdapterResult } from "./types";
import { fetchJsonWithRetry, getAdapterTimeout, requireJsonInputFromConfig, slicesFromValues } from "./helpers";

interface OpenEdenReserveCompositionResponse {
  usdoAmount: number;
  totalTbillAmountInUsd: number;
  usdcAmount: number;
  buidlAmount: number;
  vbillAmount: number;
  usycAmountInUsd: number;
  benjiAmount: number;
  reserveAssetsInUsd: number;
  ratio: number;
}

function adaptOpenEdenReserveComposition(payload: OpenEdenReserveCompositionResponse): AdapterResult {
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
      reserveAssetsInUsd: payload.reserveAssetsInUsd,
      reserveRatio: payload.ratio,
      supplyUsd: payload.usdoAmount,
      totalReserveUsd: payload.reserveAssetsInUsd,
      immediateRedeemableUsd: payload.usdcAmount,
      immediateRedeemableRatio:
        payload.usdoAmount > 0 ? payload.usdcAmount / payload.usdoAmount : null,
    },
  };
}

export function adaptOpenEdenUsdo(
  payload: OpenEdenReserveCompositionResponse,
): ReserveSlice[] {
  return adaptOpenEdenReserveComposition(payload).slices;
}

export async function fetchOpenEdenUsdoReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  _ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primaryInput = requireJsonInputFromConfig(config, "openeden-usdo");
  const payload = await fetchJsonWithRetry<OpenEdenReserveCompositionResponse>(primaryInput.url, signal, getAdapterTimeout(config, 12_000));
  return adaptOpenEdenReserveComposition(payload);
}
