import { REVIEWED_BUSINESS_CALENDARS } from "../data/business-calendars/reviewed";
import { localDateInIanaTimezone, nextIanaLocalHourDueAt } from "./iana-local-time";
import { isMorphoNetYieldSourceKey, MORPHO_NET_YIELD_SOURCE_PREFIX, ZEPHYR_YIELD_HISTORY_POLICY } from "./yield-source-history";
import { CRON_INTERVALS } from "./cron-jobs";
import { DAY_MS, HOUR_SECONDS, SECONDS_PER_MINUTE } from "./time-constants";

function defineMorphoNetSource(stablecoinId: string, vaultAddress: string, corroboratingPoolId: string, yieldSource: string, order: number) {
  const label = `${yieldSource} net APY`;
  return {
    stablecoinId,
    vaultAddress,
    corroboratingPoolId,
    sourceKey: `${MORPHO_NET_YIELD_SOURCE_PREFIX}ethereum:${vaultAddress}`,
    supplementalSourceKey: `protocol-api:morpho-vault:ethereum:${vaultAddress}`,
    manifestLabel: label,
    yieldSource,
    yieldType: "lending-vault",
    venueProtocol: "morpho-blue",
    standalone: false,
    dispatchOrder: order,
    routeOrder: order,
    timeoutLabel: label,
    slowNav: false,
  } as const;
}

export const MORPHO_NET_YIELD_SOURCES = {
  gtusdcMorpho: defineMorphoNetSource("gtusdc-gauntlet", "0xdd0f28e19c1780eb6396170735d45153d261490d",
    "a306885c-001e-4479-9ae8-459a56527bc1", "Gauntlet USDC Prime V1 MetaMorpho vault", 13),
  bbqusdcMorpho: defineMorphoNetSource("bbqusdc-steakhouse", "0xbeefff209270748ddd194831b3fa287a5386f5bc",
    "36977448-9ad9-43ea-85f2-60ee1b92ecd0", "Smokehouse USDC MetaMorpho vault", 14),
};

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
  ...MORPHO_NET_YIELD_SOURCES,
} as const;

/**
 * Producer cadence authority for yield ranking sources: how often each source
 * class actually receives a new observation. Worker scoring bounds derive from
 * it (`worker/src/lib/yield-ranking-helpers.ts`), and reader-facing source-age
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

const USYC_NAV_CALENDAR = REVIEWED_BUSINESS_CALENDARS["us-federal-reserve"];
export const USYC_NAV_FUTURE_SKEW_SEC = 5 * SECONDS_PER_MINUTE;
const USYC_NAV_REPORT_GRACE_SEC = 2 * HOUR_SECONDS;

/** Circle normally reports at 06:45 ET on business days; allow two hours of delay. */
export function getUsycNavReportWindow(
  sourceObservedAtSec: number | null | undefined,
): { expectedAtSec: number; staleAfterSec: number } | null {
  if (sourceObservedAtSec == null || !Number.isSafeInteger(sourceObservedAtSec) || sourceObservedAtSec <= 0) return null;
  const { timezone, coverage, weekendDays, holidays } = USYC_NAV_CALENDAR;
  const observedDate = localDateInIanaTimezone(sourceObservedAtSec * 1000, timezone);
  if (observedDate == null || observedDate < coverage.from || observedDate > coverage.to) return null;

  const lastCoveredDayMs = Date.parse(coverage.to);
  for (let dayMs = Date.parse(observedDate) + DAY_MS; dayMs <= lastCoveredDayMs; dayMs += DAY_MS) {
    const date = new Date(dayMs);
    const dateLabel = date.toISOString().slice(0, 10);
    if (weekendDays.includes(date.getUTCDay()) || holidays.includes(dateLabel)) continue;
    const reportHourMs = nextIanaLocalHourDueAt(dayMs, timezone, 6);
    if (reportHourMs == null) return null;
    const expectedAtSec = reportHourMs / 1000 + 45 * SECONDS_PER_MINUTE;
    return { expectedAtSec, staleAfterSec: expectedAtSec + USYC_NAV_REPORT_GRACE_SEC };
  }
  return null;
}

export function getUsycNavFreshness(
  sourceObservedAtSec: number | null | undefined,
  nowSec: number,
): "fresh" | "aging" | "stale" | "unknown" {
  if (sourceObservedAtSec == null || !Number.isFinite(nowSec) || nowSec <= 0
    || sourceObservedAtSec > nowSec + USYC_NAV_FUTURE_SKEW_SEC) return "unknown";
  const window = getUsycNavReportWindow(sourceObservedAtSec);
  if (window == null) return "unknown";
  if (nowSec > window.staleAfterSec) return "stale";
  return nowSec >= window.expectedAtSec ? "aging" : "fresh";
}

export function isSupplementalOnchainSource(sourceKey: string | null | undefined): boolean {
  return sourceKey?.startsWith("aave-v3-onchain:") === true || sourceKey?.startsWith("compound-v3:") === true;
}

export function getYieldSourceAgingThresholdMs(
  dataSource: string,
  sourceKey: string | null | undefined,
  staleThresholdMs: number,
): number {
  const cadenceMs = getYieldSourceProducerCadenceMs(dataSource, sourceKey);
  return cadenceMs + (staleThresholdMs - cadenceMs) / 2;
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
  if ((dataSource === "protocol-api" && !isMorphoNetYieldSourceKey(sourceKey))
    || (dataSource === "onchain" && isSupplementalOnchainSource(sourceKey))) {
    return CRON_INTERVALS["sync-yield-supplemental"] * 1000;
  }
  return CRON_INTERVALS["sync-yield-data"] * 1000;
}
