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
import type { AdapterContext } from "../types";
import {
  expectValidAdapterOutput,
  expectWarningEffect,
  expectWarnings,
  installAdapterNetwork,
  resolveAdapterCoin,
  runAdapter,
  type AdapterNetwork,
  type AdapterNetworkSpec,
  type AdapterRpcValue,
} from "./reserve-adapter.test-support";
import { MENTO_RESERVE_COMPOSITION_PAYLOAD as SAMPLE_PAYLOAD } from "./reserve-adapter-payloads.test-support";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const CURRENT_DASHBOARD_HTML = readFileSync(join(FIXTURES_DIR, "mento-reserve-composition.html"), "utf8");
// `refresh:html-fixtures` prepends this header; it is the fixture's own notion
// of "now", so dashboard-timestamp expectations and replay clocks ride it
// instead of a pinned second.
const CURRENT_DASHBOARD_CAPTURED_AT =
  /<!--\s*captured-at:\s*(\d{4}-\d{2}-\d{2}T[\d:]+Z)\s*-->/.exec(CURRENT_DASHBOARD_HTML)?.[1] ?? "";
const CURRENT_DASHBOARD_NOW_SEC =
  Math.floor(Date.parse(CURRENT_DASHBOARD_CAPTURED_AT) / 1000) + 5 * 60 * 60;
/** A dashboard payload more than 3 days behind its own capture is a stale-upstream regression. */
const CURRENT_DASHBOARD_MAX_PAYLOAD_LAG_SEC = 3 * 24 * 60 * 60;

// Real catalog endpoints for the mento adapter's two HTTP sources.
const CATALOG_RESERVE_URL = "https://mento-analytics-api-12390052758.us-central1.run.app/api/v2/reserve";
const MENTO_DASHBOARD_URL = "https://reserve.mento.org/";

// --- Redemption telemetry fixtures ------------------------------------------
const USDM_ADDRESS = "0x765de816845861e75a25fca122bb6898b8b1282a";
const USDC_ADDRESS = "0xceba9300f2b948710d2653dd7b07f33a8b32118c";
const USDT_ADDRESS = "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e";
const BRLM_TOKEN_ADDRESS = "0xe8537a3d056da446677b9e9d6c5db704eaab4787";
const EXCHANGE_ID_1 = `0x${"11".repeat(32)}`;
const EXCHANGE_ID_2 = `0x${"22".repeat(32)}`;
const EXCHANGE_ID_3 = `0x${"33".repeat(32)}`;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const FPMM_LP_FEE_SELECTOR = "0x704ce43e";
const FPMM_PROTOCOL_FEE_SELECTOR = "0xb0e21e8a";
// The Mento fork's Liquity v2 selectors (see mento-redemption.ts).
const LIQUITY_V2_DEBT_SELECTOR = "0x45507998"; // getBoldDebt()
const LIQUITY_V2_SHUTDOWN_SELECTOR = "0x58569081"; // shutdownTime()
const LIQUITY_V2_REDEMPTION_RATE_SELECTOR = "0xc52861f2"; // getRedemptionRateWithDecay()

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

const BIPOOL_MANAGER = MENTO_BIPOOL_MANAGER_ADDRESS.toLowerCase();
const rpcKey = (calldata: string) => `celo:${BIPOOL_MANAGER}:${calldata}`;
const exchangeIdsKey = rpcKey(MENTO_GET_EXCHANGE_IDS_SELECTOR);
const poolExchangeKey = (exchangeId: string) =>
  rpcKey(`${MENTO_GET_POOL_EXCHANGE_SELECTOR}${exchangeId.slice(2)}`);

// The historical hand-built dashboard fragment used by the header-fallback
// cases; its embedded timestamp is the verified-freshness clock those runs
// publish.
const MENTO_DASHBOARD_HTML_FIXTURE = String.raw`troves\":[{}],\"timestamp\":\"2026-05-11T23:21:16.007Z\"},\"dataUpdateCount\":1`;
const DASHBOARD_FRAGMENT_TS_SEC = Math.floor(Date.parse("2026-05-11T23:21:16.007Z") / 1000);

/**
 * Builds a minimal dashboard payload carrying the given escaped `cdp_backings`
 * rows. `dataUpdatedAt` (2026-05-17T13:46:16.506Z) is the replay clock for
 * runs that consume it.
 */
function dashboardHtmlWithCdpBackings(backings: Array<Record<string, unknown>>): string {
  const backingsJson = JSON.stringify(backings).replaceAll('"', '\\"');
  return `cdp_backings\\":${backingsJson},\\"dataUpdateCount\\":1,\\"dataUpdatedAt\\":1779025576506`;
}
const OVERRIDE_DASHBOARD_TS_SEC = 1_779_025_576;
const OVERRIDE_DASHBOARD_NOW_SEC = OVERRIDE_DASHBOARD_TS_SEC + 120;

// Per-stablecoin cdp_backings rows whose totals match the SAMPLE_PAYLOAD
// analytics trove sums exactly, so CDP-coin replays pass the dashboard-vs-API
// coherence gate.
const SAMPLE_CDP_TOTALS: Record<string, { collateral_usd: number; debt_usd: number }> = {
  GBPm: { collateral_usd: 213_427.5, debt_usd: 102_821.25 },
  JPYm: { collateral_usd: 171_960.48, debt_usd: 105_336.2 },
  CHFm: { collateral_usd: 143_361.85, debt_usd: 90_307.02 },
};

function sampleMatchingDashboardHtml(stablecoin: keyof typeof SAMPLE_CDP_TOTALS): string {
  return dashboardHtmlWithCdpBackings([{
    stablecoin,
    collateral_token: "USDm",
    ...SAMPLE_CDP_TOTALS[stablecoin],
    status: "active",
  }]);
}

interface MentoNetworkOptions {
  reserveJson?: unknown;
  dashboardHtml?: string;
  rpc?: Record<string, AdapterRpcValue>;
}

function mentoNetwork(options: MentoNetworkOptions = {}): AdapterNetworkSpec {
  return {
    json: { [CATALOG_RESERVE_URL]: options.reserveJson ?? SAMPLE_PAYLOAD },
    html: { [MENTO_DASHBOARD_URL]: options.dashboardHtml ?? CURRENT_DASHBOARD_HTML },
    ...(options.rpc ? { rpc: options.rpc } : {}),
  };
}

/** The real catalog config of a mento coin, with test params swapped in. */
function catalogConfig(coinId: string, params?: Record<string, unknown>): LiveReservesConfig {
  const { config } = resolveAdapterCoin("mento", coinId);
  return params ? { ...config, params: params as LiveReservesConfig["params"] } : config;
}

function brokerPoolConfig(coinId: string, pools: Array<{
  selfTokenAddress: string;
  counterAssetAddress: string;
  counterAssetLabel?: string;
  sourceUrls?: string[];
}>): LiveReservesConfig {
  return catalogConfig(coinId, {
    redemption: {
      kind: "broker-pool",
      pools: pools.map((pool) => ({
        selfTokenAddress: pool.selfTokenAddress,
        counterAsset: {
          address: pool.counterAssetAddress,
          ...(pool.counterAssetLabel ? { label: pool.counterAssetLabel } : {}),
        },
      })),
      ...(pools[0]?.sourceUrls ? { sourceUrls: pools[0]!.sourceUrls } : {}),
    },
  });
}

function directCtx(network: AdapterNetwork, requestCache: Map<string, Promise<unknown>>): AdapterContext {
  return { chainRpcs: network.chainRpcs, requestCache };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mento adapter", () => {
  // --- Pure parse/adapt units ------------------------------------------------
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
    expect(extractMentoDashboardTimestamp(MENTO_DASHBOARD_HTML_FIXTURE)).toBe(DASHBOARD_FRAGMENT_TS_SEC);
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

    expect(extractMentoDashboardTimestamp(html)).toBe(OVERRIDE_DASHBOARD_TS_SEC);
  });

  it("ignores unrelated timestamps that appear outside the troves/dataUpdateCount anchor window", () => {
    const buildManifest =
      String.raw`buildManifest\":{\"timestamp\":\"2099-01-01T00:00:00.000Z\"},\"polyfillFiles\":[]`;
    const html = `${buildManifest}${"x".repeat(1024)}${MENTO_DASHBOARD_HTML_FIXTURE}`;

    expect(extractMentoDashboardTimestamp(html)).toBe(DASHBOARD_FRAGMENT_TS_SEC);
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

  it("stamps CDP composition with verified dashboard freshness when available", () => {
    const result = adaptMentoCdpComposition(SAMPLE_PAYLOAD, "GBPm", DASHBOARD_FRAGMENT_TS_SEC);

    expect(result.metadata).toMatchObject({
      freshnessMode: "verified",
      sourceTimestamp: DASHBOARD_FRAGMENT_TS_SEC,
      details: { freshnessSource: "same-run-render-clock" },
    });
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
    const result = adaptMentoCdpComposition(SAMPLE_PAYLOAD, "GBPm");
    expectValidAdapterOutput("mento", result);
  });

  // --- Fetch-level, through the harness --------------------------------------
  it("fetches the catalog-bound reserve composition and dashboard clock through the harness", async () => {
    const { result } = await runAdapter("mento", "cusd-celo", {
      network: mentoNetwork(),
      nowSec: CURRENT_DASHBOARD_NOW_SEC,
    });

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
    expect(result.metadata).toMatchObject({
      freshnessMode: "verified",
      details: { freshnessSource: "same-run-render-clock" },
      stableReservePct: 81,
    });
    expect(result.metadata?.sourceTimestamp).toEqual(expect.any(Number));
    expectWarnings(result, []);
  });

  it.each([
    { reserveFails: false, dashboardFails: false },
    { reserveFails: true, dashboardFails: false },
    { reserveFails: false, dashboardFails: true },
  ])("uses observed HTTP header fallback: $reserveFails / $dashboardFails", async ({ reserveFails, dashboardFails }) => {
    const rejectedIdentities = [
      ...(reserveFails ? [`${CATALOG_RESERVE_URL}:browser`] : []),
      ...(dashboardFails ? [`${MENTO_DASHBOARD_URL}:browser`] : []),
    ];
    const identities: Array<{ url: string; identity: string; referer: string | null }> = [];
    const respond = <T>(url: string, ok: T) =>
      (request: Request): T | { status: number; body: string } => {
        const identity = request.headers.get("origin") !== null ? "browser" : "neutral";
        identities.push({ url, identity, referer: request.headers.get("referer") });
        if (rejectedIdentities.includes(`${url}:${identity}`)) {
          return { status: identity === "browser" ? 401 : 403, body: "denied" };
        }
        return ok;
      };

    const { result } = await runAdapter("mento", "cusd-celo", {
      network: {
        json: { [CATALOG_RESERVE_URL]: respond(CATALOG_RESERVE_URL, SAMPLE_PAYLOAD) },
        html: { [MENTO_DASHBOARD_URL]: respond(MENTO_DASHBOARD_URL, MENTO_DASHBOARD_HTML_FIXTURE) },
      },
      nowSec: DASHBOARD_FRAGMENT_TS_SEC + 120,
    });

    expect(result.metadata).toMatchObject({
      freshnessMode: "verified",
      sourceTimestamp: DASHBOARD_FRAGMENT_TS_SEC,
    });
    expect(result.slices).toContainEqual({ name: "sUSDS (Sky savings USDS)", pct: 50, risk: "low", coinId: "susds-sky" });
    for (const [url, fallback] of [[CATALOG_RESERVE_URL, reserveFails], [MENTO_DASHBOARD_URL, dashboardFails]] as const) {
      expect(identities.filter((request) => request.url === url).map(({ identity }) => identity))
        .toEqual(fallback ? ["browser", "neutral"] : ["browser"]);
    }
    expect(identities.filter(({ identity }) => identity === "browser").map(({ referer }) => referer))
      .toEqual([MENTO_DASHBOARD_URL, MENTO_DASHBOARD_URL]);
  });

  it("retains both failed HTTP causes for reserve JSON", async () => {
    const rejectedIdentities = [`${CATALOG_RESERVE_URL}:browser`, `${CATALOG_RESERVE_URL}:neutral`];
    const respond = <T>(url: string, ok: T) =>
      (request: Request): T | { status: number; body: string } => {
        const identity = request.headers.get("origin") !== null ? "browser" : "neutral";
        if (rejectedIdentities.includes(`${url}:${identity}`)) {
          return { status: identity === "browser" ? 401 : 403, body: "denied" };
        }
        return ok;
      };

    const caught = await runAdapter("mento", "cusd-celo", {
      network: {
        json: { [CATALOG_RESERVE_URL]: respond(CATALOG_RESERVE_URL, SAMPLE_PAYLOAD) },
        html: { [MENTO_DASHBOARD_URL]: respond(MENTO_DASHBOARD_URL, MENTO_DASHBOARD_HTML_FIXTURE) },
      },
      nowSec: DASHBOARD_FRAGMENT_TS_SEC + 120,
    }).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(Error);
    for (const cause of ["HTTP 401", "HTTP 403", CATALOG_RESERVE_URL]) {
      expect((caught as Error).message).toContain(cause);
    }
  });

  it("degrades freshness when both dashboard identities fail", async () => {
    const rejectedIdentities = [`${MENTO_DASHBOARD_URL}:browser`, `${MENTO_DASHBOARD_URL}:neutral`];
    const respond = <T>(url: string, ok: T) =>
      (request: Request): T | { status: number; body: string } => {
        const identity = request.headers.get("origin") !== null ? "browser" : "neutral";
        if (rejectedIdentities.includes(`${url}:${identity}`)) {
          return { status: identity === "browser" ? 401 : 403, body: "denied" };
        }
        return ok;
      };

    const { result } = await runAdapter("mento", "cusd-celo", {
      network: {
        json: { [CATALOG_RESERVE_URL]: respond(CATALOG_RESERVE_URL, SAMPLE_PAYLOAD) },
        html: { [MENTO_DASHBOARD_URL]: respond(MENTO_DASHBOARD_URL, MENTO_DASHBOARD_HTML_FIXTURE) },
      },
      nowSec: DASHBOARD_FRAGMENT_TS_SEC + 120,
    });

    expect(result.metadata?.freshnessMode).toBe("unverified");
    expect(result.metadata).toMatchObject({ details: { freshnessSource: "mento-analytics-api" } });
    expectWarnings(result, ["mento-dashboard-timestamp-failed"]);
  });

  it("publishes the analytics-API composition degraded when dashboard and API CDP totals diverge", async () => {
    // Live 2026-09-09 discrepancy shape: the dashboard reports materially
    // different GBPm totals than the analytics API troves sum to.
    const { result } = await runAdapter("mento", "gbpm-mento", {
      network: mentoNetwork({
        dashboardHtml: dashboardHtmlWithCdpBackings([
          { stablecoin: "GBPm", collateral_token: "USDm", collateral_usd: 774_785.9598798637, debt_usd: 315_700.2296351052, status: "active" },
        ]),
      }),
      // The subject is the dashboard-vs-API gate, not the optional on-chain
      // redemption telemetry.
      params: { redemption: undefined },
      nowSec: OVERRIDE_DASHBOARD_NOW_SEC,
    });

    // Policy E4: both sources were readable, so the analytics-API composition
    // still publishes — degraded, carrying both sides' totals and the pct.
    expectWarningEffect(result, "mento-cdp-coherence-diverged", "degraded");
    expectWarnings(result, ["mento-cdp-coherence-diverged"]);
    expect(result.metadata).toMatchObject({
      cdpStablecoin: "GBPm",
      totalCollateralUsd: SAMPLE_CDP_TOTALS.GBPm.collateral_usd,
      totalDebtUsd: SAMPLE_CDP_TOTALS.GBPm.debt_usd,
      details: {
        cdpCoherenceDivergence: {
          dashboardCollateralUsd: 774_785.9598798637,
          dashboardDebtUsd: 315_700.2296351052,
          apiCollateralUsd: SAMPLE_CDP_TOTALS.GBPm.collateral_usd,
          apiDebtUsd: SAMPLE_CDP_TOTALS.GBPm.debt_usd,
        },
      },
    });
    expect(result.slices.length).toBeGreaterThan(0);
  });

  it("carries both sides' totals and the divergence pct in the coherence warning", async () => {
    const { result } = await runAdapter("mento", "gbpm-mento", {
      network: mentoNetwork({
        dashboardHtml: dashboardHtmlWithCdpBackings([
          { stablecoin: "GBPm", collateral_token: "USDm", collateral_usd: 774_785.9598798637, debt_usd: 315_700.2296351052, status: "active" },
        ]),
      }),
      params: { redemption: undefined },
      nowSec: OVERRIDE_DASHBOARD_NOW_SEC,
    });

    const warning = result.warnings?.find((candidate) => candidate.code === "mento-cdp-coherence-diverged");
    for (const value of ["774785.96", "315700.23", "213427.50", "102821.25"]) {
      expect(warning?.message).toContain(value);
    }
    expect(result.metadata?.details?.cdpCoherenceDivergence).toMatchObject({
      dashboardCollateralUsd: 774_785.9598798637,
      dashboardDebtUsd: 315_700.2296351052,
      apiCollateralUsd: SAMPLE_CDP_TOTALS.GBPm.collateral_usd,
      apiDebtUsd: SAMPLE_CDP_TOTALS.GBPm.debt_usd,
      collateralDivergencePct: expect.closeTo(72.45, 1),
      debtDivergencePct: expect.closeTo(67.43, 1),
    });
  });

  it.each([
    { stablecoin: "JPYm", coinId: "jpym-mento" },
    { stablecoin: "CHFm", coinId: "chfm-mento" },
  ] as const)("accepts $stablecoin when dashboard and API CDP totals agree to 8 decimals", async ({ stablecoin, coinId }) => {
    const { result } = await runAdapter("mento", coinId, {
      network: mentoNetwork({ dashboardHtml: sampleMatchingDashboardHtml(stablecoin) }),
      params: { redemption: undefined },
      nowSec: OVERRIDE_DASHBOARD_NOW_SEC,
    });

    const { collateral_usd: collateralUsd, debt_usd: debtUsd } = SAMPLE_CDP_TOTALS[stablecoin];
    expect(result.metadata).toMatchObject({
      freshnessMode: "verified",
      details: { freshnessSource: "same-run-render-clock" },
      cdpStablecoin: stablecoin,
      totalCollateralUsd: collateralUsd,
      totalDebtUsd: debtUsd,
      collateralizationRatio: collateralUsd / debtUsd,
    });
    expectWarnings(result, []);
  });

  it("degrades when the dashboard renames cdp_backings and the coherence gate cannot run", async () => {
    const renamedDashboard = sampleMatchingDashboardHtml("GBPm").replace("cdp_backings", "cdp_backing_rows");

    const { result } = await runAdapter("mento", "gbpm-mento", {
      network: mentoNetwork({ dashboardHtml: renamedDashboard }),
      params: { redemption: undefined },
      nowSec: OVERRIDE_DASHBOARD_NOW_SEC,
    });

    // The CDP composition still publishes, but the lost cross-check must be
    // surfaced as degraded — never silently skipped.
    expectWarningEffect(result, "mento-cdp-coherence-unavailable", "degraded");
    expect(result.metadata).toMatchObject({
      cdpStablecoin: "GBPm",
      totalCollateralUsd: SAMPLE_CDP_TOTALS.GBPm.collateral_usd,
    });
  });
});

describe("mento redemption telemetry", () => {
  it("computes broker-pool capacity from the catalog-bound pool and converts a 5 bps spread", async () => {
    const { result, network } = await runAdapter("mento", "brlm-mento", {
      network: mentoNetwork({
        rpc: {
          [exchangeIdsKey]: encodeExchangeIds([EXCHANGE_ID_1, EXCHANGE_ID_2]),
          [poolExchangeKey(EXCHANGE_ID_1)]: encodePoolExchange({
            asset0: BRLM_TOKEN_ADDRESS,
            asset1: USDM_ADDRESS,
            bucket0: 0n,
            bucket1: 1_000n * 10n ** 18n,
            // 5e20 of the 1e24 Fixidity scale = 5 bps.
            spread: 5n * 10n ** 20n,
          }),
          // A pool that matches no configured counter asset is skipped.
          [poolExchangeKey(EXCHANGE_ID_2)]: encodePoolExchange({
            asset0: USDT_ADDRESS,
            asset1: USDC_ADDRESS,
            bucket0: 5_000n * 10n ** 18n,
            bucket1: 0n,
            spread: 10n ** 22n,
          }),
        },
      }),
      nowSec: CURRENT_DASHBOARD_NOW_SEC,
    });

    const { coin } = resolveAdapterCoin("mento", "brlm-mento");
    const redemption = coin.liveReservesConfig!.params!.redemption! as { sourceUrls: string[] };
    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: 1_000,
      capacityKind: "live-direct-bounded",
      freshnessKind: "same-run-onchain",
      routeStatus: "open",
      routeStatusSource: "onchain",
      holderEligibility: "any-holder",
      settlementDelaySec: 0,
      feeBps: 5,
      sourceUrls: redemption.sourceUrls,
    });
    // Redemption telemetry is additive: the analytics-API reserve composition
    // is untouched.
    expect(result.slices).toHaveLength(9);
    expectWarnings(result, []);
    expect(network.rpcCalls.map(({ data }) => data)).toEqual([
      MENTO_GET_EXCHANGE_IDS_SELECTOR,
      `${MENTO_GET_POOL_EXCHANGE_SELECTOR}${EXCHANGE_ID_1.slice(2)}`,
    ]);
  });

  it("sums matched counter-asset buckets and takes the max spread as the fee", async () => {
    const { result } = await runAdapter("mento", "brlm-mento", {
      network: mentoNetwork({
        rpc: {
          [exchangeIdsKey]: encodeExchangeIds([EXCHANGE_ID_1, EXCHANGE_ID_2]),
          [poolExchangeKey(EXCHANGE_ID_1)]: encodePoolExchange({
            asset0: BRLM_TOKEN_ADDRESS,
            asset1: USDC_ADDRESS,
            bucket0: 0n,
            bucket1: 1_000n * 10n ** 18n,
            spread: 5n * 10n ** 20n,
          }),
          [poolExchangeKey(EXCHANGE_ID_2)]: encodePoolExchange({
            asset0: USDT_ADDRESS,
            asset1: BRLM_TOKEN_ADDRESS,
            bucket0: 2_500n * 10n ** 18n,
            bucket1: 0n,
            // 1e22 of the 1e24 Fixidity scale = 100 bps (1%).
            spread: 10n ** 22n,
          }),
        },
      }),
      params: {
        redemption: {
          kind: "broker-pool",
          pools: [
            { selfTokenAddress: BRLM_TOKEN_ADDRESS, counterAsset: { address: USDC_ADDRESS, label: "USDC" } },
            { selfTokenAddress: BRLM_TOKEN_ADDRESS, counterAsset: { address: USDT_ADDRESS, label: "USDT" } },
          ],
          sourceUrls: ["https://docs.mento.org/mento/build-on-mento/smart-contracts/bipoolmanager"],
        },
      },
      nowSec: CURRENT_DASHBOARD_NOW_SEC,
    });

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
    expect(result.slices).toHaveLength(9);
    expectWarnings(result, []);
  });

  it("caches broker reads separately and stops each coin once its configured pools match", async () => {
    const network = installAdapterNetwork({
      json: { [CATALOG_RESERVE_URL]: SAMPLE_PAYLOAD },
      html: { [MENTO_DASHBOARD_URL]: MENTO_DASHBOARD_HTML_FIXTURE },
      rpc: {
        [exchangeIdsKey]: encodeExchangeIds([EXCHANGE_ID_1, EXCHANGE_ID_2, EXCHANGE_ID_3]),
        [poolExchangeKey(EXCHANGE_ID_1)]: encodePoolExchange({
          asset0: USDM_ADDRESS,
          asset1: USDC_ADDRESS,
          bucket0: 0n,
          bucket1: 10n ** 18n,
          spread: 5n * 10n ** 20n,
        }),
        [poolExchangeKey(EXCHANGE_ID_2)]: null,
        [poolExchangeKey(EXCHANGE_ID_3)]: encodePoolExchange({
          asset0: USDT_ADDRESS,
          asset1: USDM_ADDRESS,
          bucket0: 2n * 10n ** 18n,
          bucket1: 0n,
          spread: 10n ** 22n,
        }),
      },
    });
    const requestCache = new Map<string, Promise<unknown>>();
    const ctx = directCtx(network, requestCache);

    const usdc = await fetchMentoReserves(
      { id: "cusd-celo" } as never,
      brokerPoolConfig("cusd-celo", [{ selfTokenAddress: USDM_ADDRESS, counterAssetAddress: USDC_ADDRESS }]),
      new AbortController().signal,
      ctx,
    );
    expect(usdc.metadata?.redemption).toMatchObject({ capacityUsd: 1, feeBps: 5 });
    expect(network.rpcCalls.map(({ data }) => data)).toEqual([
      MENTO_GET_EXCHANGE_IDS_SELECTOR,
      `${MENTO_GET_POOL_EXCHANGE_SELECTOR}${EXCHANGE_ID_1.slice(2)}`,
    ]);

    const usdt = await fetchMentoReserves(
      { id: "ceur-celo" } as never,
      brokerPoolConfig("cusd-celo", [{ selfTokenAddress: USDM_ADDRESS, counterAssetAddress: USDT_ADDRESS }]),
      new AbortController().signal,
      ctx,
    );
    // The exchange-id census and the already-decoded pool survive across coins;
    // the scan resumes at the first unread pool and stops at its match.
    expect(usdt.metadata?.redemption).toMatchObject({ capacityUsd: 2, feeBps: 100 });
    expect(network.rpcCalls.map(({ data }) => data)).toEqual([
      MENTO_GET_EXCHANGE_IDS_SELECTOR,
      `${MENTO_GET_POOL_EXCHANGE_SELECTOR}${EXCHANGE_ID_1.slice(2)}`,
      `${MENTO_GET_POOL_EXCHANGE_SELECTOR}${EXCHANGE_ID_2.slice(2)}`,
      `${MENTO_GET_POOL_EXCHANGE_SELECTOR}${EXCHANGE_ID_3.slice(2)}`,
    ]);
  });

  it("continues a broker scan after another coin times out without inheriting its rejected read", async () => {
    vi.useFakeTimers();
    try {
      let exchangeTwoAttempts = 0;
      const network = installAdapterNetwork({
        json: { [CATALOG_RESERVE_URL]: SAMPLE_PAYLOAD },
        html: { [MENTO_DASHBOARD_URL]: MENTO_DASHBOARD_HTML_FIXTURE },
        rpc: {
          [exchangeIdsKey]: encodeExchangeIds([EXCHANGE_ID_1, EXCHANGE_ID_2, EXCHANGE_ID_3]),
          [poolExchangeKey(EXCHANGE_ID_1)]: null,
          [poolExchangeKey(EXCHANGE_ID_2)]: () => {
            exchangeTwoAttempts += 1;
            if (exchangeTwoAttempts === 1) {
              return new Promise<never>((_resolve, reject) => {
                setTimeout(() => reject(new Error("broker read stalled")), 8_500);
              });
            }
            return null;
          },
          [poolExchangeKey(EXCHANGE_ID_3)]: encodePoolExchange({
            asset0: USDM_ADDRESS,
            asset1: USDC_ADDRESS,
            bucket0: 0n,
            bucket1: 10n ** 18n,
            spread: 5n * 10n ** 20n,
          }),
        },
      });
      const requestCache = new Map<string, Promise<unknown>>();
      const ctx = directCtx(network, requestCache);
      const config = brokerPoolConfig("cusd-celo", [{ selfTokenAddress: USDM_ADDRESS, counterAssetAddress: USDC_ADDRESS }]);

      const firstPromise = fetchMentoReserves(
        { id: "cusd-celo" } as never,
        config,
        new AbortController().signal,
        ctx,
      );
      await vi.advanceTimersByTimeAsync(8_000); // the redemption deadline fires
      await vi.advanceTimersByTimeAsync(1_000); // the stalled RPC read gives up
      const firstResult = await firstPromise;
      const secondResult = await fetchMentoReserves(
        { id: "ceur-celo" } as never,
        config,
        new AbortController().signal,
        ctx,
      );

      expect(firstResult.metadata?.redemption).toBeUndefined();
      expectWarnings(firstResult, ["mento-redemption-telemetry-failed"]);
      expect(secondResult.metadata?.redemption).toMatchObject({ capacityUsd: 1 });
      expect(network.rpcCalls.map(({ data }) => data)).toEqual([
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
    const { result, network } = await runAdapter("mento", "brlm-mento", {
      network: mentoNetwork({
        rpc: { [exchangeIdsKey]: encodeExchangeIds(oversizedExchangeIds) },
      }),
      nowSec: CURRENT_DASHBOARD_NOW_SEC,
    });

    expect(result.slices).toHaveLength(9);
    expect(result.metadata?.redemption).toBeUndefined();
    expectWarnings(result, ["mento-redemption-telemetry-failed"]);
    // The cap short-circuits before any per-pool reads.
    expect(network.rpcCalls).toHaveLength(1);
  });

  it("retains a failed exchange-id read for the run instead of retrying it per coin", async () => {
    const network = installAdapterNetwork({
      json: { [CATALOG_RESERVE_URL]: SAMPLE_PAYLOAD },
      html: { [MENTO_DASHBOARD_URL]: MENTO_DASHBOARD_HTML_FIXTURE },
      rpc: {
        [exchangeIdsKey]: () => {
          throw new Error("rpc down");
        },
      },
    });
    const requestCache = new Map<string, Promise<unknown>>();
    const ctx = directCtx(network, requestCache);
    const config = brokerPoolConfig("cusd-celo", [{ selfTokenAddress: USDM_ADDRESS, counterAssetAddress: USDC_ADDRESS }]);

    const first = await fetchMentoReserves(
      { id: "cusd-celo" } as never,
      config,
      new AbortController().signal,
      ctx,
    );
    const callsAfterFirstCoin = network.rpcCalls.length;
    const second = await fetchMentoReserves(
      { id: "ceur-celo" } as never,
      config,
      new AbortController().signal,
      ctx,
    );

    expectWarnings(first, ["mento-redemption-telemetry-failed"]);
    expectWarnings(second, ["mento-redemption-telemetry-failed"]);
    // The rejected census read is cached for the whole run: the second coin
    // adds no further RPC traffic.
    expect(network.rpcCalls).toHaveLength(callsAfterFirstCoin);
  });

  it("bounds optional redemption telemetry without discarding reserve composition", async () => {
    vi.useFakeTimers();
    try {
      const network = installAdapterNetwork({
        json: { [CATALOG_RESERVE_URL]: SAMPLE_PAYLOAD },
        html: { [MENTO_DASHBOARD_URL]: MENTO_DASHBOARD_HTML_FIXTURE },
        rpc: {
          [exchangeIdsKey]: () => new Promise<never>((_resolve, reject) => {
            setTimeout(() => reject(new Error("broker scan stalled")), 8_500);
          }),
        },
      });
      const resultPromise = fetchMentoReserves(
        { id: "cusd-celo" } as never,
        brokerPoolConfig("cusd-celo", [{ selfTokenAddress: USDM_ADDRESS, counterAssetAddress: USDC_ADDRESS }]),
        new AbortController().signal,
        directCtx(network, new Map()),
      );

      await vi.advanceTimersByTimeAsync(8_000); // the redemption deadline fires
      await vi.advanceTimersByTimeAsync(1_000); // the stalled RPC read gives up
      const result = await resultPromise;

      expect(result.slices).toHaveLength(9);
      expect(result.metadata?.redemption).toBeUndefined();
      expectWarnings(result, ["mento-redemption-telemetry-failed"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when the broker-pool onchain read fails, leaving reserve slices unaffected", async () => {
    const { result, network } = await runAdapter("mento", "brlm-mento", {
      network: mentoNetwork({
        rpc: {
          [exchangeIdsKey]: () => {
            throw new Error("rpc down");
          },
        },
      }),
      nowSec: CURRENT_DASHBOARD_NOW_SEC,
    });

    expect(result.slices).toHaveLength(9);
    expect(result.metadata?.redemption).toBeUndefined();
    expectWarnings(result, ["mento-redemption-telemetry-failed"]);
    // Fails closed at the census read; no per-pool reads are attempted.
    expect(network.rpcCalls.some(({ data }) => data.startsWith(MENTO_GET_POOL_EXCHANGE_SELECTOR))).toBe(false);
  });

  it("computes liquity-v2-cr capacity ratio and fee for the GBPm CDP branch", async () => {
    const { coin } = resolveAdapterCoin("mento", "gbpm-mento");
    const liquity = coin.liveReservesConfig!.params!.redemption! as {
      collateralRegistryAddress: string;
      troveManagerAddress: string;
      activePoolAddress: string;
      tokenAddress: string;
      sourceUrls: string[];
    };

    const { result } = await runAdapter("mento", "gbpm-mento", {
      network: mentoNetwork({
        dashboardHtml: sampleMatchingDashboardHtml("GBPm"),
        rpc: {
          [`celo:${liquity.activePoolAddress.toLowerCase()}:${LIQUITY_V2_DEBT_SELECTOR}`]: 500n * 10n ** 18n,
          [`celo:${liquity.troveManagerAddress.toLowerCase()}:${LIQUITY_V2_SHUTDOWN_SELECTOR}`]: `0x${"0".repeat(64)}`,
          // 5e15 of the 18-decimal rate scale = 50 bps.
          [`celo:${liquity.collateralRegistryAddress.toLowerCase()}:${LIQUITY_V2_REDEMPTION_RATE_SELECTOR}`]: 5n * 10n ** 15n,
          [`celo:${liquity.tokenAddress.toLowerCase()}:totalSupply()`]: 1_000n * 10n ** 18n,
        },
      }),
      nowSec: OVERRIDE_DASHBOARD_NOW_SEC,
    });

    expect(result.metadata?.redemption).toMatchObject({
      capacityRatioOfSupply: 0.5,
      capacityKind: "live-direct-bounded",
      freshnessKind: "same-run-onchain",
      routeStatus: "open",
      routeStatusSource: "onchain",
      feeBps: 50,
      sourceUrls: liquity.sourceUrls,
    });
    expect(result.slices).toHaveLength(1);
    expectWarnings(result, []);
  });

  it("fails closed when the liquity-v2-cr onchain read fails, leaving reserve slices unaffected", async () => {
    const liquity = resolveAdapterCoin("mento", "gbpm-mento").coin.liveReservesConfig!.params!.redemption! as {
      collateralRegistryAddress: string;
      troveManagerAddress: string;
      activePoolAddress: string;
      tokenAddress: string;
    };

    const { result } = await runAdapter("mento", "gbpm-mento", {
      network: mentoNetwork({
        dashboardHtml: sampleMatchingDashboardHtml("GBPm"),
        rpc: {
          [`celo:${liquity.activePoolAddress.toLowerCase()}:${LIQUITY_V2_DEBT_SELECTOR}`]: null,
          [`celo:${liquity.troveManagerAddress.toLowerCase()}:${LIQUITY_V2_SHUTDOWN_SELECTOR}`]: null,
          [`celo:${liquity.collateralRegistryAddress.toLowerCase()}:${LIQUITY_V2_REDEMPTION_RATE_SELECTOR}`]: null,
          [`celo:${liquity.tokenAddress.toLowerCase()}:totalSupply()`]: null,
        },
      }),
      nowSec: OVERRIDE_DASHBOARD_NOW_SEC,
    });

    expect(result.slices).toHaveLength(1);
    expect(result.metadata?.redemption).toBeUndefined();
    expectWarnings(result, ["mento-redemption-telemetry-failed"]);
  });

  it("computes fpmm-pool capacity and fee from the pool's USDm balance and swap fees", async () => {
    const fpmm = resolveAdapterCoin("mento", "jpym-mento").coin.liveReservesConfig!.params!.redemption! as {
      poolAddress: string;
      usdmTokenAddress: string;
    };

    const { result } = await runAdapter("mento", "jpym-mento", {
      network: mentoNetwork({
        dashboardHtml: sampleMatchingDashboardHtml("JPYm"),
        rpc: {
          [`celo:${fpmm.usdmTokenAddress.toLowerCase()}:balanceOf(address)`]: 750n * 10n ** 18n,
          [`celo:${fpmm.poolAddress.toLowerCase()}:${FPMM_LP_FEE_SELECTOR}`]: 20n,
          [`celo:${fpmm.poolAddress.toLowerCase()}:${FPMM_PROTOCOL_FEE_SELECTOR}`]: 10n,
        },
      }),
      nowSec: OVERRIDE_DASHBOARD_NOW_SEC,
    });

    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: 750,
      capacityKind: "live-direct-bounded",
      freshnessKind: "same-run-onchain",
      routeStatus: "open",
      feeBps: 30,
    });
    expect(result.slices).toHaveLength(1);
    expectWarnings(result, []);
  });

  it("keeps fpmm-pool capacity but omits the fee when a fee leg does not read", async () => {
    const fpmm = resolveAdapterCoin("mento", "jpym-mento").coin.liveReservesConfig!.params!.redemption! as {
      poolAddress: string;
      usdmTokenAddress: string;
    };

    const { result } = await runAdapter("mento", "jpym-mento", {
      network: mentoNetwork({
        dashboardHtml: sampleMatchingDashboardHtml("JPYm"),
        rpc: {
          [`celo:${fpmm.usdmTokenAddress.toLowerCase()}:balanceOf(address)`]: 750n * 10n ** 18n,
          [`celo:${fpmm.poolAddress.toLowerCase()}:${FPMM_LP_FEE_SELECTOR}`]: 20n,
          [`celo:${fpmm.poolAddress.toLowerCase()}:${FPMM_PROTOCOL_FEE_SELECTOR}`]: null,
        },
      }),
      nowSec: OVERRIDE_DASHBOARD_NOW_SEC,
    });

    expect(result.metadata?.redemption).toMatchObject({ capacityUsd: 750 });
    expect(result.metadata?.redemption?.feeBps).toBeUndefined();
  });

  it("fails closed when the fpmm-pool balance read fails, leaving reserve slices unaffected", async () => {
    const fpmm = resolveAdapterCoin("mento", "chfm-mento").coin.liveReservesConfig!.params!.redemption! as {
      poolAddress: string;
      usdmTokenAddress: string;
    };

    const { result } = await runAdapter("mento", "chfm-mento", {
      network: mentoNetwork({
        dashboardHtml: sampleMatchingDashboardHtml("CHFm"),
        rpc: {
          [`celo:${fpmm.usdmTokenAddress.toLowerCase()}:balanceOf(address)`]: null,
          [`celo:${fpmm.poolAddress.toLowerCase()}:${FPMM_LP_FEE_SELECTOR}`]: 20n,
          [`celo:${fpmm.poolAddress.toLowerCase()}:${FPMM_PROTOCOL_FEE_SELECTOR}`]: 10n,
        },
      }),
      nowSec: OVERRIDE_DASHBOARD_NOW_SEC,
    });

    expect(result.slices).toHaveLength(1);
    expect(result.metadata?.redemption).toBeUndefined();
    expectWarnings(result, ["mento-redemption-telemetry-failed"]);
  });
});
