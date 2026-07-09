import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import {
  adaptMentoCdpComposition,
  adaptMentoReserveComposition,
  extractMentoDashboardTimestamp,
  fetchMentoReserves,
  parseMentoCdpComposition,
  parseMentoReserveComposition,
} from "../mento";
import { getReserveAdapter } from "../index";
import { validateAdapterOutput } from "../validate";
import { buildBrowserHeaders, NEUTRAL_ADAPTER_HEADERS } from "../request";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const CURRENT_DASHBOARD_HTML = readFileSync(join(FIXTURES_DIR, "mento-reserve-composition.html"), "utf8");

const MENTO_RESERVE_URL = "https://example.com/mento/reserve";
const MENTO_DASHBOARD_URL = "https://reserve.mento.org/";
// Mirrors the adapter's browser-style headers, embedded in the shared JSON/text request cache key.
const MENTO_BROWSER_HEADERS = buildBrowserHeaders("https://reserve.mento.org", "https://reserve.mento.org/");
const mentoReserveBrowserCacheKey = `json-get:${MENTO_RESERVE_URL}:12000:${JSON.stringify(MENTO_BROWSER_HEADERS)}`;
const mentoReserveNeutralCacheKey = `json-get:${MENTO_RESERVE_URL}:12000:${JSON.stringify(NEUTRAL_ADAPTER_HEADERS)}`;
const mentoDashboardBrowserCacheKey = `text-get:${MENTO_DASHBOARD_URL}:12000:${JSON.stringify(MENTO_BROWSER_HEADERS)}`;
const mentoDashboardNeutralCacheKey = `text-get:${MENTO_DASHBOARD_URL}:12000:${JSON.stringify(NEUTRAL_ADAPTER_HEADERS)}`;
const MENTO_DASHBOARD_HTML_FIXTURE = String.raw`troves\":[{}],\"timestamp\":\"2026-05-11T23:21:16.007Z\"},\"dataUpdateCount\":1`;

function makeMentoConfig(): LiveReservesConfig {
  return {
    adapter: "mento",
    version: 2,
    semantics: "protocol-reserve",
    display: {
      url: MENTO_DASHBOARD_URL,
      label: "Mento Reserves",
    },
    inputs: {
      primary: {
        kind: "http-json",
        url: MENTO_RESERVE_URL,
      },
    },
  };
}

const SAMPLE_PAYLOAD = {
  collateral: {
    assets: [
      { symbol: "sUSDS", percentage: 50 },
      { symbol: "EURC", percentage: 10 },
      { symbol: "axlEUROC", percentage: 5 },
      { symbol: "CELO", percentage: 15 },
      { symbol: "USDGLO", percentage: 5 },
      { symbol: "stETH", percentage: 3 },
      { symbol: "USDT", percentage: 3 },
      { symbol: "USDT0", percentage: 1 },
      { symbol: "USDC", percentage: 2 },
      { symbol: "axlUSDC", percentage: 1 },
      { symbol: "AUSD", percentage: 4 },
      { symbol: "WETH", percentage: 1 },
    ],
  },
  cdp_troves: {
    troves: [
      {
        stablecoin: "GBPm",
        collateral_token: "USDm",
        collateral_usd: 173_427.5,
        debt_usd: 82_821.25,
        ratio: 2.09,
        status: "active",
      },
      {
        stablecoin: "GBPm",
        collateral_token: "USDm",
        collateral_usd: 40_000,
        debt_usd: 20_000,
        ratio: 2,
        status: "active",
      },
      {
        stablecoin: "JPYm",
        collateral_token: "USDm",
        collateral_usd: 171_960.48,
        debt_usd: 105_336.2,
        ratio: 1.63,
        status: "active",
      },
      {
        stablecoin: "CHFm",
        collateral_token: "USDm",
        collateral_usd: 143_361.85,
        debt_usd: 90_307.02,
        ratio: 1.59,
        status: "active",
      },
      {
        stablecoin: "XOFm",
        collateral_token: "USDm",
        collateral_usd: 25_000,
        debt_usd: 12_500,
        ratio: 2,
        status: "active",
      },
      {
        stablecoin: "GBPm",
        collateral_token: "USDm",
        collateral_usd: 1_000,
        debt_usd: 500,
        ratio: 2,
        status: "closed",
      },
    ],
  },
};

describe("mento adapter", () => {
  it("parses reserve entries from the analytics API payload", () => {
    const entries = parseMentoReserveComposition(SAMPLE_PAYLOAD);
    expect(entries).toEqual([
      { symbol: "sUSDS", percent: 50 },
      { symbol: "EURC", percent: 10 },
      { symbol: "axlEUROC", percent: 5 },
      { symbol: "CELO", percent: 15 },
      { symbol: "USDGLO", percent: 5 },
      { symbol: "stETH", percent: 3 },
      { symbol: "USDT", percent: 3 },
      { symbol: "USDT0", percent: 1 },
      { symbol: "USDC", percent: 2 },
      { symbol: "axlUSDC", percent: 1 },
      { symbol: "AUSD", percent: 4 },
      { symbol: "WETH", percent: 1 },
    ]);
  });

  it("maps the analytics payload into Pharos reserve slices", () => {
    const result = adaptMentoReserveComposition(SAMPLE_PAYLOAD);
    expect(result.slices).toEqual([
      { name: "sUSDS (Sky savings USDS)", pct: 50, risk: "low", coinId: "susds-sky" },
      { name: "EURC (Circle euro stablecoin)", pct: 15, risk: "low", coinId: "eurc-circle" },
      { name: "CELO", pct: 15, risk: "high" },
      { name: "USDGLO (Glo Dollar)", pct: 5, risk: "low", coinId: "usdglo-glo" },
      { name: "USDT", pct: 4, risk: "low", coinId: "usdt-tether" },
      { name: "AUSD (Agora Dollar)", pct: 4, risk: "low", coinId: "ausd-agora" },
      { name: "stETH (Lido staked ETH)", pct: 3, risk: "low" },
      { name: "USDC", pct: 3, risk: "low", coinId: "usdc-circle" },
      { name: "ETH", pct: 1, risk: "very-low" },
    ]);
    expect(result.warnings).toBeUndefined();
  });

  it("maps USDT0 into the existing USDT reserve bucket without degrading", () => {
    const usdt0Payload = {
      collateral: {
        assets: [
          { symbol: "USDC", percentage: 50 },
          { symbol: "USDT0", percentage: 25 },
          { symbol: "WETH", percentage: 25 },
        ],
      },
    };

    const result = adaptMentoReserveComposition(usdt0Payload);
    expect(result.slices).toContainEqual({ name: "USDT", pct: 25, risk: "low", coinId: "usdt-tether" });
    expect(result.warnings).toBeUndefined();
    expect(result.metadata).toMatchObject({
      stableReservePct: 75,
      freshnessMode: "unverified",
    });
  });

  it("extracts the historical dashboard reserve payload timestamp", () => {
    expect(extractMentoDashboardTimestamp(
      String.raw`troves\":[{}],\"timestamp\":\"2026-05-11T23:21:16.007Z\"},\"dataUpdateCount\":1`,
    )).toBe(Math.floor(Date.parse("2026-05-11T23:21:16.007Z") / 1000));
  });

  it("extracts the current cdp_backings dashboard timestamp with deeper escaped quotes", () => {
    expect(extractMentoDashboardTimestamp(CURRENT_DASHBOARD_HTML)).toBe(
      Math.floor(Date.parse("2026-06-30T00:14:18.000Z") / 1000),
    );
  });

  it("falls back to numeric dashboard dataUpdatedAt milliseconds", () => {
    const html = String.raw`...\\"cdp_backings\\":[{\\"stablecoin\\":\\"GBPm\\"}],\\"dataUpdateCount\\":1,\\"dataUpdatedAt\\":1779025576506`;

    expect(extractMentoDashboardTimestamp(html)).toBe(
      Math.floor(Date.parse("2026-05-17T13:46:16.506Z") / 1000),
    );
  });

  it("ignores unrelated timestamps that appear outside the troves/dataUpdateCount anchor window", () => {
    const buildManifest =
      String.raw`buildManifest\":{\"timestamp\":\"2099-01-01T00:00:00.000Z\"},\"polyfillFiles\":[]`;
    const anchoredPayload =
      String.raw`troves\":[{}],\"timestamp\":\"2026-05-11T23:21:16.007Z\"},\"dataUpdateCount\":1`;
    const html = `${buildManifest}${"x".repeat(1024)}${anchoredPayload}`;

    expect(extractMentoDashboardTimestamp(html)).toBe(
      Math.floor(Date.parse("2026-05-11T23:21:16.007Z") / 1000),
    );
  });

  it("returns null when only a bare timestamp appears without troves/dataUpdateCount anchors", () => {
    const html =
      '<script>window.__data={\\"timestamp\\":\\"2026-05-01T12:00:00.000Z\\",\\"foo\\":1}</script>';

    expect(extractMentoDashboardTimestamp(html)).toBeNull();
  });

  it("emits a structural integrity warning when fewer than 3 reserve entries are parsed", () => {
    const twoEntryPayload = {
      collateral: {
        assets: [
          { symbol: "USDC", percentage: 80 },
          { symbol: "WETH", percentage: 20 },
        ],
      },
    };

    const result = adaptMentoReserveComposition(twoEntryPayload);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some((warning) => warning.code === "mento-low-entry-count")).toBe(true);
  });

  it("rejects reserve payloads whose percentages do not cover the full reserve mix", () => {
    const lowPctPayload = {
      collateral: {
        assets: [
          { symbol: "USDC", percentage: 10 },
          { symbol: "WETH", percentage: 5 },
          { symbol: "CELO", percentage: 3 },
        ],
      },
    };

    expect(() => adaptMentoReserveComposition(lowPctPayload)).toThrow("sum to 18.0%");
  });

  it("throws on missing collateral assets", () => {
    expect(() => parseMentoReserveComposition({})).toThrow("layout-changed");
  });

  it("throws when collateral assets contain no usable entries", () => {
    expect(() => parseMentoReserveComposition({
      collateral: {
        assets: [{ symbol: 123, percentage: "40" }],
      },
    })).toThrow("layout-changed");
  });

  it("parses active CDP troves for a requested Mento stablecoin", () => {
    const entries = parseMentoCdpComposition(SAMPLE_PAYLOAD, "GBPm");
    expect(entries).toEqual([
      {
        stablecoin: "GBPm",
        collateralToken: "USDm",
        collateralUsd: 173_427.5,
        debtUsd: 82_821.25,
        ratio: 2.09,
      },
      {
        stablecoin: "GBPm",
        collateralToken: "USDm",
        collateralUsd: 40_000,
        debtUsd: 20_000,
        ratio: 2,
      },
    ]);
  });

  it("maps CDP troves into USDm reserve slices and collateralization metadata", () => {
    const result = adaptMentoCdpComposition(SAMPLE_PAYLOAD, "GBPm");
    expect(result.slices).toEqual([
      {
        name: "USDm (Mento Dollar) CDP collateral",
        pct: 100,
        risk: "low",
        coinId: "cusd-celo",
        depType: "collateral",
      },
    ]);
    expect(result.warnings).toBeUndefined();
    expect(result.metadata).toMatchObject({
      cdpStablecoin: "GBPm",
      cdpActiveTroves: 2,
      totalCollateralUsd: 213_427.5,
      totalDebtUsd: 102_821.25,
      collateralizationRatio: 213_427.5 / 102_821.25,
      freshnessMode: "unverified",
    });
  });

  it("maps XOFm CDP troves through the same USDm collateral shape", () => {
    const result = adaptMentoCdpComposition(SAMPLE_PAYLOAD, "XOFm");
    expect(result.slices).toEqual([
      {
        name: "USDm (Mento Dollar) CDP collateral",
        pct: 100,
        risk: "low",
        coinId: "cusd-celo",
        depType: "collateral",
      },
    ]);
    expect(result.warnings).toBeUndefined();
    expect(result.metadata).toMatchObject({
      cdpStablecoin: "XOFm",
      cdpActiveTroves: 1,
      totalCollateralUsd: 25_000,
      totalDebtUsd: 12_500,
      collateralizationRatio: 2,
      freshnessMode: "unverified",
    });
  });

  it("stamps reserve composition with verified dashboard freshness when available", async () => {
    const result = await fetchMentoReserves(
      { id: "cusd-celo" } as never,
      makeMentoConfig(),
      new AbortController().signal,
      {
        requestCache: new Map<string, Promise<unknown>>([
          [mentoReserveBrowserCacheKey, Promise.resolve(SAMPLE_PAYLOAD)],
          [mentoDashboardBrowserCacheKey, Promise.resolve(MENTO_DASHBOARD_HTML_FIXTURE)],
        ]),
      } as never,
    );

    expect(result.metadata).toMatchObject({
      freshnessMode: "verified",
      sourceTimestamp: Math.floor(Date.parse("2026-05-11T23:21:16.007Z") / 1000),
    });
  });

  it("falls back to neutral headers for the reserve JSON fetch when browser-style headers fail", async () => {
    // Mento's analytics API intermittently 404s Cloudflare Worker egress
    // while serving 200 to browser-like clients; the neutral fetch identity
    // is the recovery path when the browser-style headers are rejected.
    const result = await fetchMentoReserves(
      { id: "cusd-celo" } as never,
      makeMentoConfig(),
      new AbortController().signal,
      {
        requestCache: new Map<string, Promise<unknown>>([
          [mentoReserveBrowserCacheKey, Promise.reject(new Error("browser headers rejected"))],
          [mentoReserveNeutralCacheKey, Promise.resolve(SAMPLE_PAYLOAD)],
          [mentoDashboardBrowserCacheKey, Promise.resolve(MENTO_DASHBOARD_HTML_FIXTURE)],
        ]),
      } as never,
    );

    expect(result.metadata).toMatchObject({
      freshnessMode: "verified",
      sourceTimestamp: Math.floor(Date.parse("2026-05-11T23:21:16.007Z") / 1000),
    });
  });

  it("throws a combined error when both header identities fail for the reserve JSON fetch", async () => {
    await expect(fetchMentoReserves(
      { id: "cusd-celo" } as never,
      makeMentoConfig(),
      new AbortController().signal,
      {
        requestCache: new Map<string, Promise<unknown>>([
          [mentoReserveBrowserCacheKey, Promise.reject(new Error("browser headers rejected"))],
          [mentoReserveNeutralCacheKey, Promise.reject(new Error("neutral headers rejected"))],
          [mentoDashboardBrowserCacheKey, Promise.resolve(MENTO_DASHBOARD_HTML_FIXTURE)],
        ]),
      } as never,
    )).rejects.toThrow(
      "browser fetch failed: browser headers rejected; neutral fetch failed: neutral headers rejected",
    );
  });

  it("falls back to neutral headers for the dashboard timestamp fetch when browser-style headers fail", async () => {
    const result = await fetchMentoReserves(
      { id: "cusd-celo" } as never,
      makeMentoConfig(),
      new AbortController().signal,
      {
        requestCache: new Map<string, Promise<unknown>>([
          [mentoReserveBrowserCacheKey, Promise.resolve(SAMPLE_PAYLOAD)],
          [mentoDashboardBrowserCacheKey, Promise.reject(new Error("browser headers rejected"))],
          [mentoDashboardNeutralCacheKey, Promise.resolve(MENTO_DASHBOARD_HTML_FIXTURE)],
        ]),
      } as never,
    );

    expect(result.metadata).toMatchObject({
      freshnessMode: "verified",
      sourceTimestamp: Math.floor(Date.parse("2026-05-11T23:21:16.007Z") / 1000),
    });
    expect(result.warnings).toBeUndefined();
  });

  it("degrades to unverified freshness with an info warning when both dashboard timestamp header identities fail", async () => {
    const result = await fetchMentoReserves(
      { id: "cusd-celo" } as never,
      makeMentoConfig(),
      new AbortController().signal,
      {
        requestCache: new Map<string, Promise<unknown>>([
          [mentoReserveBrowserCacheKey, Promise.resolve(SAMPLE_PAYLOAD)],
          [mentoDashboardBrowserCacheKey, Promise.reject(new Error("browser headers rejected"))],
          [mentoDashboardNeutralCacheKey, Promise.reject(new Error("neutral headers rejected"))],
        ]),
      } as never,
    );

    expect(result.metadata?.freshnessMode).toBe("unverified");
    expect(result.warnings?.some((warning) => warning.code === "mento-dashboard-timestamp-failed")).toBe(true);
  });

  it("stamps CDP composition with verified dashboard freshness when available", () => {
    const sourceTimestamp = Math.floor(Date.parse("2026-05-11T23:21:16.007Z") / 1000);
    const result = adaptMentoCdpComposition(SAMPLE_PAYLOAD, "GBPm", sourceTimestamp);

    expect(result.metadata).toMatchObject({
      freshnessMode: "verified",
      sourceTimestamp,
    });
  });

  it("throws when the requested CDP stablecoin has no active troves", () => {
    expect(() => parseMentoCdpComposition({
      cdp_troves: {
        troves: [
          {
            stablecoin: "GBPm",
            collateral_token: "USDm",
            collateral_usd: 10,
            debt_usd: 5,
            status: "closed",
          },
        ],
      },
    }, "GBPm")).toThrow("no active GBPm entries");
  });

  it("annotates freshness as explicitly unverified with reason metadata", () => {
    const result = adaptMentoReserveComposition(SAMPLE_PAYLOAD);
    expect(result.metadata).toMatchObject({
      freshnessMode: "unverified",
      details: {
        freshnessSource: "mento-analytics-api",
      },
      stableReservePct: 81,
    });
  });

  it("emits an unknown-asset warning for symbols not in TOKEN_CONFIG", () => {
    const unknownTokenPayload = {
      collateral: {
        assets: [
          { symbol: "USDC", percentage: 50 },
          { symbol: "WETH", percentage: 30 },
          { symbol: "NEW_TOKEN", percentage: 10 },
          { symbol: "CELO", percentage: 10 },
        ],
      },
    };
    const result = adaptMentoReserveComposition(unknownTokenPayload);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some((warning) => warning.code === "unknown-asset" && warning.message.includes("NEW_TOKEN"))).toBe(true);
  });

  it("produces reserve output that passes adapter validation", () => {
    const result = adaptMentoReserveComposition(SAMPLE_PAYLOAD);
    expect(validateAdapterOutput(result, { adapter: getReserveAdapter("mento") ?? undefined }).valid).toBe(true);
  });

  it("produces CDP reserve output that passes adapter validation", () => {
    const result = adaptMentoCdpComposition(SAMPLE_PAYLOAD, "XOFm");
    expect(validateAdapterOutput(result, { adapter: getReserveAdapter("mento") ?? undefined }).valid).toBe(true);
  });
});
