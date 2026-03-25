import type { ReserveSlice } from "@shared/types/core";

type WrapperAssetKey =
  | "gho"
  | "pyusd"
  | "rlusd"
  | "usdc"
  | "usd1"
  | "usdt";

const WRAPPER_ASSET_META: Record<WrapperAssetKey, {
  coinId: string;
  depType: ReserveSlice["depType"];
}> = {
  gho: { coinId: "gho-aave", depType: "wrapper" },
  pyusd: { coinId: "pyusd-paypal", depType: "wrapper" },
  rlusd: { coinId: "rlusd-ripple", depType: "wrapper" },
  usdc: { coinId: "usdc-circle", depType: "wrapper" },
  usd1: { coinId: "usd1-world-liberty-financial", depType: "wrapper" },
  usdt: { coinId: "usdt-tether", depType: "wrapper" },
};

export function wrapperAssetMeta(key: WrapperAssetKey): {
  coinId: string;
  depType: ReserveSlice["depType"];
} {
  return WRAPPER_ASSET_META[key];
}
