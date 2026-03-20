import type { LiveReservesConfig, StablecoinMeta } from "@shared/types";
import type { AdapterContext, AdapterResult } from "./index";
import { fetchTextWithRetry, getAdapterTimeout, requireHtmlInput } from "./helpers";

type SgForgeCoinType = "eur" | "usd";

function normalizeLocalizedNumber(raw: string): number {
  const compact = raw.replace(/\s+/g, "").trim();
  const normalized = compact.includes(",")
    ? compact.replace(/\./g, "").replace(",", ".")
    : compact;
  const value = Number.parseFloat(normalized);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`sgforge-coinvertible: could not parse localized number "${raw}"`);
  }
  return value;
}

function readCoinType(config: LiveReservesConfig): SgForgeCoinType {
  const params = config.params as Record<string, unknown> | undefined;
  const coinType = params?.coinType;
  if (coinType === "eur" || coinType === "usd") {
    return coinType;
  }
  return "eur";
}

function getHeadingNeedle(coinType: SgForgeCoinType): string {
  return coinType === "eur" ? "EUR CoinVertible in circulation" : "USD CoinVertible in circulation";
}

function extractDisclosureBlock(html: string, coinType: SgForgeCoinType): string {
  const headingNeedle = getHeadingNeedle(coinType);
  const start = html.indexOf(headingNeedle);
  if (start === -1) {
    throw new Error(`sgforge-coinvertible: missing ${coinType.toUpperCase()} CoinVertible disclosure block`);
  }

  const nextBlockStart = html.indexOf('class="coinvertible_eur_usd"', start + headingNeedle.length);
  return html.slice(start, nextBlockStart === -1 ? undefined : nextBlockStart);
}

export function adaptSgForgeCoinvertible(html: string, coinType: SgForgeCoinType): AdapterResult {
  const disclosureBlock = extractDisclosureBlock(html, coinType);
  const numberMatch = disclosureBlock.match(
    /class="coinvertible_number">\s*([^<]+?)\s*<span[^>]*>Last update\s*([^<]+)</i,
  );
  const bankMatch = disclosureBlock.match(/class="bank">\s*([^:]+?)\s*:\s*([\d.]+)%/i);
  const cashMatch = disclosureBlock.match(
    /class="coinvertible_cash"[\s\S]*?<div class="number">\s*([^<€$]+?)\s*[€$]/i,
  );

  if (!numberMatch || !bankMatch || !cashMatch) {
    throw new Error("sgforge-coinvertible: incomplete reserve-bank metadata");
  }

  const circulationAmount = normalizeLocalizedNumber(numberMatch[1]);
  const lastUpdate = numberMatch[2]?.trim();
  const bankName = bankMatch[1]?.replace(/\s+/g, " ").trim();
  const bankPct = Number.parseFloat(bankMatch[2] ?? "");
  const cashAmount = normalizeLocalizedNumber(cashMatch[1]);

  if (!bankName || !Number.isFinite(bankPct) || bankPct <= 0) {
    throw new Error("sgforge-coinvertible: incomplete reserve-bank metadata");
  }

  return {
    slices: [
      {
        name: `${coinType === "eur" ? "Euro" : "U.S. dollar"} cash deposits at ${bankName}`,
        pct: 100,
        risk: "very-low",
      },
    ],
    metadata: {
      coinType,
      circulationAmount,
      cashAmount,
      bankName,
      bankPct,
      ...(lastUpdate ? { lastUpdate } : {}),
    },
  };
}

export async function fetchSgForgeCoinvertibleReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  _ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireHtmlInput(config.inputs.primary, "sgforge-coinvertible");
  const html = await fetchTextWithRetry(
    input.url,
    signal,
    getAdapterTimeout(config, 15_000),
  );
  return adaptSgForgeCoinvertible(html, readCoinType(config));
}
