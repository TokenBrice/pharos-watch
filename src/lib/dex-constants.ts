/**
 * Shared constants for DEX liquidity display.
 *
 * All protocol/chain names, colors, and formatting helpers live here.
 * Tailwind classes are static string literals for purge safety.
 */

const PROTOCOL_NAMES: Record<string, string> = {
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
  raydium: "Raydium",
  orca: "Orca",
  quickswap: "QuickSwap",
};

export const PROTOCOL_LOGOS: Record<string, string> = {
  curve: "/dexes/curve.png",
  "uniswap-v3": "/dexes/uniswap-v3.png",
  uniswap: "/dexes/uniswap-v3.png",
  fluid: "/dexes/fluid.png",
  balancer: "/dexes/balancer.png",
  aerodrome: "/dexes/aerodrome.png",
  velodrome: "/dexes/velodrome.png",
  pancakeswap: "/dexes/pancakeswap.png",
  sushiswap: "/dexes/sushiswap.png",
  "trader-joe": "/dexes/trader-joe.png",
  raydium: "/dexes/raydium.png",
  orca: "/dexes/orca.png",
  quickswap: "/dexes/quickswap.png",
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
  raydium: "bg-purple-500",
  orca: "bg-teal-400",
  quickswap: "bg-violet-500",
};

export const EXTRA_COLORS = [
  "bg-emerald-500", "bg-lime-500", "bg-teal-500", "bg-rose-500",
  "bg-fuchsia-500", "bg-yellow-500", "bg-purple-500", "bg-orange-400",
];

export const CHAIN_COLORS: Record<string, string> = {
  ethereum: "bg-blue-600",
  arbitrum: "bg-sky-500",
  base: "bg-blue-400",
  polygon: "bg-violet-500",
  bsc: "bg-amber-500",
  optimism: "bg-red-500",
  avalanche: "bg-red-600",
  solana: "bg-emerald-500",
  gnosis: "bg-teal-500",
  fantom: "bg-blue-300",
};

const CHAIN_DISPLAY_NAMES: Record<string, string> = {
  ethereum: "Ethereum",
  arbitrum: "Arbitrum",
  base: "Base",
  polygon: "Polygon",
  bsc: "BSC",
  optimism: "Optimism",
  avalanche: "Avalanche",
  solana: "Solana",
  gnosis: "Gnosis",
  fantom: "Fantom",
};

/** Normalize a chain name to lowercase for color lookup, returning a canonical display name. */
export function normalizeChain(chain: string): string {
  const key = chain.toLowerCase();
  return CHAIN_DISPLAY_NAMES[key] ?? chain;
}

/** Prettify a DeFiLlama project slug into a display name */
export function prettifyProtocol(slug: string): string {
  if (PROTOCOL_NAMES[slug]) return PROTOCOL_NAMES[slug];
  return slug
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
