import type { ReserveAdapterCoin } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { fetchTextWithRetry, parseFiniteNumber, requireHtmlInput, requireRecord, slicesFromValues, unverifiedFreshnessMetadata } from "./helpers";
import type { AdapterContext, AdapterResult } from "./types";

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
  const data = candidates[0];
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
      details: { ...unverifiedFreshnessMetadata("issuer-flight-state", "No reserve observation timestamp published").details, sourceUrl: MATRIXDOCK_STBT_URL, issuerReportedAssetNavUsd: total, sourceTimestampPublished: false, scope: "Undated issuer reserve NAV and token stock. STBT is an unsecured issuer claim; asset buckets do not establish direct token-holder title, audited coverage, exclusive allocation or redemption capacity." },
    },
  };
}

export async function fetchMatrixdockStbtReserves(coin: ReserveAdapterCoin, config: LiveReservesConfig, signal: AbortSignal, ctx?: AdapterContext): Promise<AdapterResult> {
  const input = requireHtmlInput(config.inputs.primary, "matrixdock-stbt");
  if (coin.id !== "stbt-matrixdock" || input.url !== MATRIXDOCK_STBT_URL) throw new Error("matrixdock-stbt coin or endpoint mismatch");
  return parseMatrixdockStbt(await fetchTextWithRetry(input.url, signal, 10_000, ctx, { maxResponseBytes: 1024 * 1024 }));
}
