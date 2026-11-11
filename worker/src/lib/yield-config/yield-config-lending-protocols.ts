import { LENDING_PROTOCOLS } from "./yield-config-lending-venues";
import { AUTO_LENDING_OVERRIDES, AUTO_LENDING_POOL_MAP } from "@shared/lib/yield-auto-lending";

export { AUTO_LENDING_POOL_MAP };

export const LENDING_PROTOCOL_ALLOWLIST = new Set(Object.keys(LENDING_PROTOCOLS));

export const LENDING_PROTOCOL_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(LENDING_PROTOCOLS).map(([slug, config]) => [slug, config.label]),
);

/**
 * Reviewed lending venues deliberately kept outside Wave-2 discovery, so adding
 * them here does not widen auto-lending publication. `project-0` is a Solana
 * lending market; its pools still hold tracked coins as deposits, which is why
 * Layer 3 must not adopt them as a coin's own yield.
 */
const LAYER3_NON_DISCOVERY_VENUE_PROJECTS = ["project-0"] as const;

/**
 * DeFiLlama project slugs that name a lending venue rather than the tracked
 * coin's issuer. Layer 3 is a base-symbol/address guess with no curated holder
 * identity, so a match inside one of these projects is a deposit market that
 * holds the coin, never the coin's own yield. Such matches are skipped; venue
 * opportunities publish only through lending discovery under its admission
 * rules, and an issuer's own pool inside such a project must be pinned in
 * `YIELD_POOL_MAP` (ADR-32: this registry owns the venue vocabulary).
 */
export const LAYER3_EXCLUDED_VENUE_PROJECTS: ReadonlySet<string> = new Set([
  ...LENDING_PROTOCOL_ALLOWLIST,
  ...LAYER3_NON_DISCOVERY_VENUE_PROJECTS,
]);

export interface AutoLendingCollisionBlock {
  readonly project?: string;
  readonly chain?: string;
  readonly symbol?: string;
  readonly underlyingToken?: string;
  /**
   * B19 stop-gap: DeFiLlama pool UUID (an 8-char prefix is enough — the loaded
   * pool id is matched with `startsWith`). Used when project/chain/symbol are
   * shared with a legitimate venue the coin does not own alone.
   */
  readonly pool?: string;
  readonly reason: string;
}

/**
 * Stablecoin-specific false-positive guards for same-symbol lending pools and
 * reviewed multi-asset vaults.
 * These are evaluated before both deterministic overrides and dynamic symbol
 * matching, so new DeFiLlama rows cannot silently cross-wire unrelated assets.
 * A block matches when every field it sets matches: project/chain/symbol and
 * `underlyingToken` exactly, `pool` as a prefix of the loaded DeFiLlama pool id
 * (entries may carry an 8-char UUID prefix).
 */
export const AUTO_LENDING_COLLISION_BLOCKLIST: Record<string, readonly AutoLendingCollisionBlock[]> = {
  "cusd-celo": [
    { project: "pendle", symbol: "CUSD", reason: "Cap CUSD is unrelated to Celo Dollar" },
    { project: "beefy", symbol: "CUSD", reason: "Cap CUSD vault is unrelated to Celo Dollar" },
  ],
  "dusd-alto": [
    { pool: "a5f9e3ff", reason: "multi-asset Yearn vault (frxUSD+DUSD)" },
  ],
  "usda-alpha-partner": [
    { project: "liqwid", chain: "Cardano", symbol: "USDA", reason: "Liqwid USDA is Anzens USDA, not Alpha Partner USDA" },
  ],
  "usda-avalon": [
    { project: "liqwid", chain: "Cardano", symbol: "USDA", reason: "Liqwid USDA is Anzens USDA, not Avalon USDA" },
  ],
  "usdcx-movement": [
    { project: "liqwid", chain: "Cardano", symbol: "USDCX", reason: "Cardano USDCX is unrelated to Movement USDCX" },
  ],
  "nusd-nexus": [
    {
      project: "pendle",
      chain: "Ethereum",
      symbol: "NUSD",
      underlyingToken: "0xe556aba6fe6036275ec1f87eda296be72c811bce",
      reason: "Pendle NUSD markets use Neutrl NUSD, not legacy Synapse/Nexus NUSD",
    },
  ],
  "sdola-inverse-finance": [
    { pool: "98fcaeb8", reason: "vault holds sDOLA plus an untracked asset" },
  ],
  "usdx-kava": [
    {
      project: "clearpool-lending",
      chain: "Flare",
      symbol: "USDX",
      underlyingToken: "0x4a771cc1a39fdd8aa08b8ea51f7fd412e73b3d2b",
      reason: "Flare USDX is Hex Trust USDX, not Kava USDX",
    },
  ],
  "usx-dforce": [
    { project: "kamino-lend", chain: "Solana", symbol: "USX", reason: "Kamino USX is Solana USX, not dForce USX" },
  ],
  "vusd-virtue": [
    {
      project: "curvance",
      chain: "Monad",
      symbol: "VUSD",
      underlyingToken: "0x8d3f1518f8b516f6542e17f48e3f8589ecabc365",
      reason: "Curvance Monad VUSD is unrelated to IOTA Virtue VUSD",
    },
  ],
  "xusd-straitsx": [
    { project: "sovryn-dex", chain: "Rootstock", symbol: "XUSD", reason: "Rootstock XUSD is BabelFish XUSD, not StraitsX XUSD" },
  ],
};

function normalized(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

export function isAutoLendingCollisionBlockedForStablecoin(
  stablecoinId: string,
  pool: {
    pool?: string | null;
    project?: string | null;
    chain?: string | null;
    symbol?: string | null;
    underlyingTokens?: readonly string[] | null;
  },
): boolean {
  const blocks = AUTO_LENDING_COLLISION_BLOCKLIST[stablecoinId];
  if (!blocks?.length) return false;

  const poolId = normalized(pool.pool);
  const project = normalized(pool.project);
  const chain = normalized(pool.chain);
  const symbol = normalized(pool.symbol);
  const underlyingTokens = new Set((pool.underlyingTokens ?? []).map((token) => normalized(token)).filter(Boolean));

  return blocks.some((block) => {
    if (block.project && normalized(block.project) !== project) return false;
    if (block.chain && normalized(block.chain) !== chain) return false;
    if (block.symbol && normalized(block.symbol) !== symbol) return false;
    if (block.underlyingToken && !underlyingTokens.has(normalized(block.underlyingToken))) return false;
    if (block.pool) {
      const blockPoolId = normalized(block.pool);
      if (!poolId || !blockPoolId || !poolId.startsWith(blockPoolId)) return false;
    }
    return true;
  });
}

/**
 * Deterministic IDs that may bypass MIN_SAFETY_SCORE_FOR_YIELD.
 * Reserved for explicit edge-case inclusions.
 */
export const AUTO_LENDING_SAFETY_BYPASS_IDS = new Set(
  Object.entries(AUTO_LENDING_OVERRIDES)
    .filter(([, override]) => override.bypassSafety)
    .map(([id]) => id),
);
