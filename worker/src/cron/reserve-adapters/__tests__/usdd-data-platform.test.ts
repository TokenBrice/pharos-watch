import type { StablecoinMeta } from "@shared/types/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return {
    ...actual,
    fetchJsonWithRetry: vi.fn(),
    fetchJsonPostWithRetry: vi.fn(),
  };
});

import { fetchJsonPostWithRetry, fetchJsonWithRetry } from "../helpers";
import {
  adaptUsddLatestCollateral,
  buildUsddHistoryUrl,
  fetchUsddDataPlatformReserves,
} from "../usdd-data-platform";
import { expectValidAdapterOutput, TEST_SIGNAL as signal } from "./reserve-adapter.test-support";

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
    expectValidAdapterOutput("usdd-data-platform", result);
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

describe("fetchUsddDataPlatformReserves Tron PSM redemption telemetry", () => {
  // Verified on Tron mainnet 2026-08-12 via TronGrid triggerconstantcontract.
  const GEM_JOIN_WORD = "000000000000000000000000b50eb419ebeba06c80df5e9aaec494cef4297879";
  const USDD_WORD = "000000000000000000000000e91a7411e56ce79e83570570f49b9fc35b7727c5";
  const GEM_JOIN_BALANCE_RAW = 33_195_883_987_282n;

  function toWord(value: bigint): string {
    return value.toString(16).padStart(64, "0");
  }

  function defaultPsmWords(): Record<string, string | null> {
    return {
      "gemJoin()": GEM_JOIN_WORD,
      "usdd()": USDD_WORD,
      "buyEnabled()": toWord(1n),
      "tout()": toWord(0n),
      "balanceOf(address)": toWord(GEM_JOIN_BALANCE_RAW),
    };
  }

  function mockPsmReads(words: Record<string, string | null>): void {
    vi.mocked(fetchJsonPostWithRetry).mockImplementation(async (_url, body) => {
      const { function_selector: selector } = body as { function_selector: string };
      const word = words[selector];
      return word == null
        ? { result: { result: false } }
        : { result: { result: true }, constant_result: [word] };
    });
  }

  const tronConfig = {
    adapter: "usdd-data-platform",
    version: 1,
    semantics: "collateral-mix",
    inputs: {
      primary: {
        kind: "http-json",
        url: "https://app-api.usdd.io/data-platform/latest-collateral?chain=tron",
      },
    },
  } as const;

  beforeEach(() => {
    vi.mocked(fetchJsonWithRetry)
      .mockResolvedValueOnce({ code: 0, data: { items: [{ vaultType: "PSM-USDT-A", lockedValue: 100 }] } })
      .mockResolvedValueOnce({ code: 0, data: { items: [{ statisticTime: 1_774_281_600_000 }] } });
  });

  it("publishes the GemJoin's USDT balance as live-direct PSM capacity", async () => {
    mockPsmReads(defaultPsmWords());

    const result = await fetchUsddDataPlatformReserves(coin, tronConfig, signal);

    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: 33_195_883.987282,
      capacityKind: "live-direct",
      freshnessKind: "same-run-onchain",
      routeStatus: "open",
      routeStatusSource: "onchain",
      holderEligibility: "any-holder",
      settlementDelaySec: 0,
      feeBps: 0,
    });
    expect(result.metadata?.redemption?.routeStatusReason).toContain("TSUYvQ5tdd3DijCD1uGunGLpftHuSZ12sQ");
    expect(result.metadata?.redemption?.sourceUrls).toEqual([
      "https://docs.usdd.io/user-guide/psm-peg-stability-module",
    ]);
    expect(result.metadata?.psmGemJoinBalanceRaw).toBe("33195883987282");
    expectValidAdapterOutput("usdd-data-platform", result);
  });

  it("reads the balance of the address the PSM itself reports as its GemJoin", async () => {
    mockPsmReads(defaultPsmWords());

    await fetchUsddDataPlatformReserves(coin, tronConfig, signal);

    const balanceCall = vi
      .mocked(fetchJsonPostWithRetry)
      .mock.calls.find(([, body]) => (body as { function_selector: string }).function_selector === "balanceOf(address)");
    expect(balanceCall?.[0]).toBe("https://api.trongrid.io/wallet/triggerconstantcontract");
    expect(balanceCall?.[1]).toMatchObject({
      contract_address: "41a614f803b6fd780986a42c78ec9c7f77e6ded13c",
      parameter: GEM_JOIN_WORD,
    });
  });

  it("converts a nonzero WAD tout into basis points", async () => {
    mockPsmReads({ ...defaultPsmWords(), "tout()": toWord(1_000_000_000_000_000n) });

    const result = await fetchUsddDataPlatformReserves(coin, tronConfig, signal);

    expect(result.metadata?.redemption).toMatchObject({ feeBps: 10 });
    expect(result.metadata?.redemptionFeeBps).toBe(10);
  });

  it("reports a zero GemJoin balance as an open route with no capacity", async () => {
    mockPsmReads({ ...defaultPsmWords(), "balanceOf(address)": toWord(0n) });

    const result = await fetchUsddDataPlatformReserves(coin, tronConfig, signal);

    expect(result.metadata?.redemption).toMatchObject({ capacityUsd: 0, routeStatus: "open" });
  });

  it("marks the route paused when buyGem is disabled", async () => {
    mockPsmReads({ ...defaultPsmWords(), "buyEnabled()": toWord(0n) });

    const result = await fetchUsddDataPlatformReserves(coin, tronConfig, signal);

    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: 33_195_883.987282,
      routeStatus: "paused",
    });
  });

  it("withholds redemption telemetry when a read fails", async () => {
    mockPsmReads({ ...defaultPsmWords(), "balanceOf(address)": null });

    const result = await fetchUsddDataPlatformReserves(coin, tronConfig, signal);

    expect(result.metadata?.redemption).toBeUndefined();
    expect(result.metadata?.psmGemJoinBalanceRaw).toBeUndefined();
    expect(result.slices).toHaveLength(1);
  });

  it("withholds redemption telemetry when the PSM no longer points at the pinned GemJoin", async () => {
    mockPsmReads({
      ...defaultPsmWords(),
      "gemJoin()": "0000000000000000000000001111111111111111111111111111111111111111",
    });

    const result = await fetchUsddDataPlatformReserves(coin, tronConfig, signal);

    expect(result.metadata?.redemption).toBeUndefined();
  });

  it("withholds redemption telemetry when the request throws", async () => {
    vi.mocked(fetchJsonPostWithRetry).mockRejectedValue(new Error("trongrid down"));

    const result = await fetchUsddDataPlatformReserves(coin, tronConfig, signal);

    expect(result.metadata?.redemption).toBeUndefined();
  });

  it("skips the Tron PSM probe when the configured collateral feed is not Tron", async () => {
    mockPsmReads(defaultPsmWords());

    const result = await fetchUsddDataPlatformReserves(coin, {
      ...tronConfig,
      inputs: {
        primary: {
          kind: "http-json",
          url: "https://app-api.usdd.io/data-platform/latest-collateral?chain=ethereum",
        },
      },
    } as const, signal);

    expect(result.metadata?.redemption).toBeUndefined();
    expect(fetchJsonPostWithRetry).not.toHaveBeenCalled();
  });
});
