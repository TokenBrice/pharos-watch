import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";

const APP_LINK_LABEL_PRIORITY = ["App", "Portal", "Earn", "Mint", "Stake", "Dashboard"] as const;
const FALLBACK_LINK_LABEL_PRIORITY = [...APP_LINK_LABEL_PRIORITY, "Website", "Docs"] as const;
const APP_LIKE_DISPLAY_LABEL = /\b(app|earn|mint|portal|stake|vault)\b/i;

const YIELD_SOURCE_URLS: Record<string, string> = {
  "Aave v3": "https://app.aave.com/",
  "B.Protocol Stability Pool (LQTY only)": "https://app.bprotocol.org/liquity",
  BENQI: "https://app.benqi.fi/",
  "Compound v2": "https://app.compound.finance/",
  "Compound v3": "https://app.compound.finance/",
  Dolomite: "https://app.dolomite.io/",
  Exactly: "https://app.exactly.app/",
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
};

function pickMetaYieldUrl(stablecoinId: string): string | null {
  const meta = TRACKED_META_BY_ID.get(stablecoinId);
  if (!meta) return null;

  for (const label of APP_LINK_LABEL_PRIORITY) {
    const link = meta.links?.find((entry) => entry.label === label);
    if (link?.url) {
      return link.url;
    }
  }

  const liveDisplay = meta.liveReservesConfig?.display;
  if (liveDisplay?.url && liveDisplay.label && APP_LIKE_DISPLAY_LABEL.test(liveDisplay.label)) {
    return liveDisplay.url;
  }

  for (const label of FALLBACK_LINK_LABEL_PRIORITY) {
    const link = meta.links?.find((entry) => entry.label === label);
    if (link?.url) {
      return link.url;
    }
  }

  return meta.links?.[0]?.url ?? liveDisplay?.url ?? null;
}

export function resolveYieldSourceUrl(params: {
  stablecoinId: string;
  sourceKey?: string | null;
  yieldSource?: string | null;
}): string | null {
  const overrideByLabel =
    params.yieldSource && YIELD_SOURCE_URLS[params.yieldSource]
      ? YIELD_SOURCE_URLS[params.yieldSource]
      : null;
  if (overrideByLabel) {
    return overrideByLabel;
  }

  // Auto-generated source keys are not stable link targets; prefer source-label
  // mappings and curated coin links instead of attempting to deep-link by pool id.
  return pickMetaYieldUrl(params.stablecoinId);
}
