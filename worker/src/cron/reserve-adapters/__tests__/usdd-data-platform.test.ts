import { describe, expect, it } from "vitest";
import {
  adaptUsddLatestCollateral,
  buildUsddHistoryUrl,
} from "../usdd-data-platform";
import {
  expectValidAdapterOutput,
  expectWarningEffect,
  expectWarnings,
  runAdapter,
  type AdapterNetworkSpec,
} from "./reserve-adapter.test-support";

const TRON_LATEST = "https://app-api.usdd.io/data-platform/latest-collateral?chain=tron";
const TRON_HISTORY = "https://app-api.usdd.io/data-platform/collateral-history?interval=WEEKLY&chain=tron";
const ETHEREUM_LATEST = "https://app-api.usdd.io/data-platform/latest-collateral?chain=ethereum";
const ETHEREUM_HISTORY = "https://app-api.usdd.io/data-platform/collateral-history?interval=WEEKLY&chain=ethereum";
const TRON_GRID = "https://api.trongrid.io/wallet/triggerconstantcontract";

const HISTORY_TIMESTAMP = 1_774_281_600_000;

function collateralResponse(items: Array<{ vaultType: string; lockedValue: number }>) {
  return { code: 0, data: { items } };
}

function historyResponse(statisticTime: number | undefined = HISTORY_TIMESTAMP) {
  return { code: 0, data: { items: statisticTime === undefined ? [] : [{ statisticTime }] } };
}
const GEM_JOIN_WORD = "000000000000000000000000b50eb419ebeba06c80df5e9aaec494cef4297879";
const USDD_WORD = "000000000000000000000000e91a7411e56ce79e83570570f49b9fc35b7727c5";
const GEM_JOIN_BALANCE_RAW = 33_195_883_987_282n;

type TronCallBody = {
  contract_address?: string;
  function_selector?: string;
  parameter?: string;
};

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

function tronNetwork(options: {
  words?: Record<string, string | null>;
  fail?: boolean;
} = {}): {
  spec: AdapterNetworkSpec;
  calls: TronCallBody[];
} {
  const calls: TronCallBody[] = [];
  const words = options.words ?? defaultPsmWords();
  return {
    spec: {
      json: {
        [TRON_LATEST]: collateralResponse([{ vaultType: "PSM-USDT-A", lockedValue: 100 }]),
        [TRON_HISTORY]: historyResponse(),
        [TRON_GRID]: async (request: Request) => {
          if (options.fail) throw new Error("trongrid down");
          const body = await request.clone().json() as TronCallBody;
          calls.push(body);
          const word = words[body.function_selector ?? ""];
          return word == null
            ? { result: { result: false } }
            : { result: { result: true }, constant_result: [word] };
        },
      },
    },
    calls,
  };
}

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
      { sourceKey: "usdd-data-platform:smart-allocator", name: "Smart Allocator (stablecoin DeFi via Aave/JustLend)", pct: 50.4, risk: "medium" },
      { sourceKey: "usdd-data-platform:trx", name: "TRX", pct: 39.7, risk: "high" },
      { sourceKey: "usdd-data-platform:psm-usdt", name: "USDT (PSM vaults)", pct: 8, risk: "low", coinId: "usdt-tether", depType: "collateral" },
      { sourceKey: "usdd-data-platform:staked-trx", name: "sTRX (direct vaults)", pct: 1.8, risk: "high" },
      { sourceKey: "usdd-data-platform:direct-usdt", name: "USDT (direct vaults)", pct: 0.1, risk: "high", coinId: "usdt-tether" },
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
      { sourceKey: "usdd-data-platform:smart-allocator", name: "Smart Allocator (stablecoin DeFi via Aave/JustLend)", pct: 75, risk: "medium" },
      { sourceKey: "usdd-data-platform:unknown", name: "Unknown / unmapped collateral vaults", pct: 25, risk: "high" },
    ]);
    expectWarnings(result, ["unknown-vault-type"]);
    expectWarningEffect(result, "unknown-vault-type", "degraded");
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
    expect(buildUsddHistoryUrl(ETHEREUM_LATEST)).toBe(ETHEREUM_HISTORY);
  });
});

describe("fetchUsddDataPlatformReserves", () => {
  it("fetches history from the same configured chain as the active collateral source", async () => {
    const { result } = await runAdapter("usdd-data-platform", "usdd-tron-dao-reserve", {
      config: {
        inputs: {
          primary: { kind: "http-json", url: ETHEREUM_LATEST },
        },
      },
      network: {
        json: {
          [ETHEREUM_LATEST]: collateralResponse([{ vaultType: "USDT-A", lockedValue: 100 }]),
          [ETHEREUM_HISTORY]: historyResponse(),
        },
      },
      nowSec: HISTORY_TIMESTAMP / 1_000 + 3_600,
    });

    expect(result.slices).toEqual([
      { sourceKey: "usdd-data-platform:direct-usdt", name: "USDT (direct vaults)", pct: 100, risk: "high", coinId: "usdt-tether" },
    ]);
  });

  it("fails closed when the provider drops the response status field", async () => {
    await expect(runAdapter("usdd-data-platform", "usdd-tron-dao-reserve", {
      network: {
        json: {
          [TRON_LATEST]: { data: { items: [{ vaultType: "PSM-USDT-A", lockedValue: 100 }] } },
          [TRON_HISTORY]: historyResponse(),
        },
      },
      nowSec: HISTORY_TIMESTAMP / 1_000 + 3_600,
      validate: false,
    })).rejects.toThrow("returned code");
  });
  it("fails closed when a collateral row drops lockedValue", async () => {
    await expect(runAdapter("usdd-data-platform", "usdd-tron-dao-reserve", {
      network: {
        json: {
          [TRON_LATEST]: { code: 0, data: { items: [{ vaultType: "PSM-USDT-A" }] } },
          [TRON_HISTORY]: historyResponse(),
        },
      },
      nowSec: HISTORY_TIMESTAMP / 1_000 + 3_600,
      validate: false,
    })).rejects.toThrow("collateral item 0 lockedValue");
  });
});

describe("fetchUsddDataPlatformReserves Tron PSM redemption telemetry", () => {
  it("publishes the GemJoin's USDT balance as live-direct PSM capacity", async () => {
    const { spec } = tronNetwork();
    const { result } = await runAdapter("usdd-data-platform", "usdd-tron-dao-reserve", {
      network: spec,
      nowSec: HISTORY_TIMESTAMP / 1_000 + 3_600,
    });

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
    const { spec, calls } = tronNetwork();
    await runAdapter("usdd-data-platform", "usdd-tron-dao-reserve", {
      network: spec,
      nowSec: HISTORY_TIMESTAMP / 1_000 + 3_600,
    });

    const balanceCall = calls.find((call) => call.function_selector === "balanceOf(address)");
    expect(balanceCall?.contract_address).toBe("41a614f803b6fd780986a42c78ec9c7f77e6ded13c");
    expect(balanceCall?.parameter).toBe(
      GEM_JOIN_WORD,
    );
  });

  it("converts a nonzero WAD tout into basis points", async () => {
    const { spec } = tronNetwork({
      words: { ...defaultPsmWords(), "tout()": toWord(1_000_000_000_000_000n) },
    });
    const { result } = await runAdapter("usdd-data-platform", "usdd-tron-dao-reserve", {
      network: spec,
      nowSec: HISTORY_TIMESTAMP / 1_000 + 3_600,
    });

    expect(result.metadata?.redemption).toMatchObject({ feeBps: 10 });
    expect(result.metadata).not.toHaveProperty("redemptionFeeBps");
  });

  it("reports a zero GemJoin balance as an open route with no capacity", async () => {
    const { spec } = tronNetwork({
      words: { ...defaultPsmWords(), "balanceOf(address)": toWord(0n) },
    });
    const { result } = await runAdapter("usdd-data-platform", "usdd-tron-dao-reserve", {
      network: spec,
      nowSec: HISTORY_TIMESTAMP / 1_000 + 3_600,
    });

    expect(result.metadata?.redemption).toMatchObject({ capacityUsd: 0, routeStatus: "open" });
  });

  it("marks the route paused when buyGem is disabled", async () => {
    const { spec } = tronNetwork({
      words: { ...defaultPsmWords(), "buyEnabled()": toWord(0n) },
    });
    const { result } = await runAdapter("usdd-data-platform", "usdd-tron-dao-reserve", {
      network: spec,
      nowSec: HISTORY_TIMESTAMP / 1_000 + 3_600,
    });

    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: 33_195_883.987282,
      routeStatus: "paused",
    });
  });

  it("withholds redemption telemetry when a read fails", async () => {
    const { spec } = tronNetwork({
      words: { ...defaultPsmWords(), "balanceOf(address)": null },
    });
    const { result } = await runAdapter("usdd-data-platform", "usdd-tron-dao-reserve", {
      network: spec,
      nowSec: HISTORY_TIMESTAMP / 1_000 + 3_600,
    });

    expect(result.metadata?.redemption).toBeUndefined();
    expect(result.metadata?.psmGemJoinBalanceRaw).toBeUndefined();
    expect(result.slices).toHaveLength(1);
  });

  it("withholds redemption telemetry when the PSM no longer points at the pinned GemJoin", async () => {
    const { spec } = tronNetwork({
      words: {
        ...defaultPsmWords(),
        "gemJoin()": "0000000000000000000000001111111111111111111111111111111111111111",
      },
    });
    const { result } = await runAdapter("usdd-data-platform", "usdd-tron-dao-reserve", {
      network: spec,
      nowSec: HISTORY_TIMESTAMP / 1_000 + 3_600,
    });

    expect(result.metadata?.redemption).toBeUndefined();
  });

  it("withholds redemption telemetry when the request throws", async () => {
    const { spec } = tronNetwork({ fail: true });
    const { result } = await runAdapter("usdd-data-platform", "usdd-tron-dao-reserve", {
      network: spec,
      nowSec: HISTORY_TIMESTAMP / 1_000 + 3_600,
    });

    expect(result.metadata?.redemption).toBeUndefined();
  });

  it("skips the Tron PSM probe when the configured collateral feed is not Tron", async () => {
    const { result } = await runAdapter("usdd-data-platform", "usdd-tron-dao-reserve", {
      config: {
        inputs: {
          primary: { kind: "http-json", url: ETHEREUM_LATEST },
        },
      },
      network: {
        json: {
          [ETHEREUM_LATEST]: collateralResponse([{ vaultType: "USDT-A", lockedValue: 100 }]),
          [ETHEREUM_HISTORY]: historyResponse(),
        },
      },
      nowSec: HISTORY_TIMESTAMP / 1_000 + 3_600,
    });

    expect(result.metadata?.redemption).toBeUndefined();
  });
});
