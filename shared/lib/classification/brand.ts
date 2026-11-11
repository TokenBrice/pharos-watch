import { projectDescriptors } from "./descriptors";

/**
 * Third-party brand swatches (DEX protocols, chains, VM families, oracles).
 * These identify an external brand, not a risk level.
 */

const DEX_PROTOCOL_SWATCHES: Readonly<Record<string, { className: string; hex: string }>> = {
  curve: { className: "bg-blue-500", hex: "#3b82f6" },
  "uniswap-v2": { className: "bg-pink-300", hex: "#f9a8d4" },
  "uniswap-v3": { className: "bg-pink-500", hex: "#ec4899" },
  "uniswap-v4": { className: "bg-pink-400", hex: "#f472b6" },
  fluid: { className: "bg-cyan-500", hex: "#06b6d4" },
  balancer: { className: "bg-violet-500", hex: "#8b5cf6" },
  aerodrome: { className: "bg-sky-500", hex: "#0ea5e9" },
  velodrome: { className: "bg-red-500", hex: "#ef4444" },
  aero: { className: "bg-blue-600", hex: "#2563eb" },
  pancakeswap: { className: "bg-amber-500", hex: "#f59e0b" },
  sushiswap: { className: "bg-indigo-500", hex: "#6366f1" },
  "trader-joe": { className: "bg-orange-500", hex: "#f97316" },
  raydium: { className: "bg-purple-500", hex: "#a855f7" },
  orca: { className: "bg-teal-400", hex: "#2dd4bf" },
  meteora: { className: "bg-sky-500", hex: "#0ea5e9" },
  quickswap: { className: "bg-violet-500", hex: "#8b5cf6" },
  ekubo: { className: "bg-orange-500", hex: "#f97316" },
};

export const DEX_PROTOCOL_SWATCH_CLASSES = projectDescriptors(DEX_PROTOCOL_SWATCHES, (swatch) => swatch.className);
export const DEX_PROTOCOL_SWATCH_HEX = projectDescriptors(DEX_PROTOCOL_SWATCHES, (swatch) => swatch.hex);

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

const CHAIN_SWATCHES: Readonly<Record<string, { className: string; hex: string }>> = {
  ethereum: { className: "bg-blue-600", hex: "#2563eb" },
  arbitrum: { className: "bg-sky-500", hex: "#0ea5e9" },
  base: { className: "bg-blue-400", hex: "#60a5fa" },
  polygon: { className: "bg-violet-500", hex: "#8b5cf6" },
  bsc: { className: "bg-amber-500", hex: "#f59e0b" },
  optimism: { className: "bg-red-500", hex: "#ef4444" },
  avalanche: { className: "bg-red-600", hex: "#dc2626" },
  solana: { className: "bg-emerald-500", hex: "#10b981" },
  gnosis: { className: "bg-teal-500", hex: "#14b8a6" },
  fantom: { className: "bg-blue-300", hex: "#93c5fd" },
};

export const CHAIN_SWATCH_CLASSES = projectDescriptors(CHAIN_SWATCHES, (swatch) => swatch.className);
export const CHAIN_SWATCH_HEX = projectDescriptors(CHAIN_SWATCHES, (swatch) => swatch.hex);

export const CHAIN_VM_BADGE_CLASSES = {
  evm: "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20",
  tron: "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20",
} as const;

/** Dark logo wells for oracle marks drawn in white. */
export const ORACLE_BRAND_SWATCH_CLASSES: Readonly<Record<string, string>> = {
  redstone: "bg-zinc-950",
};
