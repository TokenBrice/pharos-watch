import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { BUSINESS_DAY_NAV_SOURCE_MAX_AGE_SEC } from "@shared/types/live-reserve-adapter-policy";
import { fetchTextWithRetry, parseFiniteNumber, requireHtmlInput, slicesFromValues, verifiedFreshnessMetadata } from "./helpers";
import type { AdapterContext, AdapterResult } from "./types";

export const BLACKROCK_BRSRV_HOLDINGS_URL = "https://www.blackrock.com/cash/en-us/products/351891/fund/1464253357814.ajax?fileType=csv&fileName=RSVXX_holdings&dataType=fund";
const MONTHS: Record<string, string> = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
const TYPES: Record<string, { key: string; name: string }> = {
  "U.S. Treasury Debt": { key: "treasury-debt", name: "U.S. Treasury securities (disclosed BRSRV holdings)" },
  "U.S. Treasury Repurchase Agreement": { key: "treasury-repo", name: "Treasury-secured repos (disclosed BRSRV holdings)" },
};

export function parseBlackrockBrsrvHoldings(body: string, nowSec: number): AdapterResult {
  const lines = body.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  const match = /^Fund Holdings as of,"(\d{2})-([A-Z][a-z]{2})-(\d{4})"$/.exec(lines[0] ?? "");
  if (!match || !MONTHS[match[2]]) throw new Error("blackrock-brsrv-holdings missing dated holdings header");
  const date = `${match[3]}-${MONTHS[match[2]]}-${match[1]}`;
  const timestamp = Date.parse(`${date}T00:00:00Z`) / 1000;
  if (!Number.isFinite(timestamp) || new Date(timestamp * 1000).toISOString().slice(0, 10) !== date || timestamp > nowSec || nowSec - timestamp > BUSINESS_DAY_NAV_SOURCE_MAX_AGE_SEC) throw new Error("blackrock-brsrv-holdings stale, future or invalid date");
  if (lines[1] !== "Position Description,Asset Type,%Par,Par,Market Value,Final Maturity,Maturity/Reset") throw new Error("blackrock-brsrv-holdings schema drift");
  const buckets: Record<string, number> = {};
  let parPct = 0;
  let unknownUsd = 0;
  const holdings = lines.slice(2).map((line) => {
    // This publisher quotes every field. Doubled quotes are the only CSV escape.
    const fields: string[] = [];
    let offset = 0;
    for (const field of line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)) {
      if (field.index !== offset) throw new Error("blackrock-brsrv-holdings malformed CSV");
      fields.push(field[1].replaceAll('""', '"'));
      offset += field[0].length;
    }
    if (offset !== line.length || fields.length !== 7 || !fields[0] || !fields[1]) throw new Error("blackrock-brsrv-holdings invalid row");
    const valueUsd = parseFiniteNumber(fields[4], { label: "blackrock-brsrv-holdings market value", min: 0, allowGrouped: true });
    parPct += parseFiniteNumber(fields[2], { label: "blackrock-brsrv-holdings par percentage", min: 0 });
    buckets[fields[1]] = (buckets[fields[1]] ?? 0) + valueUsd;
    if (!TYPES[fields[1]]) unknownUsd += valueUsd;
    return { position: fields[0], assetType: fields[1], valueUsd, finalMaturity: fields[5], maturityReset: fields[6] };
  });
  const total = Object.values(buckets).reduce((sum, value) => sum + value, 0);
  if (holdings.length === 0 || !Number.isFinite(total) || total <= 0 || Math.abs(parPct - 100) > 0.1) throw new Error("blackrock-brsrv-holdings incomplete or invalid disclosed holdings");
  return {
    slices: slicesFromValues(Object.entries(buckets).map(([type, value]) => ({ value, sourceKey: TYPES[type] ? `blackrock-brsrv-holdings:asset-type:${TYPES[type].key}` : undefined, name: TYPES[type]?.name ?? `Unclassified disclosed BRSRV holdings: ${type}`, risk: TYPES[type] ? "low" : "high" })), null),
    metadata: { ...verifiedFreshnessMetadata(timestamp), unknownExposurePct: unknownUsd / total * 100, details: { holdings, disclosedSecuritiesMarketValueUsd: total, holdingsDate: date, sourceUrl: BLACKROCK_BRSRV_HOLDINGS_URL, scope: "Composition of disclosed securities holdings only; excludes unreported cash and liabilities. Not a token supply, coverage, complete fund NAV or redemption-capacity measurement." } },
  };
}

export async function fetchBlackrockBrsrvHoldingsReserves(coin: StablecoinMeta, config: LiveReservesConfig, signal: AbortSignal, ctx?: AdapterContext): Promise<AdapterResult> {
  const input = requireHtmlInput(config.inputs.primary, "blackrock-brsrv-holdings");
  if (coin.id !== "brsrv-blackrock" || input.url !== BLACKROCK_BRSRV_HOLDINGS_URL) throw new Error("blackrock-brsrv-holdings coin or endpoint mismatch");
  return parseBlackrockBrsrvHoldings(await fetchTextWithRetry(input.url, signal, 10_000, ctx, { headers: { Accept: "text/csv" }, maxResponseBytes: 512 * 1024 }), ctx?.nowSec ?? Math.floor(Date.now() / 1000));
}
