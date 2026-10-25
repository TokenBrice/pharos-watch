import { z } from "zod";
import type { ReserveAdapterCoin } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { StrictIsoDateSchema } from "@shared/types/safety-schema-primitives";
import { BUSINESS_DAY_VERIFIED_VALIDATION } from "@shared/types/live-reserve-adapter-policy";
import { MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC, resolveLiveReserveSourceAgeBudget } from "@shared/lib/live-reserve-freshness";
import type { AdapterContext, AdapterResult } from "./types";
import { fetchTextWithRetry, verifiedFreshnessMetadata } from "./helpers";
import { extractEscapedJsonValueAfterKey } from "./html";

const SOURCE_URL = "https://ondo.finance/usdy";
const MAX_SOURCE_BYTES = 2_000_000;
const PORTFOLIO_KEY = '\\"portfolio\\":';
const PortfolioSchema = z.object({
  asOfDate: StrictIsoDateSchema,
  total: z.number().finite().positive(),
  positions: z.array(z.object({
    _id: z.string(),
    _type: z.literal("usdyPortfolioHolding"),
    name: z.string(),
    value: z.number().finite().nonnegative(),
  })).length(4),
});
const CATEGORIES: Record<string, { name: string; sourceKey: string }> = {
  "8a072b79-7c71-472b-8093-0a9c3347fb8f": { name: "US Treasuries", sourceKey: "usdy-issuer-portfolio:us-treasuries" },
  "7fb61f13-51eb-4e1a-8966-1a8896acb3a2": { name: "SHVon \u2014 iShares 0\u20131 Year Treasury Bond ETF (Ondo Tokenized)", sourceKey: "usdy-issuer-portfolio:shvon" },
  "58033c63-82e8-413d-a5f4-48b2aacc88ab": { name: "Silicon Valley Bank - Bank Deposits", sourceKey: "usdy-issuer-portfolio:svb-bank-deposits" },
  "67eace75-8a5b-4bff-a375-84df65697ddb": { name: "Other Cash and Cash Equivalents", sourceKey: "usdy-issuer-portfolio:other-cash-and-equivalents" },
};

export function adaptOndoUsdyPortfolio(
  html: string,
  coin: ReserveAdapterCoin,
  nowSec: number,
  scoringMaxSourceAgeSec?: number,
): AdapterResult {
  if (html.length > MAX_SOURCE_BYTES || html.split(PORTFOLIO_KEY).length !== 2) {
    throw new Error("ondo-usdy: missing-ambiguous-or-oversized-portfolio");
  }
  const portfolio = PortfolioSchema.parse(JSON.parse(
    extractEscapedJsonValueAfterKey(html, PORTFOLIO_KEY, "ondo-usdy"),
  ));
  // The issuer gives a calendar date only; UTC start-of-day conservatively ages it.
  const sourceTimestamp = Date.parse(`${portfolio.asOfDate}T00:00:00Z`) / 1000;
  const freshness = resolveLiveReserveSourceAgeBudget(
    scoringMaxSourceAgeSec,
    BUSINESS_DAY_VERIFIED_VALIDATION.maxSourceAgeSec,
    BUSINESS_DAY_VERIFIED_VALIDATION.maxSourceAgeSec,
  );
  if (sourceTimestamp > nowSec + MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC || nowSec - sourceTimestamp > freshness.sourceAgeBudgetSec) {
    throw new Error("ondo-usdy: stale-or-future-source");
  }
  const seen = new Set<string>();
  const slices = portfolio.positions.map((row) => {
    const category = CATEGORIES[row._id];
    const reviewed = coin.reserves?.filter((slice) => slice.sourceKey === category?.sourceKey);
    if (!category || row.name !== category.name || seen.has(row._id) || reviewed?.length !== 1) {
      throw new Error("ondo-usdy: duplicate-or-unreviewed-category");
    }
    seen.add(row._id);
    return { ...reviewed[0], pct: row.value / portfolio.total * 100 };
  });
  const sum = portfolio.positions.reduce((total, row) => total + row.value, 0);
  if (!Number.isFinite(sum) || Math.abs(sum - portfolio.total) > 0.01) {
    throw new Error("ondo-usdy: unreconciled-portfolio-total");
  }
  return {
    slices: slices.filter((slice) => slice.pct > 0),
    metadata: {
      ...verifiedFreshnessMetadata(sourceTimestamp),
      totalReserveUsd: portfolio.total,
      unknownExposurePct: slices.find((slice) => slice.sourceKey === "usdy-issuer-portfolio:other-cash-and-equivalents")!.pct,
      details: {
        sourceUrl: SOURCE_URL,
        compositionEvidence: "issuer-reported-portfolio",
        portfolioAsOf: portfolio.asOfDate,
        sourceClockPolicy: "date-only-utc-start",
        ...freshness,
        portfolioScope: "Complete issuer-published USDY portfolio categories; no all-USDY liability reconciliation or financial assurance",
      },
    },
  };
}

export async function fetchOndoUsdyReserves(
  coin: ReserveAdapterCoin,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  return adaptOndoUsdyPortfolio(
    await fetchTextWithRetry(SOURCE_URL, signal, 12_000, ctx, { maxResponseBytes: MAX_SOURCE_BYTES }),
    coin,
    ctx?.nowSec ?? Math.floor(Date.now() / 1000),
    config.scoring?.maxSourceAgeSec,
  );
}
