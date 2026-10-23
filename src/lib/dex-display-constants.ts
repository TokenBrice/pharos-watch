/**
 * Shared constants for DEX liquidity display.
 *
 * All protocol/chain names, colors, and formatting helpers live here.
 * Tailwind classes are static string literals for purge safety.
 */
import { CHAIN_SWATCH_CLASSES, DEX_FALLBACK_SWATCH_CLASSES, DEX_PROTOCOL_SWATCH_CLASSES } from "@shared/lib/classification";
import { CHAIN_META } from "@shared/types/chain-identity";

const PROTOCOL_NAMES: Record<string, string> = {
  curve: "Curve",
  "uniswap-v2": "Uniswap V2",
  "uniswap-v3": "Uniswap V3",
  "uniswap-v4": "Uniswap V4",
  fluid: "Fluid",
  balancer: "Balancer",
  aerodrome: "Aerodrome",
  velodrome: "Velodrome",
  aero: "Aero",
  pancakeswap: "PancakeSwap",
  sushiswap: "SushiSwap",
  "trader-joe": "Trader Joe",
  raydium: "Raydium",
  orca: "Orca",
  meteora: "Meteora",
  quickswap: "QuickSwap",
  ekubo: "Ekubo",
};

export const PROTOCOL_LOGOS: Record<string, string> = {
  curve: "/dexes/curve.png",
  "uniswap-v2": "/dexes/uniswap-v2.png",
  "uniswap-v3": "/dexes/uniswap-v3.png",
  "uniswap-v4": "/dexes/uniswap-v4.png",
  fluid: "/dexes/fluid.png",
  balancer: "/dexes/balancer.png",
  aerodrome: "/dexes/aerodrome.png",
  velodrome: "/dexes/velodrome.png",
  aero: "/dexes/aero.png",
  pancakeswap: "/dexes/pancakeswap.png",
  sushiswap: "/dexes/sushiswap.png",
  "trader-joe": "/dexes/trader-joe.png",
  raydium: "/dexes/raydium.png",
  orca: "/dexes/orca.png",
  meteora: "/dexes/meteora.png",
  quickswap: "/dexes/quickswap.png",
  ekubo: "/dexes/ekubo.jpeg",
};

export const PROTOCOL_COLORS: Record<string, string> = DEX_PROTOCOL_SWATCH_CLASSES;

export const EXTRA_COLORS = DEX_FALLBACK_SWATCH_CLASSES;

const CHAIN_COLORS: Record<string, string> = CHAIN_SWATCH_CLASSES;

/** Hex equivalents of CHAIN_COLORS for SVG fill attributes (Recharts) */
export const CHAIN_HEX: Record<string, string> = {
  ethereum: "#2563eb",
  arbitrum: "#0ea5e9",
  base: "#60a5fa",
  polygon: "#8b5cf6",
  bsc: "#f59e0b",
  optimism: "#ef4444",
  avalanche: "#dc2626",
  solana: "#10b981",
  gnosis: "#14b8a6",
  fantom: "#93c5fd",
};

/** Hex equivalents of PROTOCOL_COLORS for SVG fill attributes (Recharts) */
export const PROTOCOL_HEX: Record<string, string> = {
  curve: "#3b82f6",
  "uniswap-v2": "#f9a8d4",
  "uniswap-v3": "#ec4899",
  "uniswap-v4": "#f472b6",
  fluid: "#06b6d4",
  balancer: "#8b5cf6",
  aerodrome: "#0ea5e9",
  velodrome: "#ef4444",
  aero: "#2563eb",
  pancakeswap: "#f59e0b",
  sushiswap: "#6366f1",
  "trader-joe": "#f97316",
  raydium: "#a855f7",
  orca: "#2dd4bf",
  meteora: "#0ea5e9",
  quickswap: "#8b5cf6",
  ekubo: "#f97316",
};

/** Normalize a chain name to lowercase for color lookup, returning a canonical display name. */
export function normalizeChain(chain: string): string {
  const key = chain.toLowerCase();
  return CHAIN_META[key]?.name ?? chain;
}

export function chainColorClass(chain: string): string {
  return CHAIN_COLORS[chain.toLowerCase()] ?? "bg-muted-foreground";
}

export function chainLogo(chain: string): { path: string; darkInvert?: boolean } | null {
  const meta = CHAIN_META[chain.toLowerCase()];
  return meta?.logoPath ? { path: meta.logoPath, darkInvert: meta.darkInvert } : null;
}

/** Prettify a DeFiLlama project slug into a display name */
export function prettifyProtocol(slug: string): string {
  if (PROTOCOL_NAMES[slug]) return PROTOCOL_NAMES[slug];
  return slug
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function protocolLogo(protocol: string): { path: string } | null {
  const path = PROTOCOL_LOGOS[protocol];
  return path ? { path } : null;
}
