/**
 * Shared constants for DEX liquidity display.
 *
 * All protocol/chain names, colors, and formatting helpers live here.
 * Tailwind classes are static string literals for purge safety.
 */

export const PROTOCOL_NAMES: Record<string, string> = {
  curve: "Curve",
  "uniswap-v3": "Uniswap V3",
  uniswap: "Uniswap",
  fluid: "Fluid",
  balancer: "Balancer",
  aerodrome: "Aerodrome",
  velodrome: "Velodrome",
  pancakeswap: "PancakeSwap",
  sushiswap: "SushiSwap",
  "trader-joe": "Trader Joe",
};

export const PROTOCOL_COLORS: Record<string, string> = {
  curve: "bg-blue-500",
  "uniswap-v3": "bg-pink-500",
  uniswap: "bg-pink-400",
  fluid: "bg-cyan-500",
  balancer: "bg-violet-500",
  aerodrome: "bg-sky-500",
  velodrome: "bg-red-500",
  pancakeswap: "bg-amber-500",
  sushiswap: "bg-indigo-500",
  "trader-joe": "bg-orange-500",
};

export const EXTRA_COLORS = [
  "bg-emerald-500", "bg-lime-500", "bg-teal-500", "bg-rose-500",
  "bg-fuchsia-500", "bg-yellow-500", "bg-purple-500", "bg-orange-400",
];

export const CHAIN_COLORS: Record<string, string> = {
  Ethereum: "bg-blue-600",
  Arbitrum: "bg-sky-500",
  Base: "bg-blue-400",
  Polygon: "bg-violet-500",
  BSC: "bg-amber-500",
  Optimism: "bg-red-500",
  Avalanche: "bg-red-600",
  Solana: "bg-emerald-500",
  Gnosis: "bg-teal-500",
  Fantom: "bg-blue-300",
};

/** Prettify a DeFiLlama project slug into a display name */
export function prettifyProtocol(slug: string): string {
  if (PROTOCOL_NAMES[slug]) return PROTOCOL_NAMES[slug];
  return slug
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
