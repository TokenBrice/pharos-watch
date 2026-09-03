import { GT_DEX_QUALITY, QUALITY_MULTIPLIERS } from "../../lib/dex-cron-constants";
import { canonicalExitRouteChain, canonicalExitRouteScopedId } from "@shared/lib/exit-route-identity";

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
  if (p.includes("velodrome")) return "velodrome";
  if (p.includes("pancakeswap") || p.includes("pcsv")) return "pancakeswap";
  if (p.includes("sushiswap") || p === "sushi") return "sushiswap";
  if (p.includes("carbondefi")) return "carbon-defi";
  if (p.includes("traderjoe")) return "trader-joe";
  if (p.includes("raydium")) return "raydium";
  if (p.includes("orca")) return "orca";
  if (p.includes("quickswap")) return "quickswap";
  if (p.includes("ekubo")) return "ekubo";
  return project;
}

/** Build the canonical cross-source pool fingerprint for token-pair dedup. */
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
