import { describe, expect, it, vi, beforeEach } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { computeLiveReserveConfigFingerprint } from "@shared/lib/live-reserve-adapters";
import { evaluateLiveReserveAdmission } from "../../../lib/live-reserves/store-snapshot-state";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return {
    ...actual,
    fetchJsonAdapterInput: vi.fn(),
  };
});

import {
  adaptCustodyInventory,
  fetchCustodyInventoryReserves,
  type BackingAndSupplyPayload,
} from "../custody-inventory";
import { fetchJsonAdapterInput } from "../helpers";
import {
  expectValidAdapterOutput,
  expectWarningEffect,
  expectWarnings,
  mockedReserveHelper,
} from "./reserve-adapter.test-support";
import { USDTB_BACKING_AND_SUPPLY_PAYLOAD as USDTB_BACKING } from "./reserve-adapter-payloads.test-support";
let signal: AbortSignal;

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

beforeEach(() => {
  vi.clearAllMocks();
  signal = new AbortController().signal;
});

describe("custody inventory USDtb profile", () => {
  it("maps BUIDL and assets-in-motion into slices, drops zero-amount assets, and computes the honest ratio", () => {
    const result = adaptCustodyInventory("usdtb-transparency", USDTB_BACKING);

    expect(result.slices).toEqual([
      { sourceKey: "usdtb-transparency:buidl", name: "BlackRock BUIDL (U.S. T-Bills, cash, repos)", pct: 98.8, risk: "low", coinId: "buidl-blackrock", depType: "collateral" },
      { sourceKey: "usdtb-transparency:assets-in-motion", name: "Assets in motion (settlement float)", pct: 1.2, risk: "low" },
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

  it("merges both reviewed BUIDL share classes with the stable source identity", () => {
    const result = adaptCustodyInventory("usdtb-transparency", {
      ...USDTB_BACKING, supply: 100, assetsInMotion: 0,
      backingAssets: { BUIDL: [{ amount: 60 }], " BUIDL-I ": [{ amount: 40 }] },
    });
    expect(result.slices).toEqual([
      { sourceKey: "usdtb-transparency:buidl", name: "BlackRock BUIDL (U.S. T-Bills, cash, repos)", pct: 100, risk: "low", coinId: "buidl-blackrock", depType: "collateral" },
    ]);
    expect(result.metadata?.totalReserveUsd).toBe(100);
    expect(result.warnings).toBeUndefined();
  });

  it("preserves backing, supply and clock validation precedence", () => {
    expect(() => adaptCustodyInventory("usdtb-transparency", {})).toThrow("missing backingAssets");
    expect(() => adaptCustodyInventory("usdtb-transparency", { backingAssets: {} })).toThrow("supply is not a finite number");
    expect(() => adaptCustodyInventory("usdtb-transparency", { backingAssets: {}, supply: 1 })).toThrow("unreadable lastUpdatedAt");
  });

  it.each([
    [50, 0, 0.5, true],
    [99.5, 0, 0.995, false],
    [99.49, 0, 0.9949, true],
    [100, 0, 1, false],
    [50, 50, 1, false],
  ])("admits honest coverage for backing %s plus settlement float %s", (backing, assetsInMotion, ratio, degraded) => {
    const now = Math.floor(Date.now() / 1000);
    const result = adaptCustodyInventory("usdtb-transparency", {
      backingAssets: { USDC: [{ amount: backing }] },
      assetsInMotion,
      supply: 100,
      lastUpdatedAt: new Date(now * 1000).toISOString(),
    });
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(ratio);
    const report = expectValidAdapterOutput("usdtb-transparency", result);
    expectWarnings(result, degraded ? ["reserve-undercollateralized"] : []);
    if (degraded) expectWarningEffect(result, "reserve-undercollateralized", "degraded");
    const warnings = [...(result.warnings ?? []), ...report.warnings];
    const config = makeConfig();
    const admission = evaluateLiveReserveAdmission({
      stablecoinId: "usdtb-ethena",
      slices: result.slices,
      fetchedAt: now,
      source: "usdtb-transparency",
      metadata: result.metadata!,
      warningCount: warnings.length,
      warnings,
      adapterSourceModel: "dynamic-mix",
      adapterEvidenceClass: "independent",
      configFingerprint: computeLiveReserveConfigFingerprint(config),
    }, { lastSuccessAt: now, lastSuccessAttemptId: null }, { liveReservesConfig: config }, now);
    expect(admission.eligible).toBe(!degraded);
    expect(admission.reasons.includes("degraded-snapshot")).toBe(degraded);
  });

  it("emits an info warning when USDtb reports nonzero self-holdings and excludes them from backing", () => {
    const withSelfHolding: BackingAndSupplyPayload = {
      ...USDTB_BACKING,
      backingAssets: {
        ...USDTB_BACKING.backingAssets,
        USDtb: [{ amount: 5_000_000, custodian: "0x2004F7f7B600d962170d7f28114Cc123c5e98451" }],
      },
    };

    const result = adaptCustodyInventory("usdtb-transparency", withSelfHolding);

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
    const withUnknownAsset: BackingAndSupplyPayload = {
      ...USDTB_BACKING,
      backingAssets: {
        ...USDTB_BACKING.backingAssets,
        DAI: [{ amount: 1_000_000, custodian: "0x2004F7f7B600d962170d7f28114Cc123c5e98451" }],
      },
    };

    const result = adaptCustodyInventory("usdtb-transparency", withUnknownAsset);

    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "unknown-asset", severity: "warning", effect: "degraded" }),
    ]);
    expect(result.slices).toContainEqual(
      expect.objectContaining({ name: "DAI (unmapped)", risk: "high" }),
    );
  });

  it("throws when backingAssets is missing", () => {
    expect(() => adaptCustodyInventory("usdtb-transparency", { ...USDTB_BACKING, backingAssets: undefined }))
      .toThrow("missing backingAssets");
  });

  it("throws when supply is missing or not a positive number", () => {
    expect(() => adaptCustodyInventory("usdtb-transparency", { ...USDTB_BACKING, supply: undefined }))
      .toThrow("not a finite number");
    expect(() => adaptCustodyInventory("usdtb-transparency", { ...USDTB_BACKING, supply: -1 }))
      .toThrow("invalid supply");
  });

  it("parses numeric-string amounts instead of silently reading them as zero", () => {
    const withStringAmounts: BackingAndSupplyPayload = {
      ...USDTB_BACKING,
      backingAssets: {
        BUIDL: [{ amount: "767603510.39", custodian: "0x2004F7f7B600d962170d7f28114Cc123c5e98451" }],
      },
      assetsInMotion: "9115451.68",
      supply: "775334449.6661826",
    };

    const result = adaptCustodyInventory("usdtb-transparency", withStringAmounts);

    expect(result.slices).toEqual([
      { sourceKey: "usdtb-transparency:buidl", name: "BlackRock BUIDL (U.S. T-Bills, cash, repos)", pct: 98.8, risk: "low", coinId: "buidl-blackrock", depType: "collateral" },
      { sourceKey: "usdtb-transparency:assets-in-motion", name: "Assets in motion (settlement float)", pct: 1.2, risk: "low" },
    ]);
    const totalReserveUsd = 767603510.39 + 9115451.68;
    expect(result.metadata?.totalReserveUsd).toBeCloseTo(totalReserveUsd, 3);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(totalReserveUsd / 775334449.6661826, 9);
  });

  it("throws on non-numeric backing asset amounts instead of silently reading them as zero", () => {
    const withGarbageAmount: BackingAndSupplyPayload = {
      ...USDTB_BACKING,
      backingAssets: {
        ...USDTB_BACKING.backingAssets,
        BUIDL: [{ amount: "not-a-number", custodian: "0x2004F7f7B600d962170d7f28114Cc123c5e98451" }],
      },
    };

    expect(() => adaptCustodyInventory("usdtb-transparency", withGarbageAmount)).toThrow("backing asset BUIDL entry 0 amount is not a finite number");
    expect(() => adaptCustodyInventory("usdtb-transparency", { ...USDTB_BACKING, assetsInMotion: "NaN" }))
      .toThrow("assetsInMotion is not a finite number");
  });

  it("throws on negative amounts instead of silently zeroing them", () => {
    expect(() => adaptCustodyInventory("usdtb-transparency", {
      ...USDTB_BACKING,
      backingAssets: {
        ...USDTB_BACKING.backingAssets,
        BUIDL: [{ amount: -5, custodian: "0x2004F7f7B600d962170d7f28114Cc123c5e98451" }],
      },
    })).toThrow("backing asset BUIDL entry 0 has a negative amount");
    expect(() => adaptCustodyInventory("usdtb-transparency", { ...USDTB_BACKING, assetsInMotion: -1 }))
      .toThrow("assetsInMotion is negative");
  });

  it("throws when lastUpdatedAt is unreadable", () => {
    expect(() => adaptCustodyInventory("usdtb-transparency", { ...USDTB_BACKING, lastUpdatedAt: "" }))
      .toThrow("unreadable lastUpdatedAt");
  });

  it("throws when every backing asset amount is zero and there is no assets-in-motion float", () => {
    expect(() =>
      adaptCustodyInventory("usdtb-transparency", {
        ...USDTB_BACKING,
        assetsInMotion: 0,
        backingAssets: {
          BUIDL: [{ amount: 0, custodian: "0x2004F7f7B600d962170d7f28114Cc123c5e98451" }],
        },
      }),
    ).toThrow("no positive backing asset amounts");
  });

  it("is degraded-but-valid under validateAdapterOutput when the source timestamp is stale", () => {
    const stale: BackingAndSupplyPayload = {
      ...USDTB_BACKING,
      lastUpdatedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const result = adaptCustodyInventory("usdtb-transparency", stale);
    const report = expectValidAdapterOutput("usdtb-transparency", result);
    expect(report.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "stale-source-data", effect: "degraded" })]),
    );
  });
});

describe("custody inventory USDtb fetch", () => {
  it("fetches the configured backing-and-supply endpoint and adapts the payload", async () => {
    mockedReserveHelper(fetchJsonAdapterInput).mockResolvedValue(USDTB_BACKING);
    const config = makeConfig();

    const result = await fetchCustodyInventoryReserves(makeCoin(), config, signal);

    expect(fetchJsonAdapterInput).toHaveBeenCalledWith(
      config,
      "usdtb-transparency",
      signal,
      12_000,
      undefined,
    );
    expect(result.slices[0]).toMatchObject({ name: "BlackRock BUIDL (U.S. T-Bills, cash, repos)" });
  });

  it("propagates an error when the endpoint request fails", async () => {
    mockedReserveHelper(fetchJsonAdapterInput).mockRejectedValue(new Error("HTTP 500 for https://usdtb.money/api/transparency/backing-and-supply/current"));
    const config = makeConfig();

    await expect(fetchCustodyInventoryReserves(makeCoin(), config, signal)).rejects.toThrow("HTTP 500");
  });
});
