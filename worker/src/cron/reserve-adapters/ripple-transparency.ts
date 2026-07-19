import type { StablecoinMeta } from "@shared/types/core";
import type { ReserveSlice } from "@shared/types/reserves";
import type { LiveReservesConfig, LiveReserveWarning } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchPrimaryHtmlInput,
  htmlLayoutChangedError,
  reserveDegradedWarning,
  verifiedFreshnessMetadata,
} from "./helpers";

const ADAPTER_KEY = "ripple-transparency";
const MIN_RESERVE_RATIO = 0.995;

/**
 * Asset-class split of the RLUSD reserve. Percentages are reserve shares and
 * must total 100 within the reserve-composition tolerance.
 */
interface ReserveBreakdown {
  treasuryBillsPct: number;
  governmentMoneyMarketFundsPct: number;
  cashPct: number;
}

/**
 * Attested fallback split, used only when the live transparency payload carries
 * no asset-class breakdown. Source: Deloitte-examined RLUSD Reserve Report as
 * of 2026-05-29 (RLUSD_Attestation_Report_-_May_2026_Final.pdf, examined
 * 2026-06-25): U.S. Treasury bills 65.41%, government money-market funds
 * 19.44%, cash and deposit accounts 15.15%.
 */
const ATTESTED_BREAKDOWN_2026_05: ReserveBreakdown = {
  treasuryBillsPct: 65.41,
  governmentMoneyMarketFundsPct: 19.44,
  cashPct: 15.15,
};

const BREAKDOWN_TOTAL_TOLERANCE_PCT = 0.5;

function parseUsdAmount(raw: string): number | null {
  const match = raw.match(/\$\s*([\d,.]+)\s*([KMB])?/i);
  if (!match) return null;
  const base = Number.parseFloat(match[1].replace(/,/g, ""));
  if (!Number.isFinite(base)) return null;
  const suffix = match[2]?.toUpperCase();
  const multiplier = suffix === "B" ? 1_000_000_000 : suffix === "M" ? 1_000_000 : suffix === "K" ? 1_000 : 1;
  return base * multiplier;
}

function parseMmDdYyyy(raw: string | undefined): number | null {
  const match = raw?.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  const month = Number.parseInt(match[1], 10);
  const day = Number.parseInt(match[2], 10);
  const year = Number.parseInt(match[3], 10);
  const timestampMs = Date.UTC(year, month - 1, day);
  const date = new Date(timestampMs);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return Math.floor(timestampMs / 1000);
}

/** Reads an explicit percentage within a short window after a class label. */
function parseLabeledPct(normalized: string, label: RegExp): number | null {
  const match = normalized.match(label);
  if (!match || match.index === undefined) return null;
  const window = normalized.slice(match.index, match.index + 300);
  const pctMatch = window.match(/\d{1,3}\.\d{1,6}\s{0,3}%/) ?? window.match(/\d{1,3}\s{0,3}%/);
  if (!pctMatch) return null;
  const pct = Number.parseFloat(pctMatch[0]);
  return Number.isFinite(pct) && pct >= 0 && pct <= 100 ? pct : null;
}

/**
 * Derives the asset-class split from the transparency payload when it carries
 * an explicit breakdown (labeled percentages for all three NYDFS reserve
 * classes summing to 100%). Returns null when the payload has no usable
 * breakdown so the caller falls back to the attested static split.
 */
export function parseRippleReserveBreakdown(normalized: string): ReserveBreakdown | null {
  const treasuryBillsPct = parseLabeledPct(normalized, /U\.?S\.?\s+Treasury\s+bills?|T-bills/i);
  const governmentMoneyMarketFundsPct = parseLabeledPct(normalized, /[Gg]overnment\s+money[- ]market\s+funds?/);
  const cashPct = parseLabeledPct(normalized, /[Cc]ash|[Dd]eposit\s+accounts/);
  if (treasuryBillsPct === null || governmentMoneyMarketFundsPct === null || cashPct === null) return null;
  const total = treasuryBillsPct + governmentMoneyMarketFundsPct + cashPct;
  if (Math.abs(total - 100) > BREAKDOWN_TOTAL_TOLERANCE_PCT) return null;
  return { treasuryBillsPct, governmentMoneyMarketFundsPct, cashPct };
}

function buildReserveSlices(breakdown: ReserveBreakdown): ReserveSlice[] {
  const slices: ReserveSlice[] = [
    {
      name: "U.S. Treasury bills",
      pct: breakdown.treasuryBillsPct,
      risk: "very-low",
      assetClass: "treasury-bill",
      issuerOrObligor: "United States Treasury",
      riskFactors: ["duration", "liquidity", "custody"],
      liquidityHorizon: "one-day",
      // NYDFS reserve criteria limit T-bills to three months or less from
      // maturity; the reviewed classification carries the same 92-day bound.
      maturityDaysMax: 92,
    },
    {
      name: "Government money-market funds",
      pct: breakdown.governmentMoneyMarketFundsPct,
      risk: "very-low",
      assetClass: "money-market-fund",
      issuerOrObligor: "DFS-approved government money-market funds",
      riskFactors: ["counterparty", "liquidity", "custody"],
      liquidityHorizon: "one-day",
    },
    {
      name: "Cash and deposit accounts",
      pct: breakdown.cashPct,
      risk: "very-low",
      assetClass: "bank-deposit",
      issuerOrObligor: "DFS-approved depository institutions",
      riskFactors: ["counterparty", "custody", "concentration"],
      liquidityHorizon: "immediate",
    },
  ];
  return slices.filter((slice) => slice.pct > 0);
}

export function adaptRippleTransparency(html: string): AdapterResult {
  const normalized = html.replace(/<!--[\s\S]*?-->/g, " ");
  const balanceStart = normalized.indexOf("Total Circulating RLUSD");
  if (balanceStart < 0) {
    throw htmlLayoutChangedError(ADAPTER_KEY, "missing RLUSD balance block");
  }
  const balanceBlock = normalized.slice(balanceStart, balanceStart + 1_500);
  const circulatingMatch = balanceBlock.match(/Total Circulating RLUSD[\s\S]{0,300}?(\$\s*[\d,.]+\s*[KMB]?)/i);
  const reservesMatch = balanceBlock.match(/RLUSD Reserve Funds[\s\S]{0,300}?(\$\s*[\d,.]+\s*[KMB]?)/i);
  const dateMatch = balanceBlock.match(/\bAs of\s*(\d{1,2}\/\d{1,2}\/\d{4})\b/i);

  const circulatingUsd = parseUsdAmount(circulatingMatch?.[1] ?? "");
  const reservesUsd = parseUsdAmount(reservesMatch?.[1] ?? "");
  const sourceTimestamp = parseMmDdYyyy(dateMatch?.[1]);
  if (circulatingUsd == null || reservesUsd == null || sourceTimestamp == null) {
    throw htmlLayoutChangedError(ADAPTER_KEY, "missing circulating supply, reserve funds, or source date");
  }

  const collateralizationRatio = reservesUsd / circulatingUsd;
  const warnings: LiveReserveWarning[] = [];
  if (collateralizationRatio < MIN_RESERVE_RATIO) {
    warnings.push(reserveDegradedWarning(
      "reserve-undercollateralized",
      `Ripple RLUSD reserves cover ${(collateralizationRatio * 100).toFixed(2)}% of circulating supply`,
    ));
  }

  return {
    slices: buildReserveSlices(parseRippleReserveBreakdown(normalized) ?? ATTESTED_BREAKDOWN_2026_05),
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      circulatingUsd,
      reservesUsd,
      collateralizationRatio,
      ...verifiedFreshnessMetadata(sourceTimestamp),
    },
  };
}

export async function fetchRippleTransparencyReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const html = await fetchPrimaryHtmlInput(config, ADAPTER_KEY, signal, ctx);
  return adaptRippleTransparency(html);
}
