import type { ReserveAdapterCoin } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { fetchJsonWithRetry, fetchTextWithRetry, parseFiniteNumber, requireJsonInput, requireHtmlInput, requireRecord, slicesFromValues, unverifiedFreshnessMetadata } from "./helpers";
import type { AdapterContext, AdapterResult } from "./types";

export const MATRIXDOCK_STBT_STATS_URL = "https://www.matrixdock.com/bond/anon/website/api/v1/stats";
export const MATRIXDOCK_STBT_STATS_FALLBACK_URL = "https://app.matrixdock.com/bond/anon/website/api/v1/stats";
const MATRIXDOCK_STBT_STATS_URLS = new Set([MATRIXDOCK_STBT_STATS_URL, MATRIXDOCK_STBT_STATS_FALLBACK_URL]);
const MATRIXDOCK_STBT_URL = "https://www.matrixdock.com/stbt";
const BUCKETS: Record<string, { name: string; risk: "low" | "medium" }> = {
  asset_nav_t_bill: { name: "U.S. Treasury bills (STBT issuer reserves)", risk: "low" },
  asset_nav_repo: { name: "Treasury repos (STBT issuer reserves)", risk: "low" },
  asset_nav_buidl: { name: "BUIDL fund units (STBT issuer reserves)", risk: "medium" },
  asset_nav_ustb: { name: "USTB fund units (STBT issuer reserves)", risk: "medium" },
  asset_nav_cash_reserve: { name: "Cash (STBT issuer reserves)", risk: "medium" },
};

export function parseMatrixdockStbt(html: string): AdapterResult {
  if (!html.toLowerCase().includes("0x530824da86689c9c17cdc2871ff29b058345b44a")) throw new Error("matrixdock-stbt missing native token identity");
  let flight = "";
  for (const script of html.matchAll(/<script[^>]*>self\.__next_f\.push\((\[[\s\S]*?\])\)<\/script>/g)) {
    const chunk: unknown = JSON.parse(script[1]);
    if (Array.isArray(chunk) && chunk[0] === 1 && typeof chunk[1] === "string") flight += chunk[1];
  }
  const candidates: Record<string, unknown>[] = [];
  for (const line of flight.split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 0 || !line.slice(separator + 1).startsWith("{")) continue;
    const record = requireRecord(JSON.parse(line.slice(separator + 1)), "matrixdock-stbt invalid flight record");
    if (record.asset_nav != null && record.stbt_total_supply != null) candidates.push(record);
  }
  if (candidates.length !== 1) throw new Error("matrixdock-stbt missing or ambiguous asset census");
  return normalizeMatrixdockStbtCensus(candidates[0], MATRIXDOCK_STBT_URL, "issuer-flight-state");
}

function normalizeMatrixdockStbtCensus(data: Record<string, unknown>, sourceUrl: string, freshnessSource: string): AdapterResult {
  const amount = (key: string) => parseFiniteNumber(data[key], { label: `matrixdock-stbt ${key}`, min: 0 });
  const total = amount("asset_nav");
  const supply = amount("stbt_total_supply");
  if (total <= 0 || supply <= 0) throw new Error("matrixdock-stbt missing positive NAV or supply");
  if (Object.keys(data).some((key) => key.startsWith("asset_nav_") && !BUCKETS[key])) throw new Error("matrixdock-stbt unreviewed asset census category");
  const rows = Object.entries(BUCKETS).map(([key, bucket]) => ({ sourceKey: `matrixdock-stbt:bucket:${key}`, ...bucket, value: amount(key) }));
  if (Math.abs(rows.reduce((sum, row) => sum + row.value, 0) - total) > 0.02) throw new Error("matrixdock-stbt unreconciled asset NAV");
  return {
    slices: slicesFromValues(rows, null),
    metadata: {
      supplyTokens: supply, collateralizationRatio: total / supply, freshnessMode: "unverified",
      details: { ...unverifiedFreshnessMetadata(freshnessSource, "No reserve observation timestamp published").details, sourceUrl, issuerReportedAssetNavUsd: total, sourceTimestampPublished: false, scope: "Undated issuer reserve NAV and token stock. STBT is an unsecured issuer claim; asset buckets do not establish direct token-holder title, audited coverage, exclusive allocation or redemption capacity." },
    },
  };
}

export function parseMatrixdockStbtStats(payload: unknown, sourceUrl: string): AdapterResult {
  if (!MATRIXDOCK_STBT_STATS_URLS.has(sourceUrl)) throw new Error("matrixdock-stbt unreviewed stats endpoint");
  const envelope = requireRecord(payload, "matrixdock-stbt invalid stats envelope");
  if (envelope.code !== 0 || typeof envelope.message !== "string"
    || Object.keys(envelope).some((key) => !["code", "data", "message"].includes(key))) {
    throw new Error("matrixdock-stbt unsuccessful or unreviewed stats envelope");
  }
  const data = requireRecord(envelope.data, "matrixdock-stbt invalid asset census");
  // This reviewed product-scoped endpoint reports USD NAV. New currency,
  // product, clock or allocation fields need a scope review, never an inference.
  const reviewedFields = new Set([
    "asset_nav", ...Object.keys(BUCKETS),
    "asset_repo_per", "asset_t_bill_per", "asset_buidl_per", "asset_ustb_per", "asset_cash_reserve_per",
    "stbt_total_supply", "stbt_por", "stbt", "reserve",
  ]);
  if (Object.keys(data).some((key) => !reviewedFields.has(key))) throw new Error("matrixdock-stbt unreviewed stats census scope");
  return normalizeMatrixdockStbtCensus(data, sourceUrl, "issuer-stats-json");
}

export async function fetchMatrixdockStbtReserves(coin: ReserveAdapterCoin, config: LiveReservesConfig, signal: AbortSignal, ctx?: AdapterContext): Promise<AdapterResult> {
  if (coin.id !== "stbt-matrixdock") throw new Error("matrixdock-stbt coin or endpoint mismatch");
  if (config.inputs.primary.kind === "http-json") {
    const input = requireJsonInput(config.inputs.primary, "matrixdock-stbt");
    if (!MATRIXDOCK_STBT_STATS_URLS.has(input.url)) throw new Error("matrixdock-stbt coin or endpoint mismatch");
    return parseMatrixdockStbtStats(await fetchJsonWithRetry(input.url, signal, 10_000, ctx), input.url);
  }
  const input = requireHtmlInput(config.inputs.primary, "matrixdock-stbt");
  if (input.url !== MATRIXDOCK_STBT_URL) throw new Error("matrixdock-stbt coin or endpoint mismatch");
  return parseMatrixdockStbt(await fetchTextWithRetry(input.url, signal, 10_000, ctx, { maxResponseBytes: 1024 * 1024 }));
}
