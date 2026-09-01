import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { AdapterContext, AdapterResult } from "./types";
import {
  buildCoverageShortfallWarnings,
  fetchPrimaryHtmlInput,
  freshnessMetadataFromTimestamp,
  htmlLayoutChangedError,
  htmlParseError,
  parseTimestampLikeToUnixSeconds,
  stripTags,
} from "./helpers";
import { buildDocumentedRedemptionTelemetry } from "./redemption";

type SgForgeCoinType = "eur" | "usd";

const SG_FORGE_FUTURE_TOLERANCE_SEC = 10 * 60;

interface SgForgeAdaptOptions {
  nowSec?: number;
}

function normalizeLocalizedNumber(raw: string): number {
  const compact = raw.replace(/\s+/g, "").trim();
  const normalized = compact.includes(",")
    ? compact.replace(/\./g, "").replace(",", ".")
    : compact;
  const value = Number.parseFloat(normalized);
  if (!Number.isFinite(value) || value <= 0) {
    throw htmlParseError("sgforge-coinvertible", `could not parse localized number "${raw}"`);
  }
  return value;
}

function readCoinType(config: LiveReservesConfig): SgForgeCoinType {
  const coinType = parseLiveReserveAdapterParams("sgforge-coinvertible", config.params).coinType;
  if (coinType === "eur" || coinType === "usd") {
    return coinType;
  }
  return "eur";
}

function getHeadingNeedle(coinType: SgForgeCoinType): string {
  return coinType === "eur" ? "EUR CoinVertible in circulation" : "USD CoinVertible in circulation";
}

function buildSlashDateUtc(day: number, month: number, year: number): number | null {
  if (!Number.isInteger(day) || !Number.isInteger(month) || !Number.isInteger(year)) return null;
  if (day < 1 || month < 1 || month > 12) return null;

  const fullYear = year < 100 ? 2000 + year : year;
  const parsed = Date.UTC(fullYear, month - 1, day);
  const date = new Date(parsed);
  if (
    date.getUTCFullYear() !== fullYear
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return null;
  }

  return Math.floor(parsed / 1000);
}

function parseSgForgeLastUpdate(value: string | null | undefined, nowSec: number): number | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  const slashDateMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!slashDateMatch) {
    return parseTimestampLikeToUnixSeconds(trimmed);
  }

  const first = Number(slashDateMatch[1]);
  const second = Number(slashDateMatch[2]);
  const year = Number(slashDateMatch[3]);
  const european = buildSlashDateUtc(first, second, year);
  const us = buildSlashDateUtc(second, first, year);

  if (european != null && european - nowSec <= SG_FORGE_FUTURE_TOLERANCE_SEC) {
    return european;
  }
  if (us != null && us - nowSec <= SG_FORGE_FUTURE_TOLERANCE_SEC) {
    return us;
  }

  return european ?? us;
}

function extractDisclosureBlock(html: string, coinType: SgForgeCoinType): string {
  const headingNeedle = getHeadingNeedle(coinType);
  const start = html.indexOf(headingNeedle);
  if (start === -1) {
    throw htmlLayoutChangedError(
      "sgforge-coinvertible",
      `missing ${coinType.toUpperCase()} CoinVertible disclosure block`,
    );
  }

  const nextBlockStart = html.indexOf('class="coinvertible_eur_usd"', start + headingNeedle.length);
  return html.slice(start, nextBlockStart === -1 ? undefined : nextBlockStart);
}

function extractNumberAndLastUpdate(disclosureBlock: string): { amount: string; lastUpdate: string | null } | null {
  const classNeedle = 'class="coinvertible_number"';
  const classIndex = disclosureBlock.indexOf(classNeedle);
  if (classIndex === -1) return null;

  const openTagEnd = disclosureBlock.indexOf(">", classIndex + classNeedle.length);
  if (openTagEnd === -1) return null;

  const closeTagStart = disclosureBlock.indexOf("</div>", openTagEnd + 1);
  if (closeTagStart === -1) return null;

  const blockHtml = disclosureBlock.slice(openTagEnd + 1, closeTagStart);
  const spanStart = blockHtml.indexOf("<span");
  if (spanStart === -1) return null;

  const amount = stripTags(blockHtml.slice(0, spanStart)).replace(/\s+/g, " ").trim();
  const lastUpdateText = stripTags(blockHtml.slice(spanStart)).replace(/\s+/g, " ").trim();
  const lastUpdateMatch = lastUpdateText.match(/^Last update\s+(.+)$/i);
  return {
    amount,
    lastUpdate: lastUpdateMatch?.[1]?.trim() ?? null,
  };
}

export function adaptSgForgeCoinvertible(
  html: string,
  coinType: SgForgeCoinType,
  options: SgForgeAdaptOptions = {},
): AdapterResult {
  const disclosureBlock = extractDisclosureBlock(html, coinType);
  const numberAndLastUpdate = extractNumberAndLastUpdate(disclosureBlock);
  const bankBlocks = [...disclosureBlock.matchAll(/class="bank">\s*([\s\S]*?)<\/div>/gi)];
  const bankRows = bankBlocks.flatMap((bankBlock) => {
    const bankText = stripTags(bankBlock[1] ?? "").replace(/\s+/g, " ").trim();
    return [...bankText.matchAll(/(?:^|\|)\s*([^:|]+?)\s*:\s*([\d.,]+)%/g)].map((match) => ({
      bankName: match[1]?.replace(/\s+/g, " ").trim() ?? "",
      bankPct: Number.parseFloat((match[2] ?? "").replace(",", ".")),
    }));
  });
  const cashBlockStart = disclosureBlock.search(/class="coinvertible_cash"/i);
  const cashRows = cashBlockStart === -1
    ? []
    : [...disclosureBlock.slice(cashBlockStart).matchAll(
      /class="number">\s*([^<€$]+?)\s*[€$]/gi,
    )];

  if (
    !numberAndLastUpdate
    || !numberAndLastUpdate.lastUpdate
    || bankRows.length === 0
    || bankRows.length !== cashRows.length
  ) {
    throw htmlLayoutChangedError("sgforge-coinvertible", "incomplete reserve-bank metadata");
  }

  const circulationAmount = normalizeLocalizedNumber(numberAndLastUpdate.amount);
  const lastUpdate = numberAndLastUpdate.lastUpdate;
  const bankBreakdown = bankRows.map((bank, index) => ({
    ...bank,
    cashAmount: normalizeLocalizedNumber(cashRows[index]?.[1] ?? ""),
  }));
  const bankPctTotal = bankBreakdown.reduce((sum, bank) => sum + bank.bankPct, 0);
  const cashAmount = bankBreakdown.reduce((sum, bank) => sum + bank.cashAmount, 0);
  const sourceTimestamp = parseSgForgeLastUpdate(
    lastUpdate,
    options.nowSec ?? Math.floor(Date.now() / 1000),
  );
  const collateralizationRatio = cashAmount / circulationAmount;

  if (bankBreakdown.some((bank) => !bank.bankName || !Number.isFinite(bank.bankPct) || bank.bankPct <= 0)) {
    throw htmlLayoutChangedError("sgforge-coinvertible", "incomplete reserve-bank metadata");
  }
  if (
    bankBreakdown.some((bank) => bank.bankPct > 100)
    || !Number.isFinite(bankPctTotal)
    || Math.abs(bankPctTotal - 100) > 0.1
  ) {
    throw htmlLayoutChangedError("sgforge-coinvertible", "reserve-bank percentage is outside expected range");
  }
  if (!Number.isFinite(collateralizationRatio) || collateralizationRatio <= 0) {
    throw htmlParseError("sgforge-coinvertible", "could not compute reserve collateralization ratio");
  }

  const warnings = buildCoverageShortfallWarnings({
    code: "reserve-undercollateralized",
    message: (pct) => `SG Forge CoinVertible cash amount covers ${pct}% of circulation`,
    coverageRatio: collateralizationRatio,
  });

  return {
    slices: [
      {
        name: `${coinType === "eur" ? "Euro" : "U.S. dollar"} cash deposits at ${bankBreakdown.map((bank) => bank.bankName).join(" and ")}`,
        pct: 100,
        risk: "very-low",
      },
    ],
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      coinType,
      circulationAmount,
      cashAmount,
      collateralizationRatio,
      cashCoveragePct: collateralizationRatio * 100,
      details: {
        bankBreakdown,
      },
      ...(lastUpdate ? { lastUpdate } : {}),
      ...freshnessMetadataFromTimestamp(
        sourceTimestamp,
        "html-disclosure",
        "SG Forge CoinVertible page did not expose a parseable 'Last update' timestamp",
      ),
      redemption: buildDocumentedRedemptionTelemetry(sourceTimestamp, { holderEligibility: "verified-customer" }),
    },
  };
}

export async function fetchSgForgeCoinvertibleReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const html = await fetchPrimaryHtmlInput(config, "sgforge-coinvertible", signal, ctx);
  return adaptSgForgeCoinvertible(
    html,
    readCoinType(config),
    ctx?.nowSec != null ? { nowSec: ctx.nowSec } : undefined,
  );
}
