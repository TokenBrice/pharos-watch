import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchPrimaryHtmlInput,
  htmlLayoutChangedError,
  htmlParseError,
  parseTimestampLikeToUnixSeconds,
  reserveDegradedWarning,
  stripTags,
  unverifiedFreshnessMetadata,
  verifiedFreshnessMetadata,
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
  const bankMatch = disclosureBlock.match(/class="bank">\s*([^:]+?)\s*:\s*([\d.]+)%/i);
  const cashMatch = disclosureBlock.match(
    /class="coinvertible_cash"[\s\S]*?<div class="number">\s*([^<€$]+?)\s*[€$]/i,
  );

  if (!numberAndLastUpdate || !numberAndLastUpdate.lastUpdate || !bankMatch || !cashMatch) {
    throw htmlLayoutChangedError("sgforge-coinvertible", "incomplete reserve-bank metadata");
  }

  const circulationAmount = normalizeLocalizedNumber(numberAndLastUpdate.amount);
  const lastUpdate = numberAndLastUpdate.lastUpdate;
  const bankName = bankMatch[1]?.replace(/\s+/g, " ").trim();
  const bankPct = Number.parseFloat(bankMatch[2] ?? "");
  const cashAmount = normalizeLocalizedNumber(cashMatch[1]);
  const sourceTimestamp = parseSgForgeLastUpdate(
    lastUpdate,
    options.nowSec ?? Math.floor(Date.now() / 1000),
  );
  const collateralizationRatio = cashAmount / circulationAmount;

  if (!bankName || !Number.isFinite(bankPct) || bankPct <= 0) {
    throw htmlLayoutChangedError("sgforge-coinvertible", "incomplete reserve-bank metadata");
  }
  if (bankPct > 100) {
    throw htmlLayoutChangedError("sgforge-coinvertible", "reserve-bank percentage is outside expected range");
  }
  if (!Number.isFinite(collateralizationRatio) || collateralizationRatio <= 0) {
    throw htmlParseError("sgforge-coinvertible", "could not compute reserve collateralization ratio");
  }

  const warnings = collateralizationRatio < 0.995
    ? [reserveDegradedWarning(
        "reserve-undercollateralized",
        `SG Forge CoinVertible cash amount covers ${(collateralizationRatio * 100).toFixed(2)}% of circulation`,
      )]
    : [];

  return {
    slices: [
      {
        name: `${coinType === "eur" ? "Euro" : "U.S. dollar"} cash deposits at ${bankName}`,
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
      bankName,
      bankPct,
      ...(lastUpdate ? { lastUpdate } : {}),
      ...(sourceTimestamp != null
        ? verifiedFreshnessMetadata(sourceTimestamp)
        : unverifiedFreshnessMetadata(
            "html-disclosure",
            "SG Forge CoinVertible page did not expose a parseable 'Last update' timestamp",
          )),
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
