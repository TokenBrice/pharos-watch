import { ZEPHYR_YIELD_HISTORY_POLICY } from "./yield-source-history";
import { CRON_INTERVALS } from "./cron-jobs";
import { DAY_MS } from "./time-constants";

/** First-party optional source declarations, in manifest order. Worker readers attach separately. */
export const OPTIONAL_YIELD_SOURCES = {
  scrvusd: {
    stablecoinId: "scrvusd-curve",
    sourceKey: "onchain:scrvusd-curve:scrvusd-current-rate",
    manifestLabel: "Curve scrvUSD current-rate reader",
    yieldSource: "Curve Savings (scrvUSD)",
    yieldType: "governance-set",
    venueProtocol: "curve-llamalend",
    standalone: false,
    dispatchOrder: 0,
    routeOrder: 9,
    timeoutLabel: "Curve scrvUSD current-rate source",
    slowNav: false,
  },
  lusd: {
    stablecoinId: "lusd-liquity",
    sourceKey: "onchain:lusd-liquity",
    manifestLabel: "B.Protocol LQTY-only",
    yieldSource: "B.Protocol Stability Pool (LQTY only)",
    yieldType: "lending-vault",
    venueProtocol: "liquity-v1",
    standalone: true,
    dispatchOrder: 0,
    routeOrder: 10,
    timeoutLabel: "B.Protocol LQTY-only source",
    slowNav: false,
  },
  baseDollar: {
    stablecoinId: "bd-basedollar",
    sourceKey: "onchain:bd-basedollar",
    manifestLabel: "Base Dollar Stability Pools (interest-only)",
    yieldSource: "Base Dollar Stability Pools (interest-only)",
    yieldType: "lending-vault",
    venueProtocol: "base-dollar",
    standalone: true,
    dispatchOrder: 1,
    routeOrder: 12,
    timeoutLabel: "Base Dollar SP interest-only source",
    slowNav: false,
  },
  bold: {
    stablecoinId: "bold-liquity",
    sourceKey: "onchain:bold-liquity",
    manifestLabel: "Liquity V2 Stability Pools (interest-only)",
    yieldSource: "Liquity V2 Stability Pools (interest-only)",
    yieldType: "lending-vault",
    venueProtocol: "liquity-v2",
    standalone: true,
    dispatchOrder: 2,
    routeOrder: 11,
    timeoutLabel: "Liquity V2 SP interest-only source",
    slowNav: false,
  },
  ybold: {
    stablecoinId: "ybold-yearn",
    sourceKey: "protocol-api:yearn:ybold",
    manifestLabel: "Yearn yBOLD Stability Pool vault",
    yieldSource: "Yearn yBOLD Stability Pool vault",
    yieldType: "lending-vault",
    venueProtocol: "yearn",
    standalone: false,
    dispatchOrder: 6,
    routeOrder: 0,
    timeoutLabel: "Yearn yBOLD source",
    slowNav: false,
  },
  hashnote: {
    stablecoinId: "usyc-hashnote",
    sourceKey: "protocol-api:hashnote-usyc",
    manifestLabel: "Hashnote NAV feed",
    yieldSource: "Hashnote USYC",
    yieldType: "nav-appreciation",
    venueProtocol: "hashnote",
    standalone: false,
    dispatchOrder: 1,
    routeOrder: 4,
    timeoutLabel: "Hashnote USYC source",
    slowNav: true,
  },
  midas: {
    stablecoinId: "mmev-midas",
    sourceKey: "protocol-api:midas-mmev-nav-oracle",
    manifestLabel: "Midas mMEV NAV oracle",
    yieldSource: "Midas mMEV/USD Oracle",
    yieldType: "nav-appreciation",
    venueProtocol: "midas-rwa",
    standalone: false,
    dispatchOrder: 3,
    routeOrder: 6,
    timeoutLabel: "Midas mMEV NAV oracle source",
    slowNav: true,
  },
  ondo: {
    stablecoinId: "usdy-ondo-finance",
    sourceKey: "protocol-api:ondo-usdy-oracle",
    manifestLabel: "Ondo USDY oracle",
    yieldSource: "Ondo USDY Oracle",
    yieldType: "nav-appreciation",
    venueProtocol: "ondo-yield-assets",
    standalone: false,
    dispatchOrder: 2,
    routeOrder: 5,
    timeoutLabel: "Ondo USDY oracle source",
    slowNav: false,
  },
  re: {
    stablecoinId: "reusd-re-protocol",
    sourceKey: "protocol-api:re-protocol-reusd",
    manifestLabel: "Re Protocol Basis-Plus (reUSD)",
    yieldSource: "Re Protocol Basis-Plus (reUSD)",
    yieldType: "nav-appreciation",
    venueProtocol: "re-protocol",
    standalone: false,
    dispatchOrder: 4,
    routeOrder: 7,
    timeoutLabel: "Re Protocol reUSD source",
    slowNav: true,
  },
  zephyr: {
    stablecoinId: ZEPHYR_YIELD_HISTORY_POLICY.stablecoinId,
    sourceKey: ZEPHYR_YIELD_HISTORY_POLICY.sourceKey,
    manifestLabel: "Zephyr Scanner ZYS returns",
    venueProtocol: "zephyr-protocol",
    standalone: false,
    dispatchOrder: 5,
    routeOrder: 8,
    timeoutLabel: "Zephyr ZYS source",
    slowNav: false,
  },
} as const;

/**
 * Producer cadence authority for yield ranking sources: how often each source
 * class actually receives a new observation. Worker scoring bounds derive from
 * it (`worker/src/lib/yield/yield-ranking-helpers.ts`), and reader-facing source-age
 * health assesses against it through the shared public gate.
 */

/**
 * Daily Pendle term-yield observations trade intraday precision for a smaller
 * anonymous-IP quota footprint. Two cycles (48h) allow one missed daily
 * refresh; observation timestamps remain unchanged during retained reuse.
 * Scheduling, ranking freshness, and family health share this authority.
 */
export const PENDLE_SUPPLEMENTAL_FETCH_CADENCE_MS = DAY_MS;

export const SLOW_NAV_SOURCE_KEYS: ReadonlySet<string> = new Set(
  Object.values(OPTIONAL_YIELD_SOURCES).filter((source) => source.slowNav).map((source) => source.sourceKey),
);

export function isSupplementalOnchainSource(sourceKey: string | null | undefined): boolean {
  return sourceKey?.startsWith("aave-v3-onchain:") === true || sourceKey?.startsWith("compound-v3:") === true;
}

export function getYieldSourceProducerCadenceMs(dataSource: string, sourceKey?: string | null): number {
  if (
    dataSource === "price-derived" ||
    dataSource === "rate-derived" ||
    (dataSource === "protocol-api" && sourceKey != null && SLOW_NAV_SOURCE_KEYS.has(sourceKey))
  ) {
    return DAY_MS;
  }
  if (dataSource === "protocol-api" && sourceKey?.startsWith("protocol-api:pendle:") === true) {
    return PENDLE_SUPPLEMENTAL_FETCH_CADENCE_MS;
  }
  if (dataSource === "protocol-api" || (dataSource === "onchain" && isSupplementalOnchainSource(sourceKey))) {
    return CRON_INTERVALS["sync-yield-supplemental"] * 1000;
  }
  return CRON_INTERVALS["sync-yield-data"] * 1000;
}
