import type { LiveReservesConfig, ReserveSlice, StablecoinMeta } from "@shared/types";
import type { AdapterContext, AdapterResult } from "./index";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { buildReserveSlicesFromValues, requireHttpJsonInput } from "./utils";

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
  const slices = buildReserveSlicesFromValues([
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
  const primaryInput = requireHttpJsonInput(config, "openeden-usdo");
  const res = await fetchWithRetry(primaryInput.url, { signal }, 2, { timeoutMs: 12_000 });
  if (!res) throw new Error("OpenEden reserve API: fetchWithRetry returned null (all retries failed)");
  if (!res.ok) throw new Error(`OpenEden reserve API ${res.status}`);

  const payload = await res.json() as OpenEdenReserveCompositionResponse;
  return adaptOpenEdenReserveComposition(payload);
}
