import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeAbiParameters } from "viem/utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MENTO_BIPOOL_MANAGER_ADDRESS,
  MENTO_GET_EXCHANGE_IDS_SELECTOR,
  MENTO_GET_POOL_EXCHANGE_SELECTOR,
  MENTO_POOL_EXCHANGE_ABI_PARAMETERS,
} from "@shared/lib/mento-contracts";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import {
  adaptMentoCdpComposition,
  adaptMentoReserveComposition,
  extractMentoDashboardTimestamp,
  fetchMentoReserves,
  parseMentoCdpComposition,
  parseMentoReserveComposition,
} from "../mento";
import {
  fetchErc20Balance,
  fetchErc20TotalSupply,
  fetchOnchainRateBps,
  fetchOnchainRawCall,
  fetchOnchainUint256,
} from "../helpers";
import { expectValidAdapterOutput } from "./reserve-adapter.test-support";
import { buildBrowserHeaders, NEUTRAL_ADAPTER_HEADERS } from "../request";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return {
    ...actual,
    fetchErc20Balance: vi.fn(),
    fetchErc20TotalSupply: vi.fn(),
    fetchOnchainRateBps: vi.fn(),
    fetchOnchainRawCall: vi.fn(),
    fetchOnchainUint256: vi.fn(),
  };
});

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const CURRENT_DASHBOARD_HTML = readFileSync(join(FIXTURES_DIR, "mento-reserve-composition.html"), "utf8");
// `refresh:html-fixtures` prepends this header; it is the fixture's own notion
// of "now", so dashboard-timestamp expectations ride it instead of a pinned second.
const CURRENT_DASHBOARD_CAPTURED_AT =
  /<!--\s*captured-at:\s*(\d{4}-\d{2}-\d{2}T[\d:]+Z)\s*-->/.exec(CURRENT_DASHBOARD_HTML)?.[1] ?? "";
/** A dashboard payload more than 3 days behind its own capture is a stale-upstream regression. */
const CURRENT_DASHBOARD_MAX_PAYLOAD_LAG_SEC = 3 * 24 * 60 * 60;

const MENTO_RESERVE_URL = "https://example.com/mento/reserve";
const MENTO_DASHBOARD_URL = "https://reserve.mento.org/";
// Mirrors the adapter's browser-style headers, embedded in the shared JSON/text request cache key.
const MENTO_BROWSER_HEADERS = buildBrowserHeaders("https://reserve.mento.org", "https://reserve.mento.org/");
const mentoReserveBrowserCacheKey = `json-get:${MENTO_RESERVE_URL}:12000:${JSON.stringify(MENTO_BROWSER_HEADERS)}`;
const mentoReserveNeutralCacheKey = `json-get:${MENTO_RESERVE_URL}:12000:${JSON.stringify(NEUTRAL_ADAPTER_HEADERS)}`;
const mentoDashboardBrowserCacheKey = `text-get:${MENTO_DASHBOARD_URL}:12000:${JSON.stringify(MENTO_BROWSER_HEADERS)}`;
const mentoDashboardNeutralCacheKey = `text-get:${MENTO_DASHBOARD_URL}:12000:${JSON.stringify(NEUTRAL_ADAPTER_HEADERS)}`;
const MENTO_DASHBOARD_HTML_FIXTURE = String.raw`troves\":[{}],\"timestamp\":\"2026-05-11T23:21:16.007Z\"},\"dataUpdateCount\":1`;

// --- Redemption telemetry fixtures ------------------------------------------
const USDM_ADDRESS = "0x765de816845861e75a25fca122bb6898b8b1282a";
const USDC_ADDRESS = "0xceba9300f2b948710d2653dd7b07f33a8b32118c";
const USDT_ADDRESS = "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e";
const EXCHANGE_ID_1 = `0x${"11".repeat(32)}`;
const EXCHANGE_ID_2 = `0x${"22".repeat(32)}`;
const EXCHANGE_ID_3 = `0x${"33".repeat(32)}`;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const FPMM_LP_FEE_SELECTOR = "0x704ce43e";
const FPMM_PROTOCOL_FEE_SELECTOR = "0xb0e21e8a";

function encodeExchangeIds(ids: string[]): `0x${string}` {
  return encodeAbiParameters([{ type: "bytes32[]" }], [ids as `0x${string}`[]]) as `0x${string}`;
}

function encodePoolExchange(overrides: {
  asset0: string;
  asset1: string;
  bucket0: bigint;
  bucket1: bigint;
  spread: bigint;
}): `0x${string}` {
  return encodeAbiParameters(MENTO_POOL_EXCHANGE_ABI_PARAMETERS, [{
    asset0: overrides.asset0 as `0x${string}`,
    asset1: overrides.asset1 as `0x${string}`,
    pricingModule: ZERO_ADDRESS as `0x${string}`,
    bucket0: overrides.bucket0,
    bucket1: overrides.bucket1,
    lastBucketUpdate: 0n,
    config: {
      spread: overrides.spread,
      referenceRateFeedID: ZERO_ADDRESS as `0x${string}`,
      referenceRateResetFrequency: 0n,
      minimumReports: 0n,
      stablePoolResetSize: 0n,
    },
  }]) as `0x${string}`;
}

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

  it("maps EUROP as a tracked stablecoin reserve without degrading", () => {
    const result = adaptMentoReserveComposition({
      collateral: {
        assets: [
          { symbol: "USDC", percentage: 50 },
          { symbol: "EUROP", percentage: 25 },
          { symbol: "WETH", percentage: 25 },
        ],
      },
    });

    expect(result.slices).toContainEqual({
      name: "EUROP (Schuman euro stablecoin)",
      pct: 25,
      risk: "low",
      coinId: "europ-schuman",
    });
    expect(result.warnings).toBeUndefined();
    expect(result.metadata).toMatchObject({ stableReservePct: 75 });
  });

  it("extracts the historical dashboard reserve payload timestamp", () => {
    expect(extractMentoDashboardTimestamp(
      String.raw`troves\":[{}],\"timestamp\":\"2026-05-11T23:21:16.007Z\"},\"dataUpdateCount\":1`,
    )).toBe(Math.floor(Date.parse("2026-05-11T23:21:16.007Z") / 1000));
  });

  it("extracts the current cdp_backings dashboard timestamp with deeper escaped quotes", () => {
    // Asserted against the fixture's own `captured-at` header rather than a
    // pinned second: the payload timestamp moves with every
    // `refresh:html-fixtures` run, so an exact pin re-reds on each refresh
    // while proving nothing extra. The window still fails on the real
    // regressions — the extractor returning null (anchor/escape-depth drift),
    // a value that is not a sane epoch-second integer, or a payload that lags
    // its own capture by days.
    expect(Number.isNaN(Date.parse(CURRENT_DASHBOARD_CAPTURED_AT))).toBe(false);
    const capturedAtSec = Math.floor(Date.parse(CURRENT_DASHBOARD_CAPTURED_AT) / 1000);
    const timestamp = extractMentoDashboardTimestamp(CURRENT_DASHBOARD_HTML);

    expect(timestamp).toEqual(expect.any(Number));
    expect(Number.isSafeInteger(timestamp)).toBe(true);
    // The dashboard payload is rendered just before the capture, never after it
    // (one hour of slack absorbs upstream clock skew).
    expect(timestamp).toBeLessThanOrEqual(capturedAtSec + 3_600);
    expect(timestamp).toBeGreaterThan(capturedAtSec - CURRENT_DASHBOARD_MAX_PAYLOAD_LAG_SEC);
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
    expectValidAdapterOutput("mento", result);
  });

  it("produces CDP reserve output that passes adapter validation", () => {
    const result = adaptMentoCdpComposition(SAMPLE_PAYLOAD, "XOFm");
    expectValidAdapterOutput("mento", result);
  });
});

describe("mento redemption telemetry", () => {
  afterEach(() => {
    vi.mocked(fetchOnchainRawCall).mockReset();
    vi.mocked(fetchOnchainUint256).mockReset();
    vi.mocked(fetchOnchainRateBps).mockReset();
    vi.mocked(fetchErc20Balance).mockReset();
    vi.mocked(fetchErc20TotalSupply).mockReset();
  });

  function makeRedemptionConfig(params: Record<string, unknown>): LiveReservesConfig {
    return { ...makeMentoConfig(), params };
  }

  function makeRequestCache(): Map<string, Promise<unknown>> {
    return new Map<string, Promise<unknown>>([
      [mentoReserveBrowserCacheKey, Promise.resolve(SAMPLE_PAYLOAD)],
      [mentoDashboardBrowserCacheKey, Promise.resolve(MENTO_DASHBOARD_HTML_FIXTURE)],
    ]);
  }

  it("computes broker-pool capacity as the summed counter-asset buckets and fee as the max matched spread", async () => {
    vi.mocked(fetchOnchainRawCall).mockImplementation(async ({ contract, data }) => {
      expect(contract).toBe(MENTO_BIPOOL_MANAGER_ADDRESS);
      if (data === MENTO_GET_EXCHANGE_IDS_SELECTOR) {
        return encodeExchangeIds([EXCHANGE_ID_1, EXCHANGE_ID_2]);
      }
      if (data === `${MENTO_GET_POOL_EXCHANGE_SELECTOR}${EXCHANGE_ID_1.slice(2)}`) {
        // MGP-13 stable-pool spread: 5e20 of the 1e24 Fixidity scale = 5 bps.
        return encodePoolExchange({
          asset0: USDM_ADDRESS,
          asset1: USDC_ADDRESS,
          bucket0: 0n,
          bucket1: 1_000n * 10n ** 18n,
          spread: 5n * 10n ** 20n,
        });
      }
      if (data === `${MENTO_GET_POOL_EXCHANGE_SELECTOR}${EXCHANGE_ID_2.slice(2)}`) {
        // 1e22 of the 1e24 Fixidity scale = 100 bps (1%).
        return encodePoolExchange({
          asset0: USDT_ADDRESS,
          asset1: USDM_ADDRESS,
          bucket0: 2_500n * 10n ** 18n,
          bucket1: 0n,
          spread: 10n ** 22n,
        });
      }
      return null;
    });

    const config = makeRedemptionConfig({
      redemption: {
        kind: "broker-pool",
        pools: [
          { selfTokenAddress: USDM_ADDRESS, counterAsset: { address: USDC_ADDRESS, label: "USDC" } },
          { selfTokenAddress: USDM_ADDRESS, counterAsset: { address: USDT_ADDRESS, label: "USDT" } },
        ],
        sourceUrls: ["https://docs.mento.org/mento/build-on-mento/smart-contracts/bipoolmanager"],
      },
    });

    const result = await fetchMentoReserves(
      { id: "cusd-celo" } as never,
      config,
      new AbortController().signal,
      { requestCache: makeRequestCache() } as never,
    );

    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: 3_500,
      capacityKind: "live-direct-bounded",
      freshnessKind: "same-run-onchain",
      routeStatus: "open",
      routeStatusSource: "onchain",
      holderEligibility: "any-holder",
      settlementDelaySec: 0,
      feeBps: 100,
      sourceUrls: ["https://docs.mento.org/mento/build-on-mento/smart-contracts/bipoolmanager"],
    });
    expect(result.metadata?.redemptionFeeBps).toBe(100);
    // Redemption telemetry is additive: the analytics-API reserve composition
    // is untouched.
    expect(result.slices.length).toBeGreaterThan(0);
    expect(result.warnings).toBeUndefined();
  });

  it("converts a single-pool 5 bps spread correctly", async () => {
    vi.mocked(fetchOnchainRawCall).mockImplementation(async ({ data }) => {
      if (data === MENTO_GET_EXCHANGE_IDS_SELECTOR) return encodeExchangeIds([EXCHANGE_ID_1]);
      if (data === `${MENTO_GET_POOL_EXCHANGE_SELECTOR}${EXCHANGE_ID_1.slice(2)}`) {
        return encodePoolExchange({
          asset0: USDM_ADDRESS,
          asset1: USDC_ADDRESS,
          bucket0: 0n,
          bucket1: 10n ** 18n,
          spread: 5n * 10n ** 20n,
        });
      }
      return null;
    });

    const config = makeRedemptionConfig({
      redemption: {
        kind: "broker-pool",
        pools: [{ selfTokenAddress: USDM_ADDRESS, counterAsset: { address: USDC_ADDRESS } }],
      },
    });

    const result = await fetchMentoReserves(
      { id: "cusd-celo" } as never,
      config,
      new AbortController().signal,
      { requestCache: makeRequestCache() } as never,
    );

    expect(result.metadata?.redemptionFeeBps).toBe(5);
  });

  it("caches broker reads separately and stops each coin once its configured pools match", async () => {
    const requestedData: string[] = [];
    let activePoolReads = 0;
    let maxActivePoolReads = 0;
    vi.mocked(fetchOnchainRawCall).mockImplementation(async ({ data }) => {
      requestedData.push(data);
      if (data === MENTO_GET_EXCHANGE_IDS_SELECTOR) {
        return encodeExchangeIds([EXCHANGE_ID_1, EXCHANGE_ID_2, EXCHANGE_ID_3]);
      }
      activePoolReads += 1;
      maxActivePoolReads = Math.max(maxActivePoolReads, activePoolReads);
      await Promise.resolve();
      activePoolReads -= 1;
      if (data === `${MENTO_GET_POOL_EXCHANGE_SELECTOR}${EXCHANGE_ID_1.slice(2)}`) {
        return encodePoolExchange({
          asset0: USDM_ADDRESS,
          asset1: USDC_ADDRESS,
          bucket0: 0n,
          bucket1: 10n ** 18n,
          spread: 5n * 10n ** 20n,
        });
      }
      if (data === `${MENTO_GET_POOL_EXCHANGE_SELECTOR}${EXCHANGE_ID_3.slice(2)}`) {
        return encodePoolExchange({
          asset0: USDT_ADDRESS,
          asset1: USDM_ADDRESS,
          bucket0: 2n * 10n ** 18n,
          bucket1: 0n,
          spread: 10n ** 22n,
        });
      }
      return null;
    });
    const usdcConfig = makeRedemptionConfig({
      redemption: {
        kind: "broker-pool",
        pools: [{ selfTokenAddress: USDM_ADDRESS, counterAsset: { address: USDC_ADDRESS } }],
      },
    });
    const usdtConfig = makeRedemptionConfig({
      redemption: {
        kind: "broker-pool",
        pools: [{ selfTokenAddress: USDM_ADDRESS, counterAsset: { address: USDT_ADDRESS } }],
      },
    });
    const requestCache = makeRequestCache();

    await fetchMentoReserves(
      { id: "cusd-celo" } as never,
      usdcConfig,
      new AbortController().signal,
      { requestCache } as never,
    );
    expect(requestedData).toEqual([
      MENTO_GET_EXCHANGE_IDS_SELECTOR,
      `${MENTO_GET_POOL_EXCHANGE_SELECTOR}${EXCHANGE_ID_1.slice(2)}`,
    ]);

    await fetchMentoReserves(
      { id: "ceur-celo" } as never,
      usdtConfig,
      new AbortController().signal,
      { requestCache } as never,
    );

    expect(maxActivePoolReads).toBe(1);
    expect(requestedData).toEqual([
      MENTO_GET_EXCHANGE_IDS_SELECTOR,
      `${MENTO_GET_POOL_EXCHANGE_SELECTOR}${EXCHANGE_ID_1.slice(2)}`,
      `${MENTO_GET_POOL_EXCHANGE_SELECTOR}${EXCHANGE_ID_2.slice(2)}`,
      `${MENTO_GET_POOL_EXCHANGE_SELECTOR}${EXCHANGE_ID_3.slice(2)}`,
    ]);
  });

  it("continues a broker scan after another coin times out without inheriting its rejected read", async () => {
    vi.useFakeTimers();
    try {
      const requestedData: string[] = [];
      let exchangeTwoAttempts = 0;
      vi.mocked(fetchOnchainRawCall).mockImplementation(async ({ data, signal }) => {
        requestedData.push(data);
        if (data === MENTO_GET_EXCHANGE_IDS_SELECTOR) {
          return encodeExchangeIds([EXCHANGE_ID_1, EXCHANGE_ID_2, EXCHANGE_ID_3]);
        }
        if (data === `${MENTO_GET_POOL_EXCHANGE_SELECTOR}${EXCHANGE_ID_1.slice(2)}`) return null;
        if (data === `${MENTO_GET_POOL_EXCHANGE_SELECTOR}${EXCHANGE_ID_2.slice(2)}`) {
          exchangeTwoAttempts += 1;
          if (exchangeTwoAttempts === 1) {
            return new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          }
          return null;
        }
        if (data === `${MENTO_GET_POOL_EXCHANGE_SELECTOR}${EXCHANGE_ID_3.slice(2)}`) {
          return encodePoolExchange({
            asset0: USDM_ADDRESS,
            asset1: USDC_ADDRESS,
            bucket0: 0n,
            bucket1: 10n ** 18n,
            spread: 5n * 10n ** 20n,
          });
        }
        return null;
      });
      const config = makeRedemptionConfig({
        redemption: {
          kind: "broker-pool",
          pools: [{ selfTokenAddress: USDM_ADDRESS, counterAsset: { address: USDC_ADDRESS } }],
        },
      });
      const requestCache = makeRequestCache();

      const firstResultPromise = fetchMentoReserves(
        { id: "cusd-celo" } as never,
        config,
        new AbortController().signal,
        { requestCache } as never,
      );
      await vi.advanceTimersByTimeAsync(8_000);
      const firstResult = await firstResultPromise;
      const secondResult = await fetchMentoReserves(
        { id: "ceur-celo" } as never,
        config,
        new AbortController().signal,
        { requestCache } as never,
      );

      expect(firstResult.metadata?.redemption).toBeUndefined();
      expect(firstResult.warnings?.some((warning) =>
        warning.code === "mento-redemption-telemetry-failed"
        && warning.message.includes("mento-redemption-timeout")
      )).toBe(true);
      expect(secondResult.metadata?.redemption).toMatchObject({ capacityUsd: 1 });
      expect(requestedData).toEqual([
        MENTO_GET_EXCHANGE_IDS_SELECTOR,
        `${MENTO_GET_POOL_EXCHANGE_SELECTOR}${EXCHANGE_ID_1.slice(2)}`,
        `${MENTO_GET_POOL_EXCHANGE_SELECTOR}${EXCHANGE_ID_2.slice(2)}`,
        `${MENTO_GET_POOL_EXCHANGE_SELECTOR}${EXCHANGE_ID_2.slice(2)}`,
        `${MENTO_GET_POOL_EXCHANGE_SELECTOR}${EXCHANGE_ID_3.slice(2)}`,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails broker-pool telemetry closed when the RPC returns too many exchange ids", async () => {
    const oversizedExchangeIds = Array.from(
      { length: 65 },
      (_, index) => `0x${index.toString(16).padStart(64, "0")}`,
    );
    vi.mocked(fetchOnchainRawCall).mockImplementation(async ({ data }) => {
      if (data === MENTO_GET_EXCHANGE_IDS_SELECTOR) return encodeExchangeIds(oversizedExchangeIds);
      throw new Error(`unexpected capped broker-pool lookup: ${data}`);
    });
    const config = makeRedemptionConfig({
      redemption: {
        kind: "broker-pool",
        pools: [{ selfTokenAddress: USDM_ADDRESS, counterAsset: { address: USDC_ADDRESS } }],
      },
    });

    const result = await fetchMentoReserves(
      { id: "cusd-celo" } as never,
      config,
      new AbortController().signal,
      { requestCache: makeRequestCache() } as never,
    );

    expect(result.slices.length).toBeGreaterThan(0);
    expect(result.metadata?.redemption).toBeUndefined();
    expect(result.warnings?.some((warning) => warning.code === "mento-redemption-telemetry-failed")).toBe(true);
    expect(fetchOnchainRawCall).toHaveBeenCalledTimes(1);
  });

  it("retains a failed exchange-id read for the run instead of retrying it per coin", async () => {
    vi.mocked(fetchOnchainRawCall).mockRejectedValue(new Error("rpc down"));
    const config = makeRedemptionConfig({
      redemption: {
        kind: "broker-pool",
        pools: [{ selfTokenAddress: USDM_ADDRESS, counterAsset: { address: USDC_ADDRESS } }],
      },
    });
    const requestCache = makeRequestCache();

    const first = await fetchMentoReserves(
      { id: "cusd-celo" } as never,
      config,
      new AbortController().signal,
      { requestCache } as never,
    );
    const second = await fetchMentoReserves(
      { id: "ceur-celo" } as never,
      config,
      new AbortController().signal,
      { requestCache } as never,
    );

    expect(fetchOnchainRawCall).toHaveBeenCalledTimes(1);
    expect(first.warnings?.some((warning) => warning.code === "mento-redemption-telemetry-failed")).toBe(true);
    expect(second.warnings?.some((warning) => warning.code === "mento-redemption-telemetry-failed")).toBe(true);
  });

  it("bounds optional redemption telemetry without discarding reserve composition", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(fetchOnchainRawCall).mockImplementation(({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      );
      const config = makeRedemptionConfig({
        redemption: {
          kind: "broker-pool",
          pools: [{ selfTokenAddress: USDM_ADDRESS, counterAsset: { address: USDC_ADDRESS } }],
        },
      });
      const resultPromise = fetchMentoReserves(
        { id: "cusd-celo" } as never,
        config,
        new AbortController().signal,
        { requestCache: makeRequestCache() } as never,
      );

      await vi.advanceTimersByTimeAsync(8_000);
      const result = await resultPromise;

      expect(result.slices.length).toBeGreaterThan(0);
      expect(result.metadata?.redemption).toBeUndefined();
      expect(result.warnings?.some((warning) =>
        warning.code === "mento-redemption-telemetry-failed"
        && warning.message.includes("mento-redemption-timeout")
      )).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when the broker-pool onchain read fails, leaving reserve slices unaffected", async () => {
    vi.mocked(fetchOnchainRawCall).mockRejectedValue(new Error("rpc down"));

    const config = makeRedemptionConfig({
      redemption: {
        kind: "broker-pool",
        pools: [{ selfTokenAddress: USDM_ADDRESS, counterAsset: { address: USDC_ADDRESS } }],
      },
    });

    const result = await fetchMentoReserves(
      { id: "cusd-celo" } as never,
      config,
      new AbortController().signal,
      { requestCache: makeRequestCache() } as never,
    );

    expect(result.slices.length).toBeGreaterThan(0);
    expect(result.metadata?.redemption).toBeUndefined();
    expect(result.warnings?.some((warning) => warning.code === "mento-redemption-telemetry-failed")).toBe(true);
  });

  it("computes liquity-v2-cr capacity ratio and fee for the GBPm CDP branch", async () => {
    const ACTIVE_POOL = "0xa7873F4Bf2A1ea2EB20B1e8A992C4748e78473b2";
    const TROVE_MANAGER = "0xb38aEf2bF4e34B997330D626EBCd7629De3885C9";
    const COLLATERAL_REGISTRY = "0x1bEDD4334335522B0a0e8e610d326B16B0a605Fb";
    const GBPM_TOKEN = "0xCCF663b1fF11028f0b19058d0f7B674004a40746";

    vi.mocked(fetchOnchainUint256).mockImplementation(async ({ contract, data }) => (
      contract === ACTIVE_POOL && data === "0x45507998" ? 500n * 10n ** 18n : null
    ));
    vi.mocked(fetchOnchainRawCall).mockImplementation(async ({ contract, data }) => (
      contract === TROVE_MANAGER && data === "0x58569081" ? `0x${"0".repeat(64)}` : null
    ));
    vi.mocked(fetchOnchainRateBps).mockImplementation(async (_input, probe) => (
      probe.contract === COLLATERAL_REGISTRY && probe.selector === "0xc52861f2" ? 50 : null
    ));
    vi.mocked(fetchErc20TotalSupply).mockImplementation(async (_input, address) => (
      address === GBPM_TOKEN ? 1_000n * 10n ** 18n : null
    ));

    const config = makeRedemptionConfig({
      cdpStablecoin: "GBPm",
      redemption: {
        kind: "liquity-v2-cr",
        collateralRegistryAddress: COLLATERAL_REGISTRY,
        troveManagerAddress: TROVE_MANAGER,
        activePoolAddress: ACTIVE_POOL,
        tokenAddress: GBPM_TOKEN,
      },
    });

    const result = await fetchMentoReserves(
      { id: "gbpm-mento" } as never,
      config,
      new AbortController().signal,
      { requestCache: makeRequestCache() } as never,
    );

    expect(result.metadata?.redemption).toMatchObject({
      capacityRatioOfSupply: 0.5,
      capacityKind: "live-direct-bounded",
      freshnessKind: "same-run-onchain",
      routeStatus: "open",
      routeStatusSource: "onchain",
      feeBps: 50,
    });
    expect(result.slices.length).toBeGreaterThan(0);
  });

  it("fails closed when the liquity-v2-cr onchain read fails, leaving reserve slices unaffected", async () => {
    vi.mocked(fetchOnchainUint256).mockResolvedValue(null);
    vi.mocked(fetchOnchainRawCall).mockResolvedValue(null);
    vi.mocked(fetchOnchainRateBps).mockResolvedValue(null);
    vi.mocked(fetchErc20TotalSupply).mockResolvedValue(null);

    const config = makeRedemptionConfig({
      cdpStablecoin: "GBPm",
      redemption: {
        kind: "liquity-v2-cr",
        collateralRegistryAddress: "0x1bEDD4334335522B0a0e8e610d326B16B0a605Fb",
        troveManagerAddress: "0xb38aEf2bF4e34B997330D626EBCd7629De3885C9",
        activePoolAddress: "0xa7873F4Bf2A1ea2EB20B1e8A992C4748e78473b2",
        tokenAddress: "0xCCF663b1fF11028f0b19058d0f7B674004a40746",
      },
    });

    const result = await fetchMentoReserves(
      { id: "gbpm-mento" } as never,
      config,
      new AbortController().signal,
      { requestCache: makeRequestCache() } as never,
    );

    expect(result.slices.length).toBeGreaterThan(0);
    expect(result.metadata?.redemption).toBeUndefined();
    expect(result.warnings?.some((warning) => warning.code === "mento-redemption-telemetry-failed")).toBe(true);
  });

  it("computes fpmm-pool capacity and fee from the pool's USDm balance and swap fees", async () => {
    const POOL_ADDRESS = "0x9861F6D2Fe392b934C86eC89D2886CEb772B2b41";

    vi.mocked(fetchErc20Balance).mockImplementation(async (_input, tokenAddress, holder) => (
      tokenAddress === USDM_ADDRESS && holder === POOL_ADDRESS ? 750n * 10n ** 18n : null
    ));
    vi.mocked(fetchOnchainUint256).mockImplementation(async ({ contract, data }) => {
      if (contract !== POOL_ADDRESS) return null;
      if (data === FPMM_LP_FEE_SELECTOR) return 20n;
      if (data === FPMM_PROTOCOL_FEE_SELECTOR) return 10n;
      return null;
    });

    const config = makeRedemptionConfig({
      cdpStablecoin: "JPYm",
      redemption: {
        kind: "fpmm-pool",
        poolAddress: POOL_ADDRESS,
        usdmTokenAddress: USDM_ADDRESS,
      },
    });

    const result = await fetchMentoReserves(
      { id: "jpym-mento" } as never,
      config,
      new AbortController().signal,
      { requestCache: makeRequestCache() } as never,
    );

    const redemption = result.metadata?.redemption as Record<string, unknown> | undefined;
    expect(redemption).toMatchObject({
      capacityUsd: 750,
      capacityKind: "live-direct-bounded",
      freshnessKind: "same-run-onchain",
      routeStatus: "open",
      feeBps: 30,
    });
    expect(result.slices.length).toBeGreaterThan(0);
  });

  it("keeps fpmm-pool capacity but omits the fee when a fee leg does not read", async () => {
    const POOL_ADDRESS = "0x9861F6D2Fe392b934C86eC89D2886CEb772B2b41";

    vi.mocked(fetchErc20Balance).mockResolvedValue(750n * 10n ** 18n);
    vi.mocked(fetchOnchainUint256).mockImplementation(async ({ data }) => (
      data === FPMM_LP_FEE_SELECTOR ? 20n : null
    ));

    const config = makeRedemptionConfig({
      cdpStablecoin: "JPYm",
      redemption: {
        kind: "fpmm-pool",
        poolAddress: POOL_ADDRESS,
        usdmTokenAddress: USDM_ADDRESS,
      },
    });

    const result = await fetchMentoReserves(
      { id: "jpym-mento" } as never,
      config,
      new AbortController().signal,
      { requestCache: makeRequestCache() } as never,
    );

    const redemption = result.metadata?.redemption as Record<string, unknown> | undefined;
    expect(redemption).toMatchObject({ capacityUsd: 750 });
    expect(redemption?.feeBps).toBeUndefined();
  });

  it("fails closed when the fpmm-pool balance read fails, leaving reserve slices unaffected", async () => {
    vi.mocked(fetchErc20Balance).mockResolvedValue(null);

    const config = makeRedemptionConfig({
      cdpStablecoin: "CHFm",
      redemption: {
        kind: "fpmm-pool",
        poolAddress: "0xDC81135fD82f02Cae736E261FB676B716663e8b8",
        usdmTokenAddress: USDM_ADDRESS,
      },
    });

    const result = await fetchMentoReserves(
      { id: "chfm-mento" } as never,
      config,
      new AbortController().signal,
      { requestCache: makeRequestCache() } as never,
    );

    expect(result.slices.length).toBeGreaterThan(0);
    expect(result.metadata?.redemption).toBeUndefined();
    expect(result.warnings?.some((warning) => warning.code === "mento-redemption-telemetry-failed")).toBe(true);
  });
});
