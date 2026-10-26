import { z } from "zod";
import type { ReserveAdapterCoin, ReserveSlice } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { BUSINESS_DAY_NAV_SOURCE_MAX_AGE_SEC } from "@shared/types/live-reserve-adapter-policy";
import { MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC, resolveLiveReserveSourceAgeBudget } from "@shared/lib/live-reserve-freshness";
import { RESERVE_COMPOSITION_TOTAL_TOLERANCE_PCT } from "@shared/types/reserves";
import { fetchJsonWithRetry, normalizeSlices, requireJsonInput, verifiedFreshnessMetadata } from "./helpers";
import { reserveInfoWarning } from "./warnings";
import type { AdapterContext, AdapterResult } from "./types";

const SOURCE_URL = "https://www.chinaamc.com.hk/jeecg-boot/mainFund/fundQuery/getHoldingsByFundId?fundId=USDDMMF&groupBy=none";
const PayloadSchema = z.object({
  success: z.literal(true),
  code: z.literal(200),
  result: z.array(z.object({
    fundId: z.literal("USDDMMF"),
    date: z.string().regex(/^\d{8}$/),
    securityNameEN: z.string().trim().min(1),
    weighting: z.number().finite().nonnegative().max(100),
  })).min(1).max(512),
});

const BUCKETS = {
  "term-deposits": { name: "Disclosed term deposits", risk: "low", assetClass: "bank-deposit" },
  "bank-cash": { name: "Disclosed bank cash", risk: "low", assetClass: "cash" },
  // Truncated names and the publisher's all-cash sector label prove no instrument quality.
  "unclassified-instruments": { name: "Other disclosed instruments (unclassified)", risk: "high", assetClass: "other" },
} as const satisfies Record<string, Pick<ReserveSlice, "name" | "risk" | "assetClass">>;

export function parseChinaamcHoldings(payload: unknown, nowSec: number, scoringMaxSourceAgeSec?: number): AdapterResult {
  const parsed = PayloadSchema.safeParse(payload);
  if (!parsed.success) throw new Error("chinaamc-holdings-api: invalid-holdings-payload");
  const rows = parsed.data.result;
  const date = rows[0].date;
  const isoDate = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  const utcDate = Date.parse(`${isoDate}T00:00:00Z`) / 1000;
  // Holdings dates use Hong Kong's calendar; age from the start of that local day.
  const sourceTimestamp = Date.parse(`${isoDate}T00:00:00+08:00`) / 1000;
  const freshness = resolveLiveReserveSourceAgeBudget(
    scoringMaxSourceAgeSec, BUSINESS_DAY_NAV_SOURCE_MAX_AGE_SEC, BUSINESS_DAY_NAV_SOURCE_MAX_AGE_SEC,
  );
  if (!Number.isFinite(sourceTimestamp) || new Date(utcDate * 1000).toISOString().slice(0, 10) !== isoDate ||
    sourceTimestamp > nowSec + MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC || nowSec - sourceTimestamp > freshness.sourceAgeBudgetSec ||
    rows.some((row) => row.date !== date)) {
    throw new Error("chinaamc-holdings-api: stale-or-invalid-holdings-date");
  }

  const buckets = new Map<keyof typeof BUCKETS, number>();
  const seen = new Set<string>();
  for (const row of rows) {
    const identity = JSON.stringify(row);
    if (seen.has(identity)) throw new Error("chinaamc-holdings-api: duplicate-holding-row");
    seen.add(identity);
    const key = row.securityNameEN.startsWith("Term Deposit ~ ") ? "term-deposits"
      : /^(?:Cash in Bank |Cash A\/C )/.test(row.securityNameEN) ? "bank-cash" : "unclassified-instruments";
    buckets.set(key, (buckets.get(key) ?? 0) + row.weighting);
  }
  const reportedWeightTotalPct = rows.reduce((sum, row) => sum + row.weighting, 0);
  if (Math.abs(reportedWeightTotalPct - 100) > RESERVE_COMPOSITION_TOTAL_TOLERANCE_PCT) {
    throw new Error("chinaamc-holdings-api: nonconserving-holdings-weights");
  }

  return {
    slices: normalizeSlices([...buckets].map(([key, pct]) => ({
      ...BUCKETS[key], sourceKey: `chinaamc-holdings-api:${key}`, pct, liquidityHorizon: "unknown",
    })), null),
    warnings: [reserveInfoWarning("disclosed-holdings-only",
      "Issuer-disclosed pooled fund holdings only; weights are preserved without normalization. Fund NAV, complete legal backing, Class I liabilities and redemption capacity are unverified.")],
    metadata: {
      ...verifiedFreshnessMetadata(sourceTimestamp),
      unknownExposurePct: buckets.get("unclassified-instruments") ?? 0,
      details: {
        sourceUrl: SOURCE_URL,
        sourceGeneration: `USDDMMF:${date}`,
        sourceClockPolicy: "date-only-hkt-start",
        ...freshness,
        disclosedHoldingCount: rows.length,
        reportedWeightTotalPct,
        scope: "Disclosed pooled USD sub-fund holdings across share classes; name-based cash/deposit buckets, other instruments unclassified. Not a reconciled whole-fund NAV or token-liability denominator.",
      },
    },
  };
}

export async function fetchChinaamcHoldingsReserves(
  coin: ReserveAdapterCoin, config: LiveReservesConfig, signal: AbortSignal, ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireJsonInput(config.inputs.primary, "chinaamc-holdings-api");
  if (coin.id !== "cumiu-chinaamc" || input.url !== SOURCE_URL) {
    throw new Error("chinaamc-holdings-api: coin-or-endpoint-mismatch");
  }
  const payload = await fetchJsonWithRetry<unknown>(input.url, signal, 10_000, ctx, { maxResponseBytes: 256 * 1024 });
  return parseChinaamcHoldings(payload, ctx?.nowSec ?? Math.floor(Date.now() / 1000), config.scoring?.maxSourceAgeSec);
}
