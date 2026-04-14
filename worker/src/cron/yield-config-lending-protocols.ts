const LENDING_PROTOCOLS = {
  "aave-v3": { label: "Aave v3" },
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
} as const;

export const LENDING_PROTOCOL_ALLOWLIST = new Set(Object.keys(LENDING_PROTOCOLS));

export const LENDING_PROTOCOL_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(LENDING_PROTOCOLS).map(([slug, config]) => [slug, config.label]),
);

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
  "pmusd-precious-metals": "099fab49-5103-4c85-b5e6-fff734eb1691",
  "usdh-native-markets": "1c9fb97d-f432-44fb-89a0-8120b4cae95c",
  "eurcv-societe-generale-forge": "d3b28212-a46b-4db8-8bb7-2c946b3cbe76",
  "eusd-electronic-usd": "44a4e84a-4ad1-4783-ac83-3d7e432220ea",
  "usdx-hex-trust": "e7ac1a5f-f141-4c00-9a5d-2e2c505a800c",
  "usdo-openeden": "f083596e-032d-4d6b-a7a8-1836d3f99bcd",
  "usdm-moneta": "ce3021c9-af52-46b0-a61a-3e92acdfd79b",
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
]);
