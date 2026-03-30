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

/**
 * Mark a reserve slice as blacklistable without linking to a specific tracked
 * stablecoin. Use for CeFi/institutional positions (prime brokers, private
 * credit, centralized custody) whose underlying assets are USD-denominated
 * and held at centralized venues — they carry freeze/seizure risk even though
 * they don't map to a single stablecoin coinId.
 */
export function cefiPositionMeta(): { blacklistable: true } {
  return { blacklistable: true };
}
