const LENDING_PROTOCOLS = {
  "aave-v3": { label: "Aave v3" },
  "aave-v4": { label: "Aave v4" },
  "compound-v3": { label: "Compound v3" },
  "sparklend": { label: "SparkLend" },
  "spark-savings": { label: "Spark Savings" },
  "maple": { label: "Maple Finance" },
  "yearn-finance": { label: "Yearn" },
  "compound-v2": { label: "Compound v2" },
  "dolomite": { label: "Dolomite" },
  "fluid-lending": { label: "Fluid" },
  "euler-v2": { label: "Euler v2" },
  "venus-core-pool": { label: "Venus" },
  "kamino-lend": { label: "Kamino" },
  "morpho-v1": { label: "Morpho" },
  "morpho-blue": { label: "Morpho Blue" },
  "pendle": { label: "Pendle" },
  "curve-llamalend": { label: "Curve LlamaLend" },
  "exactly": { label: "Exactly" },
  "flux-finance": { label: "Flux Finance" },
  "gains-network": { label: "Gains Network" },
  "lazy-summer-protocol": { label: "Lazy Summer" },
  "moonwell-lending": { label: "Moonwell" },
  "silo-v2": { label: "Silo v2" },
  "justlend": { label: "JustLend" },
  "openeden-usdo": { label: "OpenEden" },
  "multipli.fi": { label: "Multipli" },
  "jupiter-lend": { label: "Jupiter Lend" },
  "stables-labs-usdx": { label: "Stables Labs" },
  "benqi-lending": { label: "BENQI" },
  "radiant-v2": { label: "Radiant v2" },
  "fraxlend-v2": { label: "Fraxlend" },
  "clearpool": { label: "Clearpool" },
  "centrifuge": { label: "Centrifuge" },
  "sturdy-v2": { label: "Sturdy v2" },
  "goldfinch": { label: "Goldfinch" },
  "truefi": { label: "TrueFi" },
  "lagoon": { label: "Lagoon" },
  "liqwid": { label: "Liqwid" },
  "lista-lending": { label: "Lista Lending" },
  "loopscale": { label: "Loopscale" },
  "more-markets": { label: "More Markets" },
  "navi-lending": { label: "NAVI Lending" },
  "overnight-finance": { label: "Overnight" },
  "smardex-usdn": { label: "SmarDex USDN" },
  "vesper": { label: "Vesper" },
  "felix-cdp": { label: "Felix" },
  "sovryn-dex": { label: "Sovryn" },
  // Tier A — 2026-03-25 audit (>$50M TVL)
  "wildcat-protocol": { label: "Wildcat" },
  "tectonic": { label: "Tectonic" },
  "upshift": { label: "Upshift" },
  "venus-flux": { label: "Venus Flux" },
  "avantis": { label: "Avantis" },
  "cap": { label: "Cap" },
  "resupply": { label: "Resupply" },
  "zerobase-cedefi": { label: "ZeroBase" },
  // Tier B — 2026-03-25 audit ($10M–$50M TVL)
  "convex-finance": { label: "Convex Finance" },
  "yo-protocol": { label: "Yo Protocol" },
  "clearpool-lending": { label: "Clearpool Lending" },
  "3jane-lending": { label: "3Jane" },
  "hyperlend-pooled": { label: "HyperLend" },
  "zest-v2": { label: "Zest v2" },
  "liquity-v2": { label: "Liquity v2" },
  "echelon-market": { label: "Echelon" },
  "termmax": { label: "TermMax" },
  "beefy": { label: "Beefy" },
  "gearbox": { label: "Gearbox" },
  // Tier C — 2026-05-13 audit additions
  "autofinance": { label: "AutoFinance" },
  "neverland": { label: "Neverland" },
  "metrom": { label: "Metrom" },
  "mystic-finance-lending": { label: "Mystic Finance" },
  "bitway": { label: "Bitway" },
  "frankencoin": { label: "Frankencoin" },
  // Wave 2 — category-gated thin-chain/app-chain lenders (verified 2026-06-09)
  "aries-markets": { label: "Aries Markets" },
  "blend-pools-v2": { label: "Blend" },
  "current": { label: "Current" },
  "curvance": { label: "Curvance" },
  "scallop-lend": { label: "Scallop" },
  "tydro": { label: "Tydro" },
  // Wave 3 — 2026-06-11 audit queue follow-up; runtime safety/TVL gates still decide coin eligibility.
  "bifi": { label: "BiFi" },
  "fraxlend": { label: "Fraxlend v1" },
  // YIELD_ALLOWLIST_AUDIT_QUEUE_ANCHOR
  // Future allowlist rounds start from the monthly yield-coverage-audit
  // operatorQueue.recommendationCandidates entries with kind "lending-allowlist".
  // Promote only category-gated unmatched-high-TVL queue candidates; do not
  // do broad protocol hunting here.
} as const;

export const LENDING_PROTOCOL_ALLOWLIST = new Set(Object.keys(LENDING_PROTOCOLS));

export const LENDING_PROTOCOL_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(LENDING_PROTOCOLS).map(([slug, config]) => [slug, config.label]),
);

export interface AutoLendingCollisionBlock {
  readonly project?: string;
  readonly chain?: string;
  readonly symbol?: string;
  readonly underlyingToken?: string;
  readonly reason: string;
}

/**
 * Stablecoin-specific false-positive guards for same-symbol lending pools.
 * These are evaluated before both deterministic overrides and dynamic symbol
 * matching, so new DeFiLlama rows cannot silently cross-wire unrelated assets.
 */
export const AUTO_LENDING_COLLISION_BLOCKLIST: Record<string, readonly AutoLendingCollisionBlock[]> = {
  "cusd-celo": [
    { project: "pendle", symbol: "CUSD", reason: "Cap CUSD is unrelated to Celo Dollar" },
    { project: "beefy", symbol: "CUSD", reason: "Cap CUSD vault is unrelated to Celo Dollar" },
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
  "usdx-kava": [
    {
      project: "clearpool-lending",
      chain: "Flare",
      symbol: "USDX",
      underlyingToken: "0x4a771cc1a39fdd8aa08b8ea51f7fd412e73b3d2b",
      reason: "Flare USDX is Hex Trust USDX, not Kava USDX",
    },
  ],
  "usp-pareto-credit": [
    { project: "pendle", symbol: "USP", reason: "Pendle USP market is PikuDAO USP, not Pareto Credit USP" },
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
    project?: string | null;
    chain?: string | null;
    symbol?: string | null;
    underlyingTokens?: readonly string[] | null;
  },
): boolean {
  const blocks = AUTO_LENDING_COLLISION_BLOCKLIST[stablecoinId];
  if (!blocks?.length) return false;

  const project = normalized(pool.project);
  const chain = normalized(pool.chain);
  const symbol = normalized(pool.symbol);
  const underlyingTokens = new Set((pool.underlyingTokens ?? []).map((token) => normalized(token)).filter(Boolean));

  return blocks.some((block) => {
    if (block.project && normalized(block.project) !== project) return false;
    if (block.chain && normalized(block.chain) !== chain) return false;
    if (block.symbol && normalized(block.symbol) !== symbol) return false;
    if (block.underlyingToken && !underlyingTokens.has(normalized(block.underlyingToken))) return false;
    return true;
  });
}

/**
 * Deterministic auto-discovery overrides for non-yield-bearing coins.
 * Maps Pharos stablecoin ID -> DeFiLlama lending pool UUID.
 *
 * Use this when symbol-based matching is ambiguous or prone to misses.
 * Guardrails are still enforced at runtime:
 * - pool must be stablecoin + single exposure
 * - pool project must be allowlisted
 * - pool must satisfy minimum APY and TVL thresholds
 */
export const AUTO_LENDING_POOL_MAP: Record<string, string> = {
  "u-united-stables": "d8e9bb79-79d3-4897-8a4f-8d489040097d",
  "usdh-native-markets": "1c9fb97d-f432-44fb-89a0-8120b4cae95c",
  "eurcv-societe-generale-forge": "d3b28212-a46b-4db8-8bb7-2c946b3cbe76",
  "eusd-electronic-usd": "44a4e84a-4ad1-4783-ac83-3d7e432220ea",
  "usdx-hex-trust": "be50b874-8147-440d-b8ca-f2c202e9ed64",
  "usdo-openeden": "f083596e-032d-4d6b-a7a8-1836d3f99bcd",
  "usdm-moneta": "ce3021c9-af52-46b0-a61a-3e92acdfd79b",
  "feusd-felix": "2bae7cf8-d278-4b27-9959-7f5f92c6f14b",
  "dllr-sovryn": "436e4129-667b-44d6-8322-ea59ce9b587c",
  "tgbp-tokenised": "61a6a976-f70f-4f38-b4a4-a5d3fda6832c",
  "reusd-resupply": "02c7722b-dfd6-415b-8292-01dddb88c6fc",
  "xusd-babelfish": "59901fb6-d071-4923-822a-af871670a7fb",
  "usda-anzens": "fa66f3f5-24ba-4929-8549-9b811b68ef48",
};

/**
 * Deterministic IDs that may bypass MIN_SAFETY_SCORE_FOR_YIELD.
 * Reserved for explicit edge-case inclusions.
 */
export const AUTO_LENDING_SAFETY_BYPASS_IDS = new Set([
  "u-united-stables",
  "usdx-hex-trust",
  "usdo-openeden",
  "usdm-moneta",
  // reusd-resupply: exact Pendle fixed-yield market repaired on 2026-06-11.
  // Live report-card safety was 49/100, one point below the generic gate, so
  // publication is deliberately limited to the pinned pool.
  "reusd-resupply",
  // xusd-babelfish: Rootstock-only, but Sovryn is the canonical Bitcoin-side venue
  "xusd-babelfish",
]);
