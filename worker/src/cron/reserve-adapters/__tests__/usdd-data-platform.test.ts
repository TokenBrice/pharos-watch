import type { StablecoinMeta } from "@shared/types/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return {
    ...actual,
    fetchJsonWithRetry: vi.fn(),
  };
});

import { fetchJsonWithRetry } from "../helpers";
import {
  adaptUsddLatestCollateral,
  buildUsddHistoryUrl,
  fetchUsddDataPlatformReserves,
} from "../usdd-data-platform";
import { getReserveAdapter } from "../index";
import { validateAdapterOutput } from "../validate";

const coin = {
  id: "usdd-decentralized-usd",
  name: "USDD",
  symbol: "USDD",
  flags: {
    backing: "crypto-backed",
    pegCurrency: "USD",
    governance: "centralized",
    yieldBearing: false,
    rwa: false,
    navToken: false,
  },
} as const satisfies StablecoinMeta;
const signal = AbortSignal.timeout(5_000);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("adaptUsddLatestCollateral", () => {
  it("maps the USDD collateral feed into detail-page reserve slices", () => {
    const result = adaptUsddLatestCollateral(
      {
        code: 0,
        data: {
          items: [
            { vaultType: "TRX-A", lockedValue: 201_173_223.24 },
            { vaultType: "TRX-B", lockedValue: 100_178_816.93 },
            { vaultType: "TRX-C", lockedValue: 108_374_409.0 },
            { vaultType: "USDT-A", lockedValue: 672_966.59 },
            { vaultType: "STRX-A", lockedValue: 18_896_312.13 },
            { vaultType: "PSM-USDT-A", lockedValue: 82_309_862.43 },
            { vaultType: "SA001-A", lockedValue: 519_698_996.0 },
          ],
        },
      },
      {
        code: 0,
        data: {
          items: [
            { statisticTime: 1_774_281_600_000 },
          ],
        },
      },
    );

    expect(result.slices).toEqual([
      { name: "Smart Allocator (stablecoin DeFi via Aave/JustLend)", pct: 50.4, risk: "medium" },
      { name: "TRX", pct: 39.7, risk: "high" },
      { name: "USDT (PSM vaults)", pct: 8, risk: "low", coinId: "usdt-tether", depType: "collateral" },
      { name: "sTRX (direct vaults)", pct: 1.8, risk: "high" },
      { name: "USDT (direct vaults)", pct: 0.1, risk: "high", coinId: "usdt-tether" },
    ]);
    expect(result.metadata).toMatchObject({
      vaultCount: 7,
      trackedVaultCount: 5,
      sourceTimestamp: 1_774_281_600,
      freshnessMode: "verified",
      stableVaultUsd: expect.closeTo(82_982_829.02, 2),
    });
    expect(result.metadata?.redemption).toBeUndefined();
    expect(validateAdapterOutput(result, { adapter: getReserveAdapter("usdd-data-platform") ?? undefined }).valid).toBe(true);
  });

  it("preserves unknown vault types as an explicit high-risk slice and warning", () => {
    const result = adaptUsddLatestCollateral({
      code: 0,
      data: {
        items: [
          { vaultType: "SA001-A", lockedValue: 75 },
          { vaultType: "RWA-A", lockedValue: 25 },
        ],
      },
    });

    expect(result.slices).toEqual([
      { name: "Smart Allocator (stablecoin DeFi via Aave/JustLend)", pct: 75, risk: "medium" },
      { name: "Unknown / unmapped collateral vaults", pct: 25, risk: "high" },
    ]);
    expect(result.warnings).toEqual([{
      code: "unknown-vault-type",
      message: "USDD collateral feed includes unmapped vault types: RWA-A (25.00% of reserves)",
      severity: "warning",
      effect: "degraded",
    }]);
    expect(result.metadata).toMatchObject({
      vaultCount: 2,
      trackedVaultCount: 5,
      unknownVaultCount: 1,
      unknownVaultTypes: ["RWA-A"],
      unknownExposurePct: 25,
      freshnessMode: "unverified",
      details: {
        freshnessSource: "collateral-history",
        freshnessReason: "history timestamp unavailable",
      },
    });
  });

  it("throws when the USDD feed reports a non-success code", () => {
    expect(() => adaptUsddLatestCollateral({ code: 500 })).toThrow("returned code");
  });
});

describe("buildUsddHistoryUrl", () => {
  it("derives the matching history endpoint from the active latest-collateral URL", () => {
    expect(buildUsddHistoryUrl("https://app-api.usdd.io/data-platform/latest-collateral?chain=ethereum"))
      .toBe("https://app-api.usdd.io/data-platform/collateral-history?interval=WEEKLY&chain=ethereum");
  });
});

describe("fetchUsddDataPlatformReserves", () => {
  it("fetches history from the same configured chain as the latest collateral source", async () => {
    vi.mocked(fetchJsonWithRetry)
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [{ vaultType: "USDT-A", lockedValue: 100 }],
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [{ statisticTime: 1_774_281_600_000 }],
        },
      });

    const config = {
      adapter: "usdd-data-platform",
      version: 1,
      semantics: "collateral-mix",
      inputs: {
        primary: {
          kind: "http-json",
          url: "https://app-api.usdd.io/data-platform/latest-collateral?chain=ethereum",
        },
      },
    } as const;

    const result = await fetchUsddDataPlatformReserves(coin, config, signal);

    expect(result.slices).toEqual([
      { name: "USDT (direct vaults)", pct: 100, risk: "high", coinId: "usdt-tether" },
    ]);
    expect(fetchJsonWithRetry).toHaveBeenNthCalledWith(
      1,
      "https://app-api.usdd.io/data-platform/latest-collateral?chain=ethereum",
      signal,
      12_000,
      undefined,
    );
    expect(fetchJsonWithRetry).toHaveBeenNthCalledWith(
      2,
      "https://app-api.usdd.io/data-platform/collateral-history?interval=WEEKLY&chain=ethereum",
      signal,
      12_000,
      undefined,
    );
  });
});
