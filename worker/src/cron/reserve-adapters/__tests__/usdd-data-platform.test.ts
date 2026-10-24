import { describe, expect, it } from "vitest";
import {
  adaptUsddLatestCollateral,
  matchUsddCollateralHistoryTimestamp,
  reconcileUsddItemizedCollateral,
} from "../usdd-data-platform";
import {
  expectValidAdapterOutput,
  expectWarningEffect,
  expectWarnings,
  runAdapter,
  type AdapterNetworkSpec,
} from "./reserve-adapter.test-support";
import { DWELLIR_NATIVE_ENDPOINTS } from "@shared/lib/dwellir-native-endpoints";
import { createDwellirNativeCapability } from "../../../lib/dwellir-native";

const TRON_LATEST = "https://app-api.usdd.io/data-platform/latest-collateral?chain=tron";
const ETHEREUM_LATEST = "https://app-api.usdd.io/data-platform/latest-collateral?chain=ethereum";
const TRON_GRID = "https://api.trongrid.io/wallet/triggerconstantcontract";

const NOW_SEC = 1_774_281_600 + 3_600;
const historyUrl = (chain: string) =>
  `https://app-api.usdd.io/data-platform/collateral-history?chain=${chain}&startTime=${NOW_SEC * 1000 - 86_400_000}&endTime=${NOW_SEC * 1000}`;
const TRON_HISTORY = historyUrl("tron");
const ETHEREUM_HISTORY = historyUrl("ethereum");
const EMPTY_HISTORY = { code: 0, data: { items: [] } };
// Live-bucket statisticTime is the UTC+8 day start, in milliseconds.
const BUCKET_START_SEC = 1_774_281_600 - 8 * 3_600;

function collateralResponse(items: Array<{ vaultType: string; lockedValue: number }>) {
  const totalCollateralValue = items.reduce((sum, item) => sum + item.lockedValue, 0);
  return { code: 0, data: { items, totalCollateralValue, totalSupplyValue: 1_000 } };
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
        [TRON_HISTORY]: EMPTY_HISTORY,
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
    );

    expect(result.slices).toEqual([
      { sourceKey: "usdd-data-platform:smart-allocator", name: "Smart Allocator (stablecoin DeFi via Aave/JustLend)", pct: 50.4, risk: "medium" },
      { sourceKey: "usdd-data-platform:trx", name: "TRX", pct: 39.7, risk: "high" },
      { sourceKey: "usdd-data-platform:psm-usdt", name: "USDT (PSM vaults)", pct: 8, risk: "low", coinId: "usdt-tether", depType: "collateral" },
      { sourceKey: "usdd-data-platform:staked-trx", name: "sTRX (direct vaults)", pct: 1.8, risk: "high" },
      { sourceKey: "usdd-data-platform:direct-usdt", name: "USDT (direct vaults)", pct: 0.1, risk: "high", coinId: "usdt-tether", depType: "collateral" },
    ]);
    expect(result.metadata).toMatchObject({
      vaultCount: 7,
      trackedVaultCount: 5,
      freshnessMode: "unverified",
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
        freshnessSource: "latest-collateral",
        freshnessReason: "composition timestamp unavailable; collateral-history is not joined to this snapshot",
      },
    });
  });

  it("throws when the USDD feed reports a non-success code", () => {
    expect(() => adaptUsddLatestCollateral({ code: 500 })).toThrow("returned code");
  });

  it("keeps undated composition unverified without a source timestamp", () => {
    const result = adaptUsddLatestCollateral(
      collateralResponse([{ vaultType: "PSM-USDT-A", lockedValue: 100 }]),
    );
    expect(result.metadata?.sourceTimestamp).toBeUndefined();
    expect(result.metadata?.freshnessMode).toBe("unverified");
    expect(result.metadata?.details).not.toHaveProperty("historyTimestamp");
  });
});

describe("fetchUsddDataPlatformReserves", () => {
  it("fetches current collateral and same-chain collateral-history, staying unverified without an exact match", async () => {
    const { result, network } = await runAdapter("usdd-data-platform", "usdd-tron-dao-reserve", {
      config: {
        inputs: {
          primary: { kind: "http-json", url: ETHEREUM_LATEST },
        },
      },
      network: {
        json: {
          [ETHEREUM_LATEST]: collateralResponse([{ vaultType: "USDT-A", lockedValue: 100 }]),
          [ETHEREUM_HISTORY]: EMPTY_HISTORY,
        },
      },
      nowSec: NOW_SEC,
    });

    expect(result.slices).toEqual([
      { sourceKey: "usdd-data-platform:direct-usdt", name: "USDT (direct vaults)", pct: 100, risk: "high", coinId: "usdt-tether", depType: "collateral" },
    ]);
    expect(result.metadata?.redemption).toBeUndefined();
    expect(result.metadata?.freshnessMode).toBe("unverified");
    expect(network.fetchSpy.getHistory().map(request => request.url)).toEqual([ETHEREUM_LATEST, ETHEREUM_HISTORY]);
  });

  it("fails closed when the provider drops the response status field", async () => {
    await expect(runAdapter("usdd-data-platform", "usdd-tron-dao-reserve", {
      network: {
        json: {
          [TRON_LATEST]: { data: { items: [{ vaultType: "PSM-USDT-A", lockedValue: 100 }] } },
        },
      },
      nowSec: NOW_SEC,
      validate: false,
    })).rejects.toThrow("returned code");
  });
  it("fails closed when a collateral row drops lockedValue", async () => {
    await expect(runAdapter("usdd-data-platform", "usdd-tron-dao-reserve", {
      network: {
        json: {
          [TRON_LATEST]: { code: 0, data: { items: [{ vaultType: "PSM-USDT-A" }] } },
        },
      },
      nowSec: NOW_SEC,
      validate: false,
    })).rejects.toThrow("collateral item 0 lockedValue");
  });
});

describe("USDD collateral-history freshness join", () => {
  const latest = {
    code: 0,
    data: {
      items: [
        { vaultType: "PSM-USDT-A", lockedValue: 1_000_000_000 },
        { vaultType: "TRX-A", lockedValue: 1_019_887_765.02 },
      ],
      totalCollateralValue: 2_019_887_765.02,
      totalSupplyValue: 1_323_474_423.1566734,
    },
  };
  const liveRow = {
    collateralValue: 2_019_887_765.02,
    totalSupplyValue: 1_323_474_423.1566734,
    statisticTime: BUCKET_START_SEC * 1000,
  };

  it("dates the snapshot by the matching row's bucket start", () => {
    expect(matchUsddCollateralHistoryTimestamp(latest, {
      code: 0,
      data: { items: [{ ...liveRow, collateralValue: 1, statisticTime: (BUCKET_START_SEC - 86_400) * 1000 }, liveRow] },
    }, NOW_SEC)).toBe(BUCKET_START_SEC);
  });

  it.each([
    ["collateral differs", { ...liveRow, collateralValue: 2_019_887_765.03 }],
    ["supply differs", { ...liveRow, totalSupplyValue: 1_323_474_423 }],
    ["statisticTime missing", { ...liveRow, statisticTime: undefined }],
    ["statisticTime in the future", { ...liveRow, statisticTime: (NOW_SEC + 60) * 1000 }],
  ])("returns null when %s", (_label, row) => {
    expect(matchUsddCollateralHistoryTimestamp(latest, { code: 0, data: { items: [row] } }, NOW_SEC)).toBeNull();
  });

  it("returns null for a non-success history payload", () => {
    expect(matchUsddCollateralHistoryTimestamp(latest, { code: 500, data: { items: [liveRow] } }, NOW_SEC)).toBeNull();
  });

  it("publishes verified freshness when the history join matches", async () => {
    const { result } = await runAdapter("usdd-data-platform", "usdd-tron-dao-reserve", {
      config: { inputs: { primary: { kind: "http-json", url: ETHEREUM_LATEST } } },
      network: { json: { [ETHEREUM_LATEST]: latest, [ETHEREUM_HISTORY]: { code: 0, data: { items: [liveRow] } } } },
      nowSec: NOW_SEC,
    });
    expect(result.metadata).toMatchObject({
      sourceTimestamp: BUCKET_START_SEC,
      freshnessMode: "verified",
      details: { freshnessSource: "collateral-history" },
    });
  });

  it("withholds the history clock and degrades a truncated itemized book", async () => {
    const truncated = { ...latest, data: { ...latest.data, items: [{ vaultType: "PSM-USDT-A", lockedValue: 100 }] } };
    const { result, network } = await runAdapter("usdd-data-platform", "usdd-tron-dao-reserve", {
      config: { inputs: { primary: { kind: "http-json", url: ETHEREUM_LATEST } } },
      network: { json: { [ETHEREUM_LATEST]: truncated, [ETHEREUM_HISTORY]: { code: 0, data: { items: [liveRow] } } } },
      nowSec: NOW_SEC,
    });
    expect(result.metadata?.sourceTimestamp).toBeUndefined();
    expect(result.metadata?.freshnessMode).toBe("unverified");
    expect(result.metadata).toMatchObject({ itemizedCollateralUsd: 100, itemizedCollateralReconciled: false });
    expect(result.warnings).toEqual([expect.objectContaining({ code: "itemized-collateral-mismatch", effect: "degraded" })]);
    expect(network.fetchSpy.getHistory().map(request => request.url)).toEqual([ETHEREUM_LATEST]);
  });

  it("reconciles the itemized book within one cent per row", () => {
    expect(reconcileUsddItemizedCollateral(latest)?.reconciled).toBe(true);
    expect(reconcileUsddItemizedCollateral({ ...latest, data: { ...latest.data, totalCollateralValue: 2_019_887_765.05 } })?.reconciled).toBe(false);
    expect(reconcileUsddItemizedCollateral({ ...latest, data: { ...latest.data, totalCollateralValue: 0 } })).toBeNull();
  });

  it("falls back to unverified after one bounded hanging history attempt and still reads the PSM", async () => {
    const { spec } = tronNetwork();
    const reconciled = { ...latest, data: { ...latest.data } };
    const startedAt = Date.now();
    const { result, network } = await runAdapter("usdd-data-platform", "usdd-tron-dao-reserve", {
      network: { ...spec, json: {
        ...spec.json,
        [TRON_LATEST]: reconciled,
        [TRON_HISTORY]: (request: Request) => new Promise((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
        }),
      } },
      nowSec: NOW_SEC,
    });
    expect(Date.now() - startedAt).toBeLessThan(9_000);
    expect(result.metadata?.sourceTimestamp).toBeUndefined();
    expect(result.metadata?.freshnessMode).toBe("unverified");
    expect(network.fetchSpy.getHistory().filter(request => request.url === TRON_HISTORY)).toHaveLength(1);
    expect(result.metadata?.redemption).toMatchObject({ capacityKind: "live-direct" });
  }, 15_000);

  it("keeps unverified freshness when collateral-history fails", async () => {
    const { result } = await runAdapter("usdd-data-platform", "usdd-tron-dao-reserve", {
      config: { inputs: { primary: { kind: "http-json", url: ETHEREUM_LATEST } } },
      network: { json: { [ETHEREUM_LATEST]: latest } },
      nowSec: NOW_SEC,
      allowUnmatched: true,
    });
    expect(result.metadata?.sourceTimestamp).toBeUndefined();
    expect(result.metadata?.freshnessMode).toBe("unverified");
  });
});

describe("fetchUsddDataPlatformReserves Tron PSM redemption telemetry", () => {
  it.each(["success", "fallback", "disabled", "pinned"] as const)(
    "keeps native PSM constant routing operation-scoped: %s", async mode => {
      const base = DWELLIR_NATIVE_ENDPOINTS.find(endpoint => endpoint.network === "tron")!.baseUrl;
      const { spec } = tronNetwork();
      const words = defaultPsmWords();
      const { result, network } = await runAdapter("usdd-data-platform", "usdd-tron-dao-reserve", {
        network: { ...spec, json: { ...spec.json, [`${base}/wallet/triggerconstantcontract`]: async (request: Request) => {
          expect(request.headers.get("X-Api-Key")).toBe("native-test-key-placeholder");
          expect(request.headers.get("TRON-PRO-API-KEY")).toBeNull();
          const body = await request.clone().json() as TronCallBody;
          return mode === "fallback" ? { result: { result: false } }
            : { result: { result: true }, constant_result: [words[body.function_selector!]] };
        } } },
        ctx: {
          dwellirNative: createDwellirNativeCapability("native-test-key-placeholder",
            mode === "disabled" ? new Set(["tron"]) : undefined),
          trongridApiKey: "tron-test-key",
          ...(mode === "pinned" ? { observedBlock: { chain: "tron", number: 100, timestamp: 1000 } } : {}),
        },
        nowSec: NOW_SEC,
      });
      expect(network.fetchSpy.getHistory().filter(request => request.url.includes("/collateral-history"))).toHaveLength(1);
      const calls = network.fetchSpy.getHistory().filter(request => request.url.includes("triggerconstantcontract"));
      const nativeCalls = calls.filter(request => request.url.startsWith(base));
      const incumbentCalls = calls.filter(request => request.url === TRON_GRID);
      expect(nativeCalls).toHaveLength(mode === "success" || mode === "fallback" ? 5 : 0);
      expect(incumbentCalls).toHaveLength(mode === "fallback" || mode === "disabled" ? 5 : 0);
      expect(incumbentCalls.every(request => request.headers["tron-pro-api-key"] === "tron-test-key" &&
        !request.headers["x-api-key"])).toBe(true);
      if (mode === "pinned") expect(result.metadata?.redemption).toBeUndefined();
      else expect(result.metadata?.redemption).toMatchObject({ capacityUsd: 33_195_883.987282, capacityKind: "live-direct" });
      for (const selector of Object.keys(words)) {
        const attempts = calls.filter(request => JSON.parse(request.body!).function_selector === selector);
        if (mode === "success" || mode === "fallback") expect(attempts[0]?.url).toBe(`${base}/wallet/triggerconstantcontract`);
      }
    },
  );

  it("publishes the GemJoin's USDT balance as live-direct PSM capacity", async () => {
    const { spec } = tronNetwork();
    const { result, network } = await runAdapter("usdd-data-platform", "usdd-tron-dao-reserve", {
      network: spec,
      nowSec: NOW_SEC,
    });
    expect(network.fetchSpy.getHistory().map(request => request.url)).toEqual([
      TRON_LATEST,
      TRON_HISTORY,
      ...Array(5).fill(TRON_GRID),
    ]);
    expect(result.metadata?.freshnessMode).toBe("unverified");
    expect(result.metadata?.sourceTimestamp).toBeUndefined();

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
      nowSec: NOW_SEC,
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
      nowSec: NOW_SEC,
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
      nowSec: NOW_SEC,
    });

    expect(result.metadata?.redemption).toMatchObject({ capacityUsd: 0, routeStatus: "open" });
  });

  it("marks the route paused when buyGem is disabled", async () => {
    const { spec } = tronNetwork({
      words: { ...defaultPsmWords(), "buyEnabled()": toWord(0n) },
    });
    const { result } = await runAdapter("usdd-data-platform", "usdd-tron-dao-reserve", {
      network: spec,
      nowSec: NOW_SEC,
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
      nowSec: NOW_SEC,
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
      nowSec: NOW_SEC,
    });

    expect(result.metadata?.redemption).toBeUndefined();
  });

  it("withholds redemption telemetry when the request throws", async () => {
    const { spec } = tronNetwork({ fail: true });
    const { result } = await runAdapter("usdd-data-platform", "usdd-tron-dao-reserve", {
      network: spec,
      nowSec: NOW_SEC,
    });

    expect(result.metadata?.redemption).toBeUndefined();
  });

});
