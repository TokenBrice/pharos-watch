import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { getCanonicalReserveAssetRisk } from "@shared/lib/reserve-asset-risk";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchDefiLlamaPrices,
  fetchJsonWithRetry,
  requireJsonInput,
  slicesFromValues,
  unverifiedFreshnessMetadata,
  valueUsdFromBigIntPrice,
} from "./helpers";

interface FxPoolInfo {
  collateralBalance?: string;
}

interface FxPayload {
  data?: {
    poolInfo?: Record<string, FxPoolInfo>;
  };
}

const TOKEN_META = {
  wstETH: { chain: "ethereum", address: "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0", decimals: 18, risk: getCanonicalReserveAssetRisk("WSTETH") ?? "low", name: "wstETH (Lido)" },
  wbtc: { chain: "ethereum", address: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", decimals: 8, risk: getCanonicalReserveAssetRisk("WBTC") ?? "medium", name: "WBTC" },
};

export function adaptFx(payload: FxPayload): {
  balances: Array<{ key: keyof typeof TOKEN_META; amountRaw: bigint }>;
  unknownKeys: string[];
} {
  const poolInfo = payload.data?.poolInfo ?? {};
  const unexpectedPositiveKeys = Object.entries(poolInfo)
    .filter(([key]) => !(key in TOKEN_META))
    .filter(([, info]) => Number(info?.collateralBalance ?? "0") > 0)
    .map(([key]) => key);

  return {
    balances: (Object.keys(TOKEN_META) as Array<keyof typeof TOKEN_META>)
    .map((key) => {
      const rawBalance = poolInfo[key]?.collateralBalance ?? "0";
      const balance = typeof rawBalance === "string" && /^\d+$/.test(rawBalance)
        ? BigInt(rawBalance)
        : 0n;
      return {
        key,
        amountRaw: balance > 0n ? balance : 0n,
      };
    })
    .filter((entry) => entry.amountRaw > 0n),
    unknownKeys: unexpectedPositiveKeys,
  };
}

export async function fetchFxReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireJsonInput(config.inputs.primary, "fx");
  const payload = await fetchJsonWithRetry<FxPayload>(input.url, signal, 12_000, ctx);
  const { balances, unknownKeys } = adaptFx(payload);
  if (unknownKeys.length > 0) {
    throw new Error(`fx returned unmapped positive collateral keys with unquantified exposure: ${unknownKeys.join(", ")}`);
  }
  const priceMap = await fetchDefiLlamaPrices(
    balances.map(({ key }) => ({
      key,
      chain: TOKEN_META[key].chain,
      address: TOKEN_META[key].address,
    })),
    signal,
    ctx,
  );

  const knownValues = balances.map(({ key, amountRaw }) => {
    const price = priceMap.get(key);
    if (price == null) {
      throw new Error(`Missing DefiLlama price for ${key}`);
    }
    return {
      value: valueUsdFromBigIntPrice(amountRaw, TOKEN_META[key].decimals, price),
      name: TOKEN_META[key].name,
      risk: TOKEN_META[key].risk,
    };
  });
  return {
    slices: slicesFromValues(knownValues),
    metadata: unverifiedFreshnessMetadata(
      "protocol-pool-api",
      "FX protocol pool payload does not expose a trustworthy source timestamp",
    ),
  };
}
