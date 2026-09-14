import { z } from "zod";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import type { AdapterContext, AdapterResult } from "./types";
import { fetchChainlinkNavCore } from "./chainlink-nav-core";
import { fetchTextWithRetry, verifiedFreshnessMetadata } from "./helpers";
import { extractEscapedJsonValueAfterKey } from "./html";
import { MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC } from "./validate";

const ONDO_OUSG_PORTFOLIO_URL = "https://ondo.finance/ousg";
const PORTFOLIO_SCOPE = "Current Value excludes OUSG limited partnership interests represented in book-entry (non-tokenized) form.";
const PORTFOLIO_KEY = '\\"portfolio\\":';
const PortfolioSchema = z.object({
  asOfDate: z.string().datetime(),
  total: z.number().finite().positive(),
  positions: z.array(z.object({
    _id: z.string(),
    _type: z.literal("ousgPortfolioHolding"),
    name: z.string(),
    symbol: z.string(),
    value: z.number().finite().nonnegative(),
  })).length(7),
});

// IDs are issuer document identities, not presentation order. New holdings need
// an explicit review; never normalize an unrecognized or incomplete portfolio.
const HOLDINGS: Record<string, { name: string; symbol: string; risk: ReserveSlice["risk"]; coinId?: string }> = {
  "592c34b5-6d5d-43f9-a4b8-787ab0b88bce": { name: "State Street Galaxy Onchain Liquidity Sweep Fund", symbol: "SWEEP", risk: "low" },
  "07110012-2936-43db-a82c-b486e74e3822": { name: "BlackRock USD Institutional Digital Liquidity Fund", symbol: "BUIDL", risk: "low", coinId: "buidl-blackrock" },
  "012efdd9-0b06-48e7-96d6-4a7f2a588850": { name: "Franklin OnChain U.S. Government Money Fund", symbol: "BENJI", risk: "low", coinId: "benji-franklin-templeton" },
  "6e7b5396-27eb-488c-9f9f-9c7b833b0d82": { name: "Fidelity Treasury Digital Fund", symbol: "FYOXX", risk: "low" },
  "545bffa5-2de4-4080-a879-1ad11ebfb040": { name: "Coinbase - Cash Equivalents", symbol: "USDC", risk: "low", coinId: "usdc-circle" },
  "71e93ded-53e3-4125-a317-2ce6cc55df36": { name: "Other Assets ⁴", symbol: "USD", risk: "high" },
  "04bcda43-af66-497e-8064-efe82ca3cb71": { name: "Silicon Valley Bank - Bank Deposits", symbol: "USD", risk: "medium" },
};
const OTHER_ASSETS_ID = "71e93ded-53e3-4125-a317-2ce6cc55df36";

export function adaptOndoOusgPortfolio(
  html: string,
  nowSec: number,
  maxAgeSec = 4 * DAY_SECONDS,
): AdapterResult {
  // Bound both parser work and ambiguity; the current full page is about 750 KB.
  if (html.length > 2_000_000 || html.split(PORTFOLIO_KEY).length !== 2 || !html.includes(PORTFOLIO_SCOPE)) {
    throw new Error("ondo-ousg: missing, ambiguous or oversized portfolio source");
  }
  const portfolio = PortfolioSchema.parse(JSON.parse(
    extractEscapedJsonValueAfterKey(html, PORTFOLIO_KEY, "ondo-ousg"),
  ));
  const sourceTimestamp = Date.parse(portfolio.asOfDate) / 1000;
  if (sourceTimestamp > nowSec + MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC || nowSec - sourceTimestamp > maxAgeSec) {
    throw new Error("ondo-ousg: portfolio date is stale or in the future");
  }
  const ids = new Set<string>();
  for (const row of portfolio.positions) {
    const holding = HOLDINGS[row._id];
    if (!holding || ids.has(row._id) || row.name !== holding.name || row.symbol !== holding.symbol) {
      throw new Error("ondo-ousg: duplicate or unreviewed holding identity");
    }
    ids.add(row._id);
  }
  const sum = portfolio.positions.reduce((total, row) => total + row.value, 0);
  // Amounts are in dollars and cents; allow only aggregate cent rounding.
  if (!Number.isFinite(sum) || Math.abs(sum - portfolio.total) > 0.01) {
    throw new Error("ondo-ousg: portfolio amounts do not reconcile to total");
  }
  const otherAssetsUsd = portfolio.positions.find((row) => row._id === OTHER_ASSETS_ID)!.value;
  return {
    slices: portfolio.positions.filter((row) => row.value > 0).map((row) => {
      const holding = HOLDINGS[row._id]!;
      return {
        sourceKey: `ondo-ousg:position:${row._id}`,
        name: holding.name,
        pct: row.value / portfolio.total * 100,
        risk: holding.risk,
        ...(holding.coinId ? { coinId: holding.coinId, depType: "collateral" as const } : {}),
      };
    }),
    metadata: {
      ...verifiedFreshnessMetadata(sourceTimestamp),
      totalReserveUsd: portfolio.total,
      unknownExposurePct: otherAssetsUsd / portfolio.total * 100,
      details: {
        sourceUrl: ONDO_OUSG_PORTFOLIO_URL,
        compositionEvidence: "issuer-reported-portfolio",
        portfolioScope: "OUSG tokenized interests; excludes book-entry non-tokenized interests",
        portfolioAsOf: portfolio.asOfDate,
        positionCount: portfolio.positions.length,
        otherAssetsUsd,
        otherAssetsDescription: "Funds in transit, outstanding receivables less payables; underlying allocation unresolved",
      },
    },
  };
}

export async function fetchOndoOusgReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  // Consume/validate the HTML before the NAV core's existing onchain fan-out.
  const portfolio = adaptOndoOusgPortfolio(
    await fetchTextWithRetry(ONDO_OUSG_PORTFOLIO_URL, signal, 12_000, ctx),
    ctx?.nowSec ?? Math.floor(Date.now() / 1000),
    config.scoring?.maxSourceAgeSec,
  );
  const nav = await fetchChainlinkNavCore(coin, config, signal, ctx);
  return {
    ...portfolio,
    warnings: nav.warnings?.filter((warning) => warning.code !== "nav-portfolio-composition-unverified"),
    metadata: {
      ...nav.metadata,
      ...portfolio.metadata,
      details: { ...nav.metadata?.details, ...portfolio.metadata?.details },
    },
  };
}
