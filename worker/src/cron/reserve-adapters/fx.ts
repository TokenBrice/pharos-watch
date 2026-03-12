import type { LiveReservesConfig, StablecoinMeta } from "@shared/types";
import type { AdapterResult } from "./index";
import { fetchDefiLlamaPrices, fetchJsonWithRetry, requireJsonInput, slicesFromUsdValues } from "./helpers";

interface FxPoolInfo {
  collateralBalance?: string;
}

interface FxPayload {
  data?: {
    poolInfo?: Record<string, FxPoolInfo>;
  };
}

const TOKEN_META = {
  wstETH: { chain: "ethereum", address: "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0", decimals: 18, risk: "low" as const, name: "wstETH (Lido)" },
  wbtc: { chain: "ethereum", address: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", decimals: 8, risk: "medium" as const, name: "WBTC" },
};

export function adaptFx(payload: FxPayload): Array<{ key: keyof typeof TOKEN_META; amount: number }> {
  const poolInfo = payload.data?.poolInfo ?? {};
  return (Object.keys(TOKEN_META) as Array<keyof typeof TOKEN_META>)
    .map((key) => {
      const balance = Number(poolInfo[key]?.collateralBalance ?? "0");
      const decimals = TOKEN_META[key].decimals;
      return {
        key,
        amount: Number.isFinite(balance) && balance > 0 ? balance / (10 ** decimals) : 0,
      };
    })
    .filter((entry) => entry.amount > 0);
}

export async function fetchFxReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
): Promise<AdapterResult> {
  const input = requireJsonInput(config.inputs.primary, "fx");
  const payload = await fetchJsonWithRetry<FxPayload>(input.url, signal);
  const balances = adaptFx(payload);
  const priceMap = await fetchDefiLlamaPrices(
    balances.map(({ key }) => ({
      key,
      chain: TOKEN_META[key].chain,
      address: TOKEN_META[key].address,
    })),
    signal,
  );

  return {
    slices: slicesFromUsdValues(
      balances.map(({ key, amount }) => {
        const price = priceMap.get(key);
        if (price == null) {
          throw new Error(`Missing DefiLlama price for ${key}`);
        }
        return {
          usd: amount * price,
          name: TOKEN_META[key].name,
          risk: TOKEN_META[key].risk,
        };
      }),
    ),
  };
}
