import { describe, it, expect } from "vitest";
import {
  adaptSkyModules,
  listUnknownGroups,
  resolveSkyTimestampSummary,
  resolveSkyImmediateRedeemableUsd,
  type SkyGroupResult,
} from "../sky-makercore";
import {
  expectWarningEffect,
  installAdapterNetwork,
  runAdapter,
  type AdapterNetworkSpec,
} from "./reserve-adapter.test-support";

const SKY_URL = "https://info-sky.blockanalitica.com/groups/?days_ago=1&order=-debt";
const SKY_NOW = Date.parse("2026-04-05T17:34:24Z") / 1000;
const SKY_LITE_PSM_USDC_ADDRESS = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const SKY_LITE_PSM_USDC_POCKET = "0x37305b1cd40574E4C5Ce33f8e8306Be057fD7341";
const GEM_SELECTOR = "0x7bd2bea7";
const POCKET_SELECTOR = "0xcccef9e2";

function encodeAddressWord(address: string): string {
  return `0x${address.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;
}
interface SkyNetworkOptions {
  capacity?: boolean;
  balance?: bigint;
}

function skyNetwork(groups: SkyGroupResult[], options: SkyNetworkOptions = {}): AdapterNetworkSpec {
  const capacityAvailable = options.capacity ?? true;
  return {
    json: { [SKY_URL]: { count: groups.length, results: groups } },
    rpc: {
      [`ethereum:${GEM_SELECTOR}`]: capacityAvailable ? encodeAddressWord(SKY_LITE_PSM_USDC_ADDRESS) : null,
      [`ethereum:${POCKET_SELECTOR}`]: capacityAvailable ? encodeAddressWord(SKY_LITE_PSM_USDC_POCKET) : null,
      "ethereum:0x70a08231": capacityAvailable ? (options.balance ?? 123_456_000000n) : null,
    },
  };
}

function runSky(
  groups: SkyGroupResult[],
  networkOptions: SkyNetworkOptions = {},
  runOptions: { nowSec?: number; signal?: AbortSignal } = {},
) {
  return runAdapter("sky-makercore", "usds-sky", {
    network: installAdapterNetwork(skyNetwork(groups, networkOptions)),
    nowSec: runOptions.nowSec ?? SKY_NOW,
    ...(runOptions.signal ? { signal: runOptions.signal } : {}),
  });
}

const SAMPLE_GROUPS: SkyGroupResult[] = [
  {
    group: "stablecoins",
    group_name: "Stablecoins",
    debt: "4848053264.74",
    collateral: "4848920495.92",
    datetime: "2026-04-05T17:33:24.053849",
  },
  {
    group: "spark",
    group_name: "Spark",
    debt: "3604127984.82",
    collateral: "3604127984.82",
    datetime: "2026-04-05T17:33:24.053849",
  },
  {
    group: "grove",
    group_name: "Grove",
    debt: "2942299611.45",
    collateral: "2942299611.45",
    datetime: "2026-04-05T17:33:24.053849",
  },
  {
    group: "obex",
    group_name: "Obex",
    debt: "605813016.00",
    collateral: "605813016.00",
    datetime: "2026-04-05T17:33:24.053849",
  },
  {
    group: "core",
    group_name: "Core",
    debt: "524177048.08",
    collateral: "1744997221.98",
    datetime: "2026-04-05T17:33:24.053849",
  },
  {
    group: "staked",
    group_name: "Staking Engine",
    debt: "153348644.44",
    collateral: "1213000185.95",
    datetime: "2026-04-05T17:33:24.053849",
  },
  {
    group: "legacy-rwa",
    group_name: "Legacy RWA",
    debt: "104787191.81",
    collateral: "104787191.81",
    datetime: "2026-04-05T17:33:24.053849",
  },
];

describe("adaptSkyModules", () => {
  it("rejects drift removing stablecoins.collateral", async () => {
    const groups = structuredClone(SAMPLE_GROUPS);
    Reflect.deleteProperty(groups[0], "collateral");
    await expect(runSky(groups)).rejects.toThrow(/stablecoins.collateral/);
  });

  it("produces 7 slices from all known modules", () => {
    const slices = adaptSkyModules(SAMPLE_GROUPS);
    expect(slices).toHaveLength(7);
    const total = slices.reduce((sum, s) => sum + s.pct, 0);
    expect(total).toBe(100);
  });

  it("assigns correct risk levels per module", () => {
    const slices = adaptSkyModules(SAMPLE_GROUPS);
    const byName = Object.fromEntries(slices.map((s) => [s.name, s]));

    expect(byName["Stablecoins (PSM)"].risk).toBe("very-low");
    expect(byName["Stablecoins (PSM)"].sourceKey).toBe("sky-makercore:module:stablecoins");
    // Sky PSM aggregates multiple stables (USDC/USDT/USDP) without per-stable
    // breakdown; the slice is intentionally unattributed.
    expect(byName["Stablecoins (PSM)"].coinId).toBeUndefined();
    expect(byName["Stablecoins (PSM)"].depType).toBeUndefined();

    expect(byName["Spark (lending)"].risk).toBe("low");
    expect(byName["Spark (lending)"].sourceKey).toBe("sky-makercore:module:spark");
    expect(byName["Grove (RWA)"].risk).toBe("low");
    expect(byName["Grove (RWA)"].sourceKey).toBe("sky-makercore:module:grove");
    expect(byName["Obex"].risk).toBe("medium");
    expect(byName["Obex"].sourceKey).toBe("sky-makercore:module:obex");
    expect(byName["Core (crypto vaults)"].risk).toBe("medium");
    expect(byName["Core (crypto vaults)"].sourceKey).toBe("sky-makercore:module:core");
    expect(byName["Staking Engine"].risk).toBe("high");
    expect(byName["Staking Engine"].sourceKey).toBe("sky-makercore:module:staked");
    expect(byName["Legacy RWA"].risk).toBe("low");
    expect(byName["Legacy RWA"].sourceKey).toBe("sky-makercore:module:legacy-rwa");
  });

  it("stablecoins slice is the largest by percentage", () => {
    const slices = adaptSkyModules(SAMPLE_GROUPS);
    const stableSlice = slices.find((s) => s.name === "Stablecoins (PSM)")!;
    const maxPct = Math.max(...slices.map((s) => s.pct));
    expect(stableSlice.pct).toBe(maxPct);
  });

  it("omits modules with zero debt", () => {
    const withZero: SkyGroupResult[] = [
      {
        group: "stablecoins",
        group_name: "Stablecoins",
        debt: "5000000000",
        collateral: "5000000000",
        datetime: "2026-04-05T17:33:24",
      },
      { group: "legacy-rwa", group_name: "Legacy RWA", debt: "0", collateral: "0", datetime: "2026-04-05T17:33:24" },
    ];
    const slices = adaptSkyModules(withZero);
    expect(slices).toHaveLength(1);
    expect(slices[0].pct).toBe(100);
  });

  it("returns empty when all debts are zero", () => {
    const allZero: SkyGroupResult[] = [
      { group: "stablecoins", group_name: "Stablecoins", debt: "0", collateral: "0", datetime: "2026-04-05T17:33:24" },
    ];
    expect(adaptSkyModules(allZero)).toEqual([]);
  });

  it("buckets unknown groups into Other modules with high risk", () => {
    const withUnknown: SkyGroupResult[] = [
      {
        group: "stablecoins",
        group_name: "Stablecoins",
        debt: "9000000000",
        collateral: "9000000000",
        datetime: "2026-04-05T17:33:24",
      },
      {
        group: "new-module",
        group_name: "New Module",
        debt: "1000000000",
        collateral: "1000000000",
        datetime: "2026-04-05T17:33:24",
      },
    ];
    const slices = adaptSkyModules(withUnknown);
    const otherSlice = slices.find((s) => s.name === "Other modules");
    expect(otherSlice).toBeDefined();
    expect(otherSlice!.risk).toBe("high");
    expect(otherSlice!.sourceKey).toBe("sky-makercore:module:other-modules");
    expect(otherSlice!.assetClass).toBe("other");
    expect(otherSlice!.issuerOrObligor).toBe("Sky unknown module");
    expect(otherSlice!.pct).toBe(10);
  });

  it("maps the osero and keel allocators to medium risk without a guessed coinId", () => {
    const withAllocators: SkyGroupResult[] = [
      {
        group: "stablecoins",
        group_name: "Stablecoins",
        debt: "9000000000",
        collateral: "9000000000",
        datetime: "2026-04-05T17:33:24",
      },
      {
        group: "osero",
        group_name: "Osero",
        debt: "25000000",
        collateral: "25000000",
        datetime: "2026-04-05T17:33:24",
      },
      {
        group: "keel",
        group_name: "Keel",
        debt: "5000000",
        collateral: "5000000",
        datetime: "2026-04-05T17:33:24",
      },
    ];
    const slices = adaptSkyModules(withAllocators);
    const byName = Object.fromEntries(slices.map((s) => [s.name, s]));

    expect(byName["Osero"]).toMatchObject({ risk: "medium", sourceKey: "sky-makercore:module:osero" });
    expect(byName["Osero"].coinId).toBeUndefined();
    expect(byName["Keel"]).toMatchObject({ risk: "medium", sourceKey: "sky-makercore:module:keel" });
    expect(byName["Keel"].coinId).toBeUndefined();
    expect(byName["Other modules"]).toBeUndefined();
  });
});

describe("resolveSkyImmediateRedeemableUsd", () => {
  it("returns stablecoins module collateral as redeemable", () => {
    expect(resolveSkyImmediateRedeemableUsd(SAMPLE_GROUPS)).toBe(4848920495.92);
  });

  it("returns 0 when no stablecoins module exists", () => {
    const noStable: SkyGroupResult[] = [
      {
        group: "core",
        group_name: "Core",
        debt: "500000000",
        collateral: "1500000000",
        datetime: "2026-04-05T17:33:24",
      },
    ];
    expect(resolveSkyImmediateRedeemableUsd(noStable)).toBe(0);
  });
});

describe("listUnknownGroups", () => {
  it("identifies groups not in the known set", () => {
    const groups: SkyGroupResult[] = [
      {
        group: "stablecoins",
        group_name: "Stablecoins",
        debt: "100",
        collateral: "100",
        datetime: "2026-04-05T17:33:24",
      },
      { group: "mystery", group_name: "Mystery", debt: "50", collateral: "50", datetime: "2026-04-05T17:33:24" },
    ];
    const unknown = listUnknownGroups(groups);
    expect(unknown).toContain("mystery");
    expect(unknown).not.toContain("stablecoins");
  });
});

describe("resolveSkyTimestampSummary", () => {
  it("uses the oldest positive-debt group datetime as source timestamp", () => {
    const summary = resolveSkyTimestampSummary([
      {
        group: "stablecoins",
        group_name: "Stablecoins",
        debt: "100",
        collateral: "100",
        datetime: "2026-04-05T17:33:24",
      },
      { group: "spark", group_name: "Spark", debt: "50", collateral: "50", datetime: "2026-04-05T18:33:24" },
      { group: "legacy-rwa", group_name: "Legacy", debt: "0", collateral: "0", datetime: "2026-04-01T00:00:00" },
    ]);

    expect(summary).toMatchObject({
      sourceTimestamp: Date.parse("2026-04-05T17:33:24") / 1000,
      latestSourceTimestamp: Date.parse("2026-04-05T18:33:24") / 1000,
      sourceTimestampSpreadSec: 3600,
      timestampCount: 2,
    });
  });
});

describe("fetchSkyMakercoreReserves PSM attribution", () => {
  it("PSM slice carries no coinId attribution and metadata surfaces the multi-stable note", async () => {
    const groups: SkyGroupResult[] = [
      {
        group: "stablecoins",
        group_name: "Stablecoins",
        debt: "4000000000",
        collateral: "4000000000",
        datetime: "2026-04-05T17:33:24",
      },
      {
        group: "spark",
        group_name: "Spark",
        debt: "3000000000",
        collateral: "3000000000",
        datetime: "2026-04-05T17:33:24",
      },
    ];
    const { result, network } = await runSky(groups);
    const psmSlice = result.slices.find((s) => s.name === "Stablecoins (PSM)");
    expect(psmSlice).toBeDefined();
    expect(psmSlice?.coinId).toBeUndefined();
    expect(psmSlice?.depType).toBeUndefined();

    const details = result.metadata?.details as { psmComposition?: string };
    expect(details?.psmComposition).toMatch(/USDC.*USDT.*USDP/);
    expect(result.metadata?.skyStablecoinsModuleCollateralUsd).toBe(4000000000);
    expect(result.metadata?.totalReserveUsd).toBe(7000000000);
    expect(result.metadata?.totalLiabilitiesUsd).toBe(7000000000);
    expect(result.metadata?.collateralizationRatio).toBe(1);
    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: 123456,
      capacityKind: "live-direct",
      freshnessKind: "same-run-onchain",
      routeStatus: "open",
      routeStatusSource: "onchain",
      holderEligibility: "any-holder",
      settlementDelaySec: 0,
    });
    expect(network.rpcCalls).toContainEqual(expect.objectContaining({
      chain: "ethereum",
      contract: SKY_LITE_PSM_USDC_ADDRESS,
      selector: "0x70a08231",
    }));
  });

  it("falls back without redemption metadata when LitePSM capacity is unavailable", async () => {
    const groups: SkyGroupResult[] = [
      {
        group: "stablecoins",
        group_name: "Stablecoins",
        debt: "4000000000",
        collateral: "4000000000",
        datetime: "2026-04-05T17:33:24",
      },
      {
        group: "spark",
        group_name: "Spark",
        debt: "3000000000",
        collateral: "3000000000",
        datetime: "2026-04-05T17:33:24",
      },
    ];
    const { result } = await runSky(groups, { capacity: false });

    expect(result.metadata?.redemption).toBeUndefined();
    expect(result.metadata?.immediateRedeemableUsd).toBeUndefined();
    expect(result.metadata?.skyStablecoinsModuleCollateralUsd).toBe(4000000000);
    expect(result.metadata?.details).toMatchObject({ litePsmCapacity: "unavailable" });
  });

  it.each([
    ["zero", "0", false, false],
    ["immaterial", "1", true, false],
    ["material", "1000000000", true, true],
  ] as const)(
    "lets the shared materiality policy classify %s unknown debt",
    async (_label, unknownDebt, emitsDiscovery, degraded) => {
      const groups: SkyGroupResult[] = [
        {
          group: "stablecoins",
          group_name: "Stablecoins",
          debt: "9000000000",
          collateral: "9000000000",
          datetime: "2026-04-05T17:33:24",
        },
        {
          group: "new-module",
          group_name: "New Module",
          debt: unknownDebt,
          collateral: unknownDebt,
          datetime: "2026-04-05T17:33:24",
        },
      ];
      const { result, report } = await runSky(groups);
      expect(
        result.warnings?.some((warning) => warning.code === "unknown-asset" && warning.effect === "info") ?? false,
      ).toBe(emitsDiscovery);
      expect(
        report.warnings.some(
          (warning) => warning.code === "material-unknown-exposure" && warning.effect === "degraded",
        ),
      ).toBe(degraded);
    },
  );

  it("degrades when an unknown module has malformed debt", async () => {
    const groups: SkyGroupResult[] = [
      {
        group: "stablecoins",
        group_name: "Stablecoins",
        debt: "9000000000",
        collateral: "9000000000",
        datetime: "2026-04-05T17:33:24",
      },
      {
        group: "new-module",
        group_name: "New Module",
        debt: "1,000,000,000",
        collateral: "1000000000",
        datetime: "2026-04-05T17:33:24",
      },
    ];
    const { result } = await runSky(groups);

    expect(result.metadata?.unknownExposurePct).toBe(0);
    expectWarningEffect(result, "unknown-asset", "degraded");
  });

  it("degrades when a known module has malformed debt", async () => {
    const groups: SkyGroupResult[] = [
      {
        group: "stablecoins",
        group_name: "Stablecoins",
        debt: "9,000,000,000",
        collateral: "9000000000",
        datetime: "2026-04-05T17:33:24",
      },
      {
        group: "spark",
        group_name: "Spark",
        debt: "1000000000",
        collateral: "1000000000",
        datetime: "2026-04-05T17:33:24",
      },
    ];
    const { result } = await runSky(groups);

    expectWarningEffect(result, "malformed-debt", "degraded");
  });

  it("propagates an aborted signal before publishing a snapshot", async () => {
    const groups: SkyGroupResult[] = [
      {
        group: "stablecoins",
        group_name: "Stablecoins",
        debt: "4000000000",
        collateral: "4000000000",
        datetime: "2026-04-05T17:33:24",
      },
      {
        group: "spark",
        group_name: "Spark",
        debt: "3000000000",
        collateral: "3000000000",
        datetime: "2026-04-05T17:33:24",
      },
    ];
    const controller = new AbortController();
    const reason = new Error("cron timed out");
    controller.abort(reason);

    await expect(runSky(groups, {}, { signal: controller.signal })).rejects.toBe(reason);
  });
});
