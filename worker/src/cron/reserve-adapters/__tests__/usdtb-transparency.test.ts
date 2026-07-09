import { describe, expect, it, vi, beforeEach } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return {
    ...actual,
    fetchJsonWithRetry: vi.fn(),
  };
});

import {
  adaptUsdtbTransparency,
  fetchUsdtbTransparencyReserves,
  type UsdtbBackingAndSupplyPayload,
} from "../usdtb-transparency";
import { fetchJsonWithRetry } from "../helpers";
import { validateAdapterOutput } from "../validate";
import { getReserveAdapter } from "../index";

const signal = AbortSignal.timeout(5000);

function makeCoin(): StablecoinMeta {
  return { id: "usdtb-ethena", name: "Ethena USDtb", ticker: "USDTB" } as unknown as StablecoinMeta;
}

function makeConfig(): LiveReservesConfig {
  return {
    adapter: "usdtb-transparency",
    version: 1,
    semantics: "collateral-mix",
    inputs: {
      primary: { kind: "http-json", url: "https://usdtb.money/api/transparency/backing-and-supply/current" },
    },
  } as unknown as LiveReservesConfig;
}

// Captured 2026-07-09 from GET https://usdtb.money/api/transparency/backing-and-supply/current
const USDTB_BACKING: UsdtbBackingAndSupplyPayload = {
  assetsInMotion: 9115451.68,
  backingAssets: {
    BUIDL: [{ amount: 767603510.39, custodian: "0x2004F7f7B600d962170d7f28114Cc123c5e98451" }],
    "BUIDL-I": [{ amount: 0, custodian: "0x2004F7f7B600d962170d7f28114Cc123c5e98451" }],
    USDC: [{ amount: 0.000458, custodian: "0x2004F7f7B600d962170d7f28114Cc123c5e98451" }],
    USDT: [{ amount: 0, custodian: "0x2004F7f7B600d962170d7f28114Cc123c5e98451" }],
    USDtb: [{ amount: 0, custodian: "0x2004F7f7B600d962170d7f28114Cc123c5e98451" }],
  },
  lastUpdatedAt: "2026-07-09T16:08:11.000Z",
  supply: 775334449.6661826,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("adaptUsdtbTransparency", () => {
  it("maps BUIDL and assets-in-motion into slices, drops zero-amount assets, and computes the honest ratio", () => {
    const result = adaptUsdtbTransparency(USDTB_BACKING);

    expect(result.slices).toEqual([
      { name: "BlackRock BUIDL (U.S. T-Bills, cash, repos)", pct: 98.8, risk: "low", coinId: "buidl-blackrock" },
      { name: "Assets in motion (settlement float)", pct: 1.2, risk: "low" },
    ]);
    expect(result.warnings).toBeUndefined();

    const totalReserveUsd = 767603510.39 + 0.000458 + 9115451.68;
    expect(result.metadata).toMatchObject({
      sourceTimestamp: Math.floor(Date.parse("2026-07-09T16:08:11.000Z") / 1000),
      freshnessMode: "verified",
      supplyUsd: 775334449.6661826,
      details: { lastUpdatedAt: "2026-07-09T16:08:11.000Z" },
    });
    expect(result.metadata?.totalReserveUsd).toBeCloseTo(totalReserveUsd, 3);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(totalReserveUsd / 775334449.6661826, 9);
  });

  it("emits an info warning when USDtb reports nonzero self-holdings and excludes them from backing", () => {
    const withSelfHolding: UsdtbBackingAndSupplyPayload = {
      ...USDTB_BACKING,
      backingAssets: {
        ...USDTB_BACKING.backingAssets,
        USDtb: [{ amount: 5_000_000, custodian: "0x2004F7f7B600d962170d7f28114Cc123c5e98451" }],
      },
    };

    const result = adaptUsdtbTransparency(withSelfHolding);

    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "usdtb-self-holding-excluded",
        severity: "info",
        effect: "info",
      }),
    ]);
    // Self-holdings never appear as a slice and never enter totalReserveUsd.
    expect(result.slices.some((slice) => slice.name.includes("USDtb"))).toBe(false);
    const totalReserveUsd = 767603510.39 + 0.000458 + 9115451.68;
    expect(result.metadata?.totalReserveUsd).toBeCloseTo(totalReserveUsd, 3);
  });

  it("degrades-warns and buckets an unmapped backing asset instead of failing closed", () => {
    const withUnknownAsset: UsdtbBackingAndSupplyPayload = {
      ...USDTB_BACKING,
      backingAssets: {
        ...USDTB_BACKING.backingAssets,
        DAI: [{ amount: 1_000_000, custodian: "0x2004F7f7B600d962170d7f28114Cc123c5e98451" }],
      },
    };

    const result = adaptUsdtbTransparency(withUnknownAsset);

    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "unknown-asset", severity: "warning", effect: "degraded" }),
    ]);
    expect(result.slices).toContainEqual(
      expect.objectContaining({ name: "DAI (unmapped)", risk: "high" }),
    );
  });

  it("throws when backingAssets is missing", () => {
    expect(() => adaptUsdtbTransparency({ ...USDTB_BACKING, backingAssets: undefined }))
      .toThrow("missing backingAssets");
  });

  it("throws when supply is missing or not a positive number", () => {
    expect(() => adaptUsdtbTransparency({ ...USDTB_BACKING, supply: undefined }))
      .toThrow("invalid supply");
    expect(() => adaptUsdtbTransparency({ ...USDTB_BACKING, supply: -1 }))
      .toThrow("invalid supply");
  });

  it("throws when lastUpdatedAt is unreadable", () => {
    expect(() => adaptUsdtbTransparency({ ...USDTB_BACKING, lastUpdatedAt: "" }))
      .toThrow("unreadable lastUpdatedAt");
  });

  it("throws when every backing asset amount is zero and there is no assets-in-motion float", () => {
    expect(() =>
      adaptUsdtbTransparency({
        ...USDTB_BACKING,
        assetsInMotion: 0,
        backingAssets: {
          BUIDL: [{ amount: 0, custodian: "0x2004F7f7B600d962170d7f28114Cc123c5e98451" }],
        },
      }),
    ).toThrow("no positive backing asset amounts");
  });

  it("is degraded-but-valid under validateAdapterOutput when the source timestamp is stale", () => {
    const stale: UsdtbBackingAndSupplyPayload = {
      ...USDTB_BACKING,
      lastUpdatedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const result = adaptUsdtbTransparency(stale);
    const adapter = getReserveAdapter("usdtb-transparency") ?? undefined;
    const report = validateAdapterOutput(result, { adapter });

    expect(report.valid).toBe(true);
    expect(report.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "stale-source-data", effect: "degraded" })]),
    );
  });
});

describe("fetchUsdtbTransparencyReserves", () => {
  it("fetches the configured backing-and-supply endpoint and adapts the payload", async () => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValue(USDTB_BACKING);
    const config = makeConfig();

    const result = await fetchUsdtbTransparencyReserves(makeCoin(), config, signal);

    expect(fetchJsonWithRetry).toHaveBeenCalledWith(
      "https://usdtb.money/api/transparency/backing-and-supply/current",
      signal,
      12_000,
      undefined,
    );
    expect(result.slices[0]).toMatchObject({ name: "BlackRock BUIDL (U.S. T-Bills, cash, repos)" });
  });

  it("propagates an error when the endpoint request fails", async () => {
    vi.mocked(fetchJsonWithRetry).mockRejectedValue(new Error("HTTP 500 for https://usdtb.money/api/transparency/backing-and-supply/current"));
    const config = makeConfig();

    await expect(fetchUsdtbTransparencyReserves(makeCoin(), config, signal)).rejects.toThrow("HTTP 500");
  });
});
