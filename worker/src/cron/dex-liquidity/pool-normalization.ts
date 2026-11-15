import { GT_DEX_QUALITY, QUALITY_MULTIPLIERS } from "../../lib/dex-cron-constants";
import { canonicalExitRouteChain, canonicalExitRouteScopedId } from "@shared/types/exit-route-identity";

/** Resolve quality multiplier for a GeckoTerminal pool based on DEX ID. */
export function getGtDexQuality(dexId: string): number {
  for (const [prefix, quality] of GT_DEX_QUALITY) {
    if (dexId.startsWith(prefix)) return quality;
  }
  return QUALITY_MULTIPLIERS["generic"]!;
}

/** Normalize protocol names for grouping (merge variants, pass through the rest). */
export function normalizeProtocol(project: string): string {
  const p = project.toLowerCase().replace(/[-_]/g, "");
  if (p.includes("curve")) return "curve";
  if (p.includes("uniswapv3") || p === "univ3") return "uniswap-v3";
  if (p.includes("uniswapv4")) return "uniswap-v4";
  if (p.includes("uniswap")) return "uniswap-v2";
  if (p.includes("fluid")) return "fluid";
  if (p.includes("meteora")) return "meteora";
  if (p.includes("balancer")) return "balancer";
  if (p.includes("aerodrome")) return "aerodrome";
  // Aero (Aerodrome + Velodrome merger, 2026-10-22): DefiLlama `aero-slipstream`
  // / `aero-basic`, GeckoTerminal `aero-slipstream-<chain>`, DexScreener `aero`.
  if (p === "aero" || /^aero\s*(slipstream|basic)/.test(p)) return "aero";
  if (p.includes("velodrome")) return "velodrome";
  if (p.includes("pancakeswap") || p.includes("pcsv")) return "pancakeswap";
  if (p.includes("sushiswap") || p === "sushi") return "sushiswap";
  if (p.includes("carbondefi")) return "carbon-defi";
  if (p.includes("traderjoe")) return "trader-joe";
  if (p.includes("raydium")) return "raydium";
  if (p.includes("orca")) return "orca";
  if (p === "cetus" || p === "cetusclmm") return "cetus";
  if (p === "bluefin" || p === "bluefinspot") return "bluefin";
  if (p.includes("quickswap")) return "quickswap";
  if (p.includes("ekubo")) return "ekubo";
  return project;
}

/**
 * Fallback DEX ids that belong to a protocol's exhaustive direct-API census but
 * keep their own scoring vocabulary. Beets is Balancer's front end on Sonic,
 * Optimism and Base: the Balancer census reads its pools by address, so a staged
 * Beets row is confirmed or vetoed there even though `normalizeProtocol` keeps
 * "beets-…" as its own protocol label (and its own quality multiplier).
 */
const CENSUS_PROTOCOL_ALIAS_PREFIXES: readonly (readonly [string, string])[] = [["beets", "balancer"]];

/** The protocol whose exhaustive census confirms a staged row's exact pool id. */
export function resolveCensusProtocol(protocol: string): string {
  const id = protocol.toLowerCase();
  const alias = CENSUS_PROTOCOL_ALIAS_PREFIXES.find(([prefix]) => id.startsWith(prefix));
  return alias ? alias[1] : protocol;
}

/** Candidate token-pair metadata for unique joins; never an exact aggregate key. */
export function buildPoolFingerprint(chain: string, protocol: string, tokenAddresses: string[]): string | null {
  if (tokenAddresses.length < 2) return null;
  const canonicalChain = canonicalExitRouteChain(chain);
  const normalized = tokenAddresses
    .map((token) => canonicalExitRouteScopedId(canonicalChain, token))
    .filter(Boolean)
    .sort();
  if (normalized.length < 2) return null;
  return `fp:${canonicalChain}:${normalizeProtocol(protocol)}:${normalized.join(":")}`;
}
