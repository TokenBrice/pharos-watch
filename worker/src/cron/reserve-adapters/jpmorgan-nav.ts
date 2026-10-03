import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { BUSINESS_DAY_NAV_SOURCE_MAX_AGE_SEC } from "@shared/types/live-reserve-adapter-policy";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { fetchTextWithRetry, requireHtmlInput, verifiedFreshnessMetadata } from "./helpers";
import type { AdapterContext, AdapterResult } from "./types";

export const JPMORGAN_JLTXX_PUBLISHER_URL = "https://am.jpmorgan.com/FundsMarketingHandler/slim/product.md?cusip=46655r119&country=us&role=adv&language=en";
export const JPMORGAN_JLTXX_SOURCE_KEY = "jpmorgan-nav:class:4397";

function field(body: string, label: string): string {
  const prefix = `- **${label}**: `;
  const matches = body.split("\n").filter((line) => line.startsWith(prefix)).map((line) => line.slice(prefix.length).trim());
  if (matches.length === 0 || matches.some((value) => value !== matches[0])) {
    throw new Error(`jpmorgan-nav missing or conflicting ${label}`);
  }
  return matches[0];
}

function datedField(body: string, label: string): { value: string; timestamp: number; date: string } {
  const prefix = `- **${label} As of `;
  const lines = body.split("\n").filter((line) => line.startsWith(prefix));
  if (lines.length !== 1) throw new Error(`jpmorgan-nav missing or duplicate ${label}`);
  const match = /^(\d{2})\/(\d{2})\/(\d{4})\*\*: (.+)$/.exec(lines[0].slice(prefix.length));
  if (!match) throw new Error(`jpmorgan-nav invalid ${label} date or schema`);
  const date = `${match[3]}-${match[1]}-${match[2]}`;
  // The publisher gives a dealing date, not a timestamp. UTC start-of-day is
  // conservative and never invents a later intraday evidence clock.
  const timestamp = Date.parse(`${date}T00:00:00Z`) / 1000;
  if (!Number.isFinite(timestamp) || new Date(timestamp * 1000).toISOString().slice(0, 10) !== date) {
    throw new Error(`jpmorgan-nav invalid ${label} calendar date`);
  }
  return { value: match[4], timestamp, date };
}

export function parseJpmorganNav(body: string, nowSec: number): AdapterResult {
  if (field(body, "CUSIP") !== "46655R119" || field(body, "Ticker") !== "JLTXX" || field(body, "Share Class Number") !== "4397" ||
      field(body, "Fund Name") !== "JPMorgan OnChain Liquidity-Token Money Market Fund" ||
      field(body, "Share Class Name") !== "JPMorgan OnChain Liquidity-Token Money Market Fund-Token Class") {
    throw new Error("jpmorgan-nav class identity mismatch");
  }
  const nav = datedField(body, "Transaction NAV");
  const assets = datedField(body, "Share Class Assets");
  if (nav.date !== assets.date) throw new Error("jpmorgan-nav incoherent NAV and class-assets dates");
  if (!Number.isFinite(nowSec) || nav.timestamp > nowSec || nowSec - nav.timestamp > BUSINESS_DAY_NAV_SOURCE_MAX_AGE_SEC) {
    throw new Error("jpmorgan-nav stale or future dealing date");
  }
  const navMatch = /^\$(\d+|\d+\.\d+)$/.exec(nav.value);
  const assetsMatch = /^\$(\d+|\d+\.\d+)(mn|bn)$/.exec(assets.value);
  const navPerToken = navMatch ? Number(navMatch[1]) : NaN;
  const classAssetsUsd = assetsMatch ? Number(assetsMatch[1]) * (assetsMatch[2] === "mn" ? 1e6 : 1e9) : NaN;
  if (!Number.isFinite(navPerToken) || navPerToken <= 0 || !Number.isFinite(classAssetsUsd) || classAssetsUsd <= 0) {
    throw new Error("jpmorgan-nav invalid NAV or class-assets value/unit");
  }
  return {
    slices: [{ sourceKey: JPMORGAN_JLTXX_SOURCE_KEY, name: "JPMorgan JLTXX government money-market fund shares", pct: 100, risk: "low" }],
    metadata: {
      navPerToken,
      ...verifiedFreshnessMetadata(nav.timestamp),
      details: {
        cusip: "46655R119", shareClassNumber: "4397", ticker: "JLTXX",
        dealingDate: nav.date, timestampBasis: "UTC start of issuer dealing date; no intraday timestamp published",
        classAssetsUsd, classAssetsRole: "issuer-reported diagnostic, not circulating supply",
        sourceUrl: JPMORGAN_JLTXX_PUBLISHER_URL,
      },
    },
  };
}
export async function fetchJpmorganNavReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  parseLiveReserveAdapterParams("jpmorgan-nav", config.params);
  const input = requireHtmlInput(config.inputs.primary, "jpmorgan-nav");
  if (coin.id !== "jltxx-jpmorgan" || coin.symbol !== "JLTXX" || input.url !== JPMORGAN_JLTXX_PUBLISHER_URL) {
    throw new Error("jpmorgan-nav coin or publisher identity mismatch");
  }
  const body = await fetchTextWithRetry(input.url, signal, 10_000, ctx, { headers: { Accept: "text/markdown" }, maxResponseBytes: 128 * 1024 });
  return parseJpmorganNav(body, ctx?.nowSec ?? Math.floor(Date.now() / 1000));
}
