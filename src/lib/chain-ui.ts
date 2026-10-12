import { getNetColor } from "@shared/lib/format";

/** Health band presentation is owned by `shared/lib/classification/chain-health.ts` (one authority with the Worker). */
export {
  CHAIN_HEALTH_BAND_ORDER as HEALTH_BAND_ORDER,
  CHAIN_HEALTH_BADGE_CLASSES as HEALTH_BADGE_CLASSES,
  CHAIN_HEALTH_TEXT_CLASSES as HEALTH_TEXT_CLASSES,
  CHAIN_HEALTH_FILL_CLASSES as HEALTH_FILL_CLASSES,
  CHAIN_HEALTH_HEX as HEALTH_HEX_FILL,
} from "@shared/lib/classification";

const CHAIN_ACCENT_HEX: Record<string, string> = {
  arbitrum: "#28a0f0",
  base: "#0052ff",
  bsc: "#f3ba2f",
  ethereum: "#627eea",
  hyperliquid: "#50e3c2",
  polygon: "#8247e5",
  solana: "#14f195",
  tron: "#ff060a",
};

export function chainAccentHex(id: string): string {
  const curated = CHAIN_ACCENT_HEX[id];
  if (curated) return curated;

  let hash = 0;
  for (const char of id) {
    hash = (hash * 31 + char.charCodeAt(0)) % 360;
  }
  return `oklch(0.68 0.14 ${hash})`;
}

export function trendColor(value: number | null): string {
  if (value == null) return "text-muted-foreground";
  return getNetColor(value, {
    positiveClass: "text-emerald-600 dark:text-emerald-400",
    negativeClass: "text-red-600 dark:text-red-400",
    zeroClass: "text-emerald-600 dark:text-emerald-400",
    positiveInclusiveZero: true,
  });
}
