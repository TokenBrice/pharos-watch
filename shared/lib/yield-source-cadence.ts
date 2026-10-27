import { CRON_INTERVALS } from "./cron-jobs";
import { DAY_MS } from "./time-constants";

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

export const SLOW_NAV_SOURCE_KEYS: ReadonlySet<string> = new Set([
  "protocol-api:hashnote-usyc",
  "protocol-api:midas-mmev-nav-oracle",
  "protocol-api:re-protocol-reusd",
]);

export function isSupplementalOnchainSource(sourceKey: string | null | undefined): boolean {
  return sourceKey?.startsWith("aave-v3-onchain:") === true || sourceKey?.startsWith("compound-v3:") === true;
}

/** Observation cadence for a ranking source class. */
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
