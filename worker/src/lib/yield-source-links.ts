import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";

const APP_LINK_LABEL_PRIORITY = ["App", "Portal", "Earn", "Mint", "Stake", "Dashboard"] as const;
const FALLBACK_LINK_LABEL_PRIORITY = [...APP_LINK_LABEL_PRIORITY, "Website", "Docs"] as const;
const APP_LIKE_DISPLAY_LABEL = /\b(app|earn|mint|portal|stake|vault)\b/i;

const YIELD_SOURCE_URLS: Record<string, string> = {
  "Aave v3": "https://app.aave.com/",
  "Aave v4": "https://app.aave.com/",
  "B.Protocol Stability Pool (LQTY only)": "https://app.bprotocol.org/liquity",
  "BIMA savings (sUSBD)": "https://bima.money/earn",
  "Curve Savings (scrvUSD)": "https://www.curve.finance/crvusd/ethereum/scrvUSD",
  "Hashnote USYC": "https://usyc.hashnote.com/",
  "K3: sBOLD": "https://liquity.app/earn/sbold",
  "Liquity Stability Pool (via K3 sBOLD)": "https://liquity.app/earn/sbold",
  "Ondo USDY Oracle": "https://ondo.finance/usdy",
  Beefy: "https://app.beefy.com/",
  BENQI: "https://app.benqi.fi/",
  "Compound v2": "https://app.compound.finance/",
  "Compound v3": "https://app.compound.finance/",
  "Compound V3 (ethereum)": "https://app.compound.finance/",
  "Compound V3 (base)": "https://app.compound.finance/",
  "Compound V3 (arbitrum)": "https://app.compound.finance/",
  Dolomite: "https://app.dolomite.io/",
  Exactly: "https://app.exactly.app/",
  Felix: "https://felix.finance/",
  "Euler v2": "https://app.euler.finance/",
  "Flux Finance": "https://app.fluxfinance.com/",
  Fluid: "https://fluid.instadapp.io/",
  "Gains Network": "https://gains.trade/",
  JustLend: "https://justlend.org/",
  Kamino: "https://app.kamino.finance/",
  "Maple Finance": "https://app.maple.finance/earn",
  "Maple Finance lending": "https://app.maple.finance/earn",
  Moonwell: "https://app.moonwell.fi/",
  Morpho: "https://app.morpho.org/",
  "Morpho Blue": "https://app.morpho.org/",
  Multipli: "https://multipli.fi/",
  OpenEden: "https://openeden.com/usdo",
  Pendle: "https://app.pendle.finance/",
  "Spark Savings": "https://app.spark.fi/",
  SparkLend: "https://app.spark.fi/",
  "Curve LlamaLend": "https://www.curve.finance/lend",
  "Jupiter Lend": "https://jup.ag/lend",
  "Lazy Summer": "https://summer.fi/",
  "Silo v2": "https://app.silo.finance/",
  "Stables Labs": "https://stables.money/",
  Venus: "https://app.venus.io/",
  Yearn: "https://app.yearn.fi/",
  "Radiant v2": "https://app.radiant.capital/",
  Fraxlend: "https://app.frax.finance/fraxlend",
  Clearpool: "https://app.clearpool.finance/",
  Centrifuge: "https://app.centrifuge.io/",
  "Sturdy v2": "https://v2.sturdy.finance/",
  Goldfinch: "https://app.goldfinch.finance/",
  TrueFi: "https://app.truefi.io/",
  Lagoon: "https://app.lagoon.finance/",
  Liqwid: "https://app.liqwid.finance/",
  "Lista Lending": "https://lista.org/",
  Loopscale: "https://loopscale.com/",
  "More Markets": "https://app.moremarkets.xyz/",
  "NAVI Lending": "https://naviprotocol.io/",
  Overnight: "https://app.overnight.fi/",
  "SmarDex USDN": "https://smardex.io/",
  Vesper: "https://app.vesper.finance/",
  Sovryn: "https://sovryn.com/",
  Wildcat: "https://app.wildcat.finance/",
  Tectonic: "https://app.tectonic.finance/",
  Upshift: "https://app.upshift.finance/",
  "Venus Flux": "https://app.venus.io/",
  Avantis: "https://app.avantis.finance/",
  Cap: "https://app.cap.money/",
  Resupply: "https://resupply.fi/",
  ZeroBase: "https://zerobase.fi/",
  "Convex Finance": "https://www.convexfinance.com/",
  "Yo Protocol": "https://yo.xyz/",
  "Clearpool Lending": "https://app.clearpool.finance/",
  "3Jane": "https://3jane.xyz/",
  HyperLend: "https://app.hyperlend.finance/",
  "Zest v2": "https://app.zestprotocol.com/",
  "Liquity v2": "https://www.liquity.org/",
  Echelon: "https://echelon.market/",
  TermMax: "https://app.termmax.io/",
  Gearbox: "https://app.gearbox.fi/",
  Kong: "https://kong.yearn.fi/",
  // Tier C — 2026-05-13 audit additions
  AutoFinance: "https://www.auto.finance",
  Neverland: "https://neverland.money",
  Metrom: "https://www.metrom.xyz",
  "Mystic Finance": "https://www.mysticfinance.xyz/",
  Bitway: "https://bitway.com/",
  Frankencoin: "https://frankencoin.com",
  // Wave 2 — category-gated thin-chain/app-chain lenders
  "Aries Markets": "https://ariesmarkets.xyz/",
  Blend: "https://www.blend.capital/",
  Current: "https://www.current.finance/",
  Curvance: "https://app.curvance.com/",
  Scallop: "https://app.scallop.io/",
  Tydro: "https://tydro.com/",
  // Wave 3 — 2026-06-11 audit queue follow-up
  BiFi: "https://bifi.finance/",
  "Fraxlend v1": "https://app.frax.finance/fraxlend",
  // Explicit-pool labels (parenthetical asset suffix is stripped by the label fallback chain)
  "Hydration Omnipool": "https://hydration.net/",
};

function pickMetaYieldUrl(stablecoinId: string): string | null {
  const meta = TRACKED_META_BY_ID.get(stablecoinId);
  if (!meta) return null;

  const linkByLabel = new Map<string, string>();
  for (const link of meta.links ?? []) {
    if (link.url && !linkByLabel.has(link.label)) {
      linkByLabel.set(link.label, link.url);
    }
  }

  for (const label of APP_LINK_LABEL_PRIORITY) {
    const url = linkByLabel.get(label);
    if (url) {
      return url;
    }
  }

  const liveDisplay = meta.liveReservesConfig?.display;
  if (liveDisplay?.url && liveDisplay.label && APP_LIKE_DISPLAY_LABEL.test(liveDisplay.label)) {
    return liveDisplay.url;
  }

  for (const label of FALLBACK_LINK_LABEL_PRIORITY) {
    const url = linkByLabel.get(label);
    if (url) {
      return url;
    }
  }

  return meta.links?.[0]?.url ?? liveDisplay?.url ?? null;
}

function resolveLinkedVariantSourceOwnerId(stablecoinId: string, sourceKey: string | null | undefined): string | null {
  const prefix = "linked-variant:";
  if (!sourceKey?.startsWith(prefix)) return null;

  const ownerId = sourceKey.slice(prefix.length).split(":", 1)[0]?.trim();
  if (!ownerId) return null;
  const ownerMeta = TRACKED_META_BY_ID.get(ownerId);
  return ownerMeta?.variantOf === stablecoinId ? ownerId : null;
}

export function resolveYieldSourceUrl(params: {
  stablecoinId: string;
  sourceKey?: string | null;
  yieldSource?: string | null;
}): string | null {
  if (params.sourceKey?.startsWith("royco-dawn:")) {
    return "https://dawn.royco.org/explore";
  }

  const labelCandidates = params.yieldSource
    ? [
        params.yieldSource,
        params.yieldSource.replace(/\s+\([^)]*\)\s*$/, ""),
        params.yieldSource.split(":")[0]?.trim(),
        params.yieldSource.replace(/\s+\([^)]*\)\s*$/, "").split(":")[0]?.trim(),
      ].filter((label): label is string => typeof label === "string" && label.length > 0)
    : [];

  const overrideByLabel = labelCandidates
    .map((label) => YIELD_SOURCE_URLS[label] ?? null)
    .find((value): value is string => typeof value === "string" && value.length > 0) ?? null;
  if (overrideByLabel) {
    return overrideByLabel;
  }

  // Auto-generated source keys are not stable link targets. A linked wrapper is
  // owned by the child encoded in its validated source key, so its retained
  // alternatives must fall back to the child venue rather than the parent issuer.
  const sourceOwnerId = resolveLinkedVariantSourceOwnerId(params.stablecoinId, params.sourceKey);
  return pickMetaYieldUrl(sourceOwnerId ?? params.stablecoinId);
}
