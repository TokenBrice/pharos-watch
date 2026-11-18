import { describe, expect, it } from "vitest";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import { adaptJupUsdData } from "../jupusd";
import { runAdapter, runAdapterWithFakeTimers } from "./reserve-adapter.test-support";

describe("adaptJupUsdData", () => {
  it.each([
    ["100000000000000", 1, false],
    ["120000000000000", 100 / 120, true],
  ] as const)("groups the reserve book without claiming payout capacity for supply %s", (totalSupply, ratio, shortfall) => {
    const result = adaptJupUsdData({
      totalSupply,
      holdings: [
        { name: "USDC", amount: "1000000000000", decimals: 6, type: "program" },
        { name: "USDC", amount: "9000000000000", decimals: 6, type: "anchorage" },
        { name: "USDtb", amount: "90000000000000", decimals: 6, type: "anchorage" },
      ],
    }, {
      oracle: { ripcord: false },
    });

    expect(result.slices).toEqual([
      { sourceKey: "jupusd:usdtb", name: "USDtb", pct: 90, risk: "low", coinId: "usdtb-ethena", depType: "collateral" },
      { sourceKey: "jupusd:usdc", name: "USDC", pct: 10, risk: "low", coinId: "usdc-circle", depType: "collateral" },
    ]);
    expect(result.metadata).toMatchObject({
      totalReserveUsd: 100_000_000,
      supplyUsd: Number(totalSupply) / 1_000_000,
      collateralizationRatio: ratio,
      unknownExposurePct: 0,
      redemption: {
        routeStatus: "open",
        routeStatusSource: "protocol-api",
        holderEligibility: "whitelisted-primary",
      },
    });
    expect(result.metadata?.redemption).not.toHaveProperty("capacityUsd");
    expect(result.metadata?.redemption).not.toHaveProperty("capacityRatioOfSupply");
    expect(result.metadata?.redemption).not.toHaveProperty("capacityKind");
    expect(result.warnings?.some((warning) =>
      warning.code === "reserve-undercollateralized" && warning.effect === "degraded") ?? false).toBe(shortfall);
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

  it("attributes no live source when the oracle is configured but unread or absent", () => {
    for (const options of [{ oracleUrl: "https://api.jupusd.money/api/oracle", oracle: null }, {}]) {
      const result = adaptJupUsdData({
        totalSupply: "1000000",
        holdings: [{ name: "USDC", amount: "1000000", decimals: 6 }],
      }, options);
      expect(result.metadata?.redemption).toMatchObject({
        routeStatus: "unknown",
        routeStatusSource: "static-config",
      });
      expect(result.metadata?.redemption).not.toHaveProperty("routeObserved");
    }
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

  it.each([
    ["missing", undefined],
    ["negative", -1],
    ["fractional", 1.5],
    ["out of bounds", 1_000_000_000],
  ] as const)("withholds all replacement evidence when a holding decimal scale is %s", (_label, decimals) => {
    const result = adaptJupUsdData({
      totalSupply: "1000000000",
      holdings: [
        { name: "USDtb", amount: "1000000000", decimals: 6 },
        { name: "USDC", amount: "1000000000", ...(decimals !== undefined ? { decimals } : {}) },
      ],
    });

    expect(result.metadata).not.toHaveProperty("totalReserveUsd");
    expect(result.metadata).not.toHaveProperty("collateralizationRatio");
    expect(result.metadata).not.toHaveProperty("unknownExposurePct");
    expect(result.metadata).not.toHaveProperty("supplyUsd");
    expect(result.metadata).not.toHaveProperty("redemption");
    expect(result.metadata?.details).toMatchObject({
      measuredHoldingsUsd: 1000, unavailableHoldingNames: ["1:USDC"],
    });
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "holdings-incomplete", effect: "fatal",
    }));
    expect(result.slices).toEqual([]);
  });

  it.each([0, 6])("preserves an explicitly supplied %s decimal scale", (decimals) => {
    const result = adaptJupUsdData({
      totalSupply: "1000000000",
      holdings: [{ name: "USDC", amount: decimals === 0 ? "1000" : "1000000000", decimals }],
    });

    expect(result.metadata).toMatchObject({
      totalReserveUsd: 1000,
      supplyUsd: 1000,
      collateralizationRatio: 1,
      unknownExposurePct: 0,
    });
    expect(result.warnings).toBeUndefined();
  });

  it("withholds a sole unscaled USDC holding instead of publishing its raw integer as USD", () => {
    const result = adaptJupUsdData({
      totalSupply: "1000000000",
      holdings: [{ name: "USDC", amount: "1000000000" }],
    });
    expect(result.slices).toEqual([]);
    expect(result.metadata?.details).toMatchObject({ measuredHoldingsUsd: 0, unavailableHoldingNames: ["0:USDC"] });
  });

  it("retains readable unknown holdings only as diagnostics when the whole book is incomplete", () => {
    const result = adaptJupUsdData({
      totalSupply: "1000000000",
      holdings: [
        { name: "USDC", amount: "1000000000" },
        { name: "MYSTERY", amount: "1000000000", decimals: 6 },
      ],
    });

    expect(result.metadata).not.toHaveProperty("unknownExposurePct");
    expect(result.metadata).not.toHaveProperty("totalReserveUsd");
    expect(result.slices).toEqual([]);
    expect(result.metadata).not.toHaveProperty("redemption");
    expect(result.metadata?.details).toMatchObject({
      measuredHoldingsUsd: 1000,
      measuredHoldings: [{ name: "Unmapped JupUSD reserve holdings", value: 1000, unknown: true }],
    });
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "holdings-incomplete", effect: "fatal",
    }));
  });

  it("distinguishes measured zero holdings from unavailable amounts", () => {
    const result = adaptJupUsdData({
      totalSupply: "1000000000",
      holdings: [
        { name: "USDC", amount: "1000000000", decimals: 6 },
        { name: "USDtb", amount: "0", decimals: 6 },
      ],
    });
    expect(result.metadata?.totalReserveUsd).toBe(1000);
    expect(result.slices).toEqual([
      { sourceKey: "jupusd:usdc", name: "USDC", pct: 100, risk: "low", coinId: "usdc-circle", depType: "collateral" },
    ]);
    expect(result.warnings).toBeUndefined();
  });

  it.each([undefined, "-1", "bad"])("withholds unreadable holding amount %s", (amount) => {
    const result = adaptJupUsdData({
      totalSupply: "1000000000",
      holdings: [
        { name: "USDC", amount: "1000000000", decimals: 6 },
        { name: "USDtb", amount, decimals: 6 },
      ],
    });
    expect(result.slices).toEqual([]);
    expect(result.metadata?.details).toMatchObject({ unavailableHoldingNames: ["1:USDtb"], measuredHoldingsUsd: 1000 });
    expect(result.metadata).not.toHaveProperty("redemption");
  });

  it("distinguishes an unavailable holdings census from an observed empty book", () => {
    const result = adaptJupUsdData({ totalSupply: "1000000000" });
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "holdings-incomplete", effect: "fatal" }));
    expect(result.metadata?.details).toMatchObject({ unavailableHoldingNames: ["holdings"] });
    expect(() => adaptJupUsdData({ totalSupply: "1000000000", holdings: [] })).toThrow("zero reserve holdings");
  });

});

describe("fetchJupUsdReserves", () => {
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
      version: 2,
      semantics: "collateral-mix",
      inputs: { primary: { kind: "http-json", url: baseUrl } },
      params: { snapshotsUrl, oracleUrl },
    };
  }

  function makeCoin(): StablecoinMeta {
    return { id: "jupusd", liveReservesConfig: makeConfig() } as unknown as StablecoinMeta;
  }

  function network(
    options: {
      data?: unknown;
      snapshots?: unknown;
      oracle?: unknown;
    } = {},
  ) {
    return {
      json: {
        [baseUrl]: options.data ?? dataPayload,
        [snapshotsUrl]: options.snapshots ?? { snapshots: [{ timestamp: 1776000000 }] },
        [oracleUrl]: options.oracle ?? { ripcord: false },
      },
    };
  }

  it("rejects replacement at the HTTP boundary for an unscaled holding", async () => {
    const { result, report } = await runAdapter("jupusd", makeCoin(), {
      network: network({
        data: {
          totalSupply: "1000000000",
          holdings: [
            { name: "USDC", amount: "1000000000" },
            { name: "USDtb", amount: "1000000000", decimals: 6 },
          ],
        },
      }),
      nowSec: 1_776_003_600,
      validate: false,
    });

    expect(result.metadata).not.toHaveProperty("totalReserveUsd");
    expect(result.metadata).not.toHaveProperty("collateralizationRatio");
    expect(report.valid).toBe(false);
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "holdings-incomplete", effect: "fatal",
    }));
    expect(result.slices).toEqual([]);
    expect(result.metadata).not.toHaveProperty("redemption");
  });

  it("marks route unknown and degrades when the configured oracle probe fails", async () => {
    const { result } = await runAdapterWithFakeTimers(() => runAdapter("jupusd", makeCoin(), {
      network: network({ oracle: { status: 502, body: "oracle unavailable" } }),
      nowSec: 1_776_003_600,
    }));

    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "jupusd-oracle-unavailable",
        effect: "degraded",
      }),
    ]));
    expect(result.metadata?.redemption).toMatchObject({
      routeStatus: "unknown",
      routeStatusSource: "static-config",
    });
    expect(result.metadata?.redemption).not.toHaveProperty("routeObserved");
  });

  it.each([
    ["an empty object", {}],
    ["an error object", { error: "maintenance" }],
    ["a null ripcord", { ripcord: null }],
  ])("marks route unknown and degrades for %s oracle response", async (_label, oracle) => {
    const { result } = await runAdapter("jupusd", makeCoin(), {
      network: network({ oracle }),
      nowSec: 1_776_003_600,
    });

    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "jupusd-oracle-unavailable",
        effect: "degraded",
      }),
    ]));
    expect(result.metadata?.redemption).toMatchObject({
      routeStatus: "unknown",
      routeStatusSource: "static-config",
    });
    expect(result.metadata?.redemption).not.toHaveProperty("routeObserved");
  });

  it.each([
    [false, "open"],
    [true, "paused"],
  ] as const)("publishes route status %s only from a boolean oracle response", async (ripcord, routeStatus) => {
    const { result } = await runAdapter("jupusd", makeCoin(), {
      network: network({ oracle: { ripcord } }),
      nowSec: 1_776_003_600,
    });

    expect(result.warnings).toBeUndefined();
    expect(result.metadata?.redemption).toMatchObject({
      routeStatus,
      routeStatusSource: "protocol-api",
      sourceUrls: [oracleUrl],
    });
  });

  it("does not use independently fetched history to date the reserve book", async () => {
    const { result, network: observed } = await runAdapter("jupusd", makeCoin(), {
      network: network({
        snapshots: {
          snapshots: [
            { timestamp: 1775900000 },
            { timestamp: "1776100000" },
            { timestamp: 1776000000 },
          ],
        },
      }),
      nowSec: 1_776_103_600,
    });

    expect(result.metadata).toMatchObject({
      freshnessMode: "unverified",
      details: { freshnessSource: "jupusd-transparency-api", freshnessReason: expect.any(String) },
    });
    expect(result.metadata).not.toHaveProperty("sourceTimestamp");
    expect(result.metadata?.redemption).not.toHaveProperty("sourceTimestamp");
    expect(observed.requests).not.toContainEqual(expect.objectContaining({ url: snapshotsUrl }));
  });

  it("labels core transparency data fetch failures with the failing fetch", async () => {
    await expect(runAdapterWithFakeTimers(() => runAdapter("jupusd", makeCoin(), {
      network: network({ data: { status: 500, body: "data unavailable" } }),
      nowSec: 1_776_003_600,
    }))).rejects.toThrow(/transparency data fetch failed/);
  });

  it("rethrows the original error untouched when the adapter attempt signal aborted", async () => {
    const abortError = new Error("adapter-timeout");
    const controller = new AbortController();
    controller.abort(abortError);

    await expect(runAdapter("jupusd", makeCoin(), {
      network: network({ data: () => { throw abortError; } }),
      signal: controller.signal,
      nowSec: 1_776_003_600,
    })).rejects.toBe(abortError);
  });
});
