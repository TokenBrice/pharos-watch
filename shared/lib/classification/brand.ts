/**
 * Third-party brand swatches (DEX protocols, chains, VM families, oracles).
 * These identify an external brand, not a risk level.
 */

export const DEX_PROTOCOL_SWATCH_CLASSES: Readonly<Record<string, string>> = {
  curve: "bg-blue-500",
  "uniswap-v2": "bg-pink-300",
  "uniswap-v3": "bg-pink-500",
  "uniswap-v4": "bg-pink-400",
  fluid: "bg-cyan-500",
  balancer: "bg-violet-500",
  aerodrome: "bg-sky-500",
  velodrome: "bg-red-500",
  aero: "bg-blue-600",
  pancakeswap: "bg-amber-500",
  sushiswap: "bg-indigo-500",
  "trader-joe": "bg-orange-500",
  raydium: "bg-purple-500",
  orca: "bg-teal-400",
  meteora: "bg-sky-500",
  quickswap: "bg-violet-500",
  ekubo: "bg-orange-500",
};

/** Swatches handed out in order to protocols without a brand swatch. */
export const DEX_FALLBACK_SWATCH_CLASSES: readonly string[] = [
  "bg-emerald-500",
  "bg-lime-500",
  "bg-teal-500",
  "bg-rose-500",
  "bg-fuchsia-500",
  "bg-yellow-500",
  "bg-purple-500",
  "bg-orange-400",
];

export const CHAIN_SWATCH_CLASSES: Readonly<Record<string, string>> = {
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

export const CHAIN_VM_BADGE_CLASSES = {
  evm: "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20",
  tron: "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20",
} as const;

/** Dark logo wells for oracle marks drawn in white. */
export const ORACLE_BRAND_SWATCH_CLASSES: Readonly<Record<string, string>> = {
  redstone: "bg-zinc-950",
};
