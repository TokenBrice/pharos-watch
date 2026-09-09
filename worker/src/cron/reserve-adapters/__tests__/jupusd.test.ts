import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { StablecoinMeta } from "@shared/types/core";
import { adaptJupUsdData, fetchJupUsdReserves } from "../jupusd";
import { expectValidAdapterOutput } from "./reserve-adapter.test-support";

vi.mock("../../../lib/fetch-retry", async () => {
  // The adapter imports this mocked dependency before top-level helper imports initialize.
  const { mockFetchRetry } = await import("../../../test-helpers/cron");
  return mockFetchRetry({ fetchWithRetry: vi.fn() });
});
import { fetchWithRetry } from "../../../lib/fetch-retry";

const unexpectedRequests: unknown[] = [];
afterEach(() => {
  const unexpected = unexpectedRequests.splice(0);
  vi.resetAllMocks();
  expect(unexpected).toEqual([]);
});

describe("adaptJupUsdData", () => {
  it("rejects drift removing totalSupply", () => {
    const payload = {
      totalSupply: "1000000",
      holdings: [{ name: "USDC", amount: "1000000", decimals: 6 }],
    };
    Reflect.deleteProperty(payload, "totalSupply");
    expect(() => adaptJupUsdData(payload)).toThrow(/totalSupply/);
  });

  it("groups published JupUSD holdings and emits whitelisted redemption capacity", () => {
    const result = adaptJupUsdData({
      totalSupply: "75000000000000",
      holdings: [
        { name: "USDC", amount: "1000000000000", decimals: 6, type: "program" },
        { name: "USDC", amount: "500000000000", decimals: 6, type: "anchorage" },
        { name: "USDtb", amount: "6000000000000", decimals: 6, type: "anchorage" },
      ],
    }, {
      sourceTimestamp: 1776261612,
      oracle: { ripcord: false },
    });

    expect(result.slices).toEqual([
      { sourceKey: "jupusd:usdtb", name: "USDtb", pct: 80, risk: "low", coinId: "usdtb-ethena", depType: "collateral" },
      { sourceKey: "jupusd:usdc", name: "USDC", pct: 20, risk: "low", coinId: "usdc-circle", depType: "collateral" },
    ]);
    expect(result.metadata).toMatchObject({
      totalReserveUsd: 7_500_000,
      supplyUsd: 75_000_000,
      collateralizationRatio: 0.1,
      unknownExposurePct: 0,
      freshnessMode: "verified",
      sourceTimestamp: 1776261612,
      redemption: {
        capacityUsd: 7_500_000,
        capacityRatioOfSupply: 0.1,
        capacityKind: "live-direct-bounded",
        freshnessKind: "verified-source-timestamp",
        sourceTimestamp: 1776261612,
        routeStatus: "open",
        routeStatusSource: "protocol-api",
        holderEligibility: "whitelisted-primary",
      },
    });
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "reserve-undercollateralized",
      effect: "degraded",
    }));
    expectValidAdapterOutput("jupusd", result, { now: 1776262000 });
  });

  it("marks route paused when the oracle reports ripcord mode", () => {
    const result = adaptJupUsdData({
      totalSupply: "1000000",
      holdings: [{ name: "USDC", amount: "1000000", decimals: 6 }],
    }, {
      oracle: { ripcord: true, ripcordDetails: "manual stop" },
    });

    expect(result.metadata?.redemption).toMatchObject({
      routeStatus: "paused",
      routeStatusReason: "manual stop",
    });
  });

  it("keeps unknown holdings explicit instead of defaulting them to medium risk", () => {
    const result = adaptJupUsdData({
      totalSupply: "100000000",
      holdings: [
        { name: "USDC", amount: "99000000", decimals: 6 },
        { name: "MYSTERY", amount: "1000000", decimals: 6 },
      ],
    });

    expect(result.slices).toEqual([
      { sourceKey: "jupusd:usdc", name: "USDC", pct: 99, risk: "low", coinId: "usdc-circle", depType: "collateral" },
      { sourceKey: "jupusd:unknown", name: "Unmapped JupUSD reserve holdings", pct: 1, risk: "high" },
    ]);
    expect(result.warnings?.[0]).toMatchObject({
      code: "unknown-holding",
      effect: "info",
    });
    expect(result.metadata).toMatchObject({
      unknownExposurePct: 1,
      unknownHoldingNames: ["MYSTERY"],
    });
  });

  it("degrades material unknown holdings", () => {
    const result = adaptJupUsdData({
      totalSupply: "100000000",
      holdings: [
        { name: "USDC", amount: "90000000", decimals: 6 },
        { name: "MYSTERY", amount: "10000000", decimals: 6 },
      ],
    });

    expect(result.warnings?.[0]).toMatchObject({
      code: "unknown-holding",
      effect: "degraded",
    });
    expect(result.metadata?.unknownExposurePct).toBe(10);
  });

  it("converts large raw integer holdings through bounded decimal parsing", () => {
    const result = adaptJupUsdData({
      totalSupply: "100000000000000000",
      holdings: [
        {
          name: "USDC",
          amount: "100000000000000000000000123456",
          decimals: 18,
        },
      ],
    });

    expect(result.metadata?.totalReserveUsd).toBe(100_000_000_000);
    expect(result.slices).toEqual([
      { sourceKey: "jupusd:usdc", name: "USDC", pct: 100, risk: "low", coinId: "usdc-circle", depType: "collateral" },
    ]);
  });

  it("ignores provider amounts with unsafe decimal scales", () => {
    const result = adaptJupUsdData({
      totalSupply: "1000000",
      holdings: [
        { name: "USDC", amount: "1000000", decimals: 6 },
        { name: "USDtb", amount: "1", decimals: 1_000_000_000 },
      ],
    });

    expect(result.metadata?.totalReserveUsd).toBe(1);
    expect(result.slices).toEqual([
      { sourceKey: "jupusd:usdc", name: "USDC", pct: 100, risk: "low", coinId: "usdc-circle", depType: "collateral" },
    ]);
  });

  it("passes through extra warnings from the fetch layer", () => {
    const result = adaptJupUsdData(
      {
        totalSupply: "1000000",
        holdings: [{ name: "USDC", amount: "1000000", decimals: 6 }],
      },
      {
        extraWarnings: [
          { code: "jupusd-snapshots-unavailable", message: "x", severity: "info", effect: "info" },
        ],
      },
    );

    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "jupusd-snapshots-unavailable", effect: "info" }),
    ]);
  });
});

describe("fetchJupUsdReserves", () => {
  const coin = { id: "jupusd" } as StablecoinMeta;
  const baseUrl = "https://api.jupusd.money/api/data";
  const snapshotsUrl = "https://api.jupusd.money/api/snapshots";
  const oracleUrl = "https://api.jupusd.money/api/oracle";
  const dataPayload = {
    totalSupply: "1000000",
    holdings: [{ name: "USDC", amount: "1000000", decimals: 6 }],
  };

  function makeConfig(): LiveReservesConfig {
    return {
      adapter: "jupusd",
      version: 1,
      semantics: "collateral-mix",
      inputs: { primary: { kind: "http-json", url: baseUrl } },
      params: { snapshotsUrl, oracleUrl },
    };
  }

  function mockTransport(
    failedUrl?: string,
    error?: Error,
    snapshotsPayload: { snapshots?: Array<{ timestamp?: string | number }> } = { snapshots: [{ timestamp: 1776000000 }] },
  ) {
    vi.mocked(fetchWithRetry).mockImplementation(async (url) => {
      if (url === failedUrl) throw error;
      if (url === baseUrl) return Response.json(dataPayload);
      if (url === snapshotsUrl) return Response.json(snapshotsPayload);
      if (url === oracleUrl) return Response.json({ ripcord: false });
      unexpectedRequests.push(url);
      throw new Error(`Unexpected JupUSD request: ${url}`);
    });
    return new Map<string, Promise<unknown>>();
  }

  it("emits jupusd-snapshots-unavailable info warning when snapshots feed fails", async () => {
    const cache = mockTransport(snapshotsUrl, new Error("snapshots http 503"));

    const result = await fetchJupUsdReserves(
      coin,
      makeConfig(),
      new AbortController().signal,
      { requestCache: cache } as never,
    );

    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "jupusd-snapshots-unavailable",
        effect: "info",
        message: expect.stringContaining("jupusd snapshots fetch failed: snapshots http 503"),
      }),
    ]));
  });

  it("emits jupusd-oracle-unavailable info warning when oracle feed fails", async () => {
    const cache = mockTransport(oracleUrl, new Error("oracle http 502"));

    const result = await fetchJupUsdReserves(
      coin,
      makeConfig(),
      new AbortController().signal,
      { requestCache: cache } as never,
    );

    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "jupusd-oracle-unavailable",
        effect: "info",
        message: expect.stringContaining("jupusd oracle fetch failed: oracle http 502"),
      }),
    ]));
  });

  it("emits no warnings when both snapshots and oracle succeed", async () => {
    const cache = mockTransport();

    const result = await fetchJupUsdReserves(
      coin,
      makeConfig(),
      new AbortController().signal,
      { requestCache: cache } as never,
    );

    expect(result.warnings).toBeUndefined();
  });

  it("takes the newest snapshot timestamp instead of trusting snapshots[0] ordering", async () => {
    const cache = mockTransport(undefined, undefined, {
      snapshots: [
        { timestamp: 1775900000 },
        { timestamp: "1776100000" },
        { timestamp: 1776000000 },
      ],
    });

    const result = await fetchJupUsdReserves(
      coin,
      makeConfig(),
      new AbortController().signal,
      { requestCache: cache } as never,
    );

    expect(result.metadata?.sourceTimestamp).toBe(1776100000);
    expect(result.metadata?.freshnessMode).toBe("verified");
  });

  it("labels core transparency data fetch failures with the failing fetch", async () => {
    const cache = mockTransport(baseUrl, new Error("Fetch failed for https://api.jupusd.money/api/data"));

    await expect(fetchJupUsdReserves(
      coin,
      makeConfig(),
      new AbortController().signal,
      { requestCache: cache } as never,
    )).rejects.toThrow(
      "jupusd transparency data fetch failed: Fetch failed for https://api.jupusd.money/api/data",
    );
  });

  it("rethrows the original error untouched when the adapter attempt signal aborted", async () => {
    const abortError = new Error("adapter-timeout");
    const cache = mockTransport(baseUrl, abortError);
    const controller = new AbortController();
    controller.abort(abortError);

    await expect(fetchJupUsdReserves(
      coin,
      makeConfig(),
      controller.signal,
      { requestCache: cache } as never,
    )).rejects.toBe(abortError);
  });
});
