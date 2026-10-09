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
import captureDerived from "./fixtures/sky-makercore-capture-derived.json";

const SKY_URL = "https://info-sky.blockanalitica.com/groups/?days_ago=1&order=-debt";
const SKY_NOW = Date.parse("2026-04-05T17:34:24Z") / 1000;
const SKY_LITE_PSM_USDC_ADDRESS = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const SKY_LITE_PSM_USDC_POCKET = "0x37305b1cd40574E4C5Ce33f8e8306Be057fD7341";
const GEM_SELECTOR = "0x7bd2bea7";
const POCKET_SELECTOR = "0xcccef9e2";
const TIN_SELECTOR = "0x568d4b6f";
const TOUT_SELECTOR = "0xfae036d5";
const HALTED_SWAP_FEE = (1n << 256n) - 1n;

function encodeAddressWord(address: string): string {
  return `0x${address.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;
}
interface SkyNetworkOptions {
  capacity?: boolean;
  balance?: bigint;
  gem?: string;
  pocket?: string;
  tin?: bigint | null;
  tout?: bigint | null;
}

function skyNetwork(groups: SkyGroupResult[], options: SkyNetworkOptions = {}): AdapterNetworkSpec {
  const capacityAvailable = options.capacity ?? true;
  return {
    json: { [SKY_URL]: { count: groups.length, results: groups } },
    rpc: {
      [`ethereum:${GEM_SELECTOR}`]: capacityAvailable ? encodeAddressWord(options.gem ?? SKY_LITE_PSM_USDC_ADDRESS) : null,
      [`ethereum:${POCKET_SELECTOR}`]: capacityAvailable ? encodeAddressWord(options.pocket ?? SKY_LITE_PSM_USDC_POCKET) : null,
      [`ethereum:${TIN_SELECTOR}`]: capacityAvailable ? (options.tin === undefined ? 0n : options.tin) : null,
      [`ethereum:${TOUT_SELECTOR}`]: capacityAvailable ? (options.tout === undefined ? 0n : options.tout) : null,
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

  it("assigns correct risk levels per module", () => {
    const slices = adaptSkyModules(SAMPLE_GROUPS);
    const byName = Object.fromEntries(slices.map((s) => [s.name, s]));

    expect(byName["Unattributed stablecoins (PSM)"].risk).toBe("very-low");
    expect(byName["Unattributed stablecoins (PSM)"].coinId).toBeUndefined();

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
      sourceTimestamp: Date.parse("2026-04-05T17:33:24Z") / 1000,
      latestSourceTimestamp: Date.parse("2026-04-05T18:33:24Z") / 1000,
      sourceTimestampSpreadSec: 3600,
      timestampCount: 2,
    });
  });

  it.each(["", "2026-02-30T17:33:24"])("counts all invalid material clocks without borrowing a zero-debt clock (%s)", (datetime) => {
    const summary = resolveSkyTimestampSummary([
      { group: "spark", group_name: "Spark", debt: "100", collateral: "100", datetime },
      { group: "legacy-rwa", group_name: "Legacy", debt: "0", collateral: "0", datetime: "2026-04-05T17:33:24" },
    ]);
    expect(summary).toEqual({
      sourceTimestamp: null,
      latestSourceTimestamp: null,
      sourceTimestampSpreadSec: null,
      timestampCount: 0,
      untimestampedCount: 1,
    });
  });

  it.each([true, false])("withholds verified metadata for incomplete material coverage (all missing: %s)", async (allMissing) => {
    const groups = SAMPLE_GROUPS.map((group, index) => ({
      ...group,
      datetime: allMissing || index === 0 ? "" : group.datetime,
    }));
    const { result } = await runSky(groups);
    expect(result.metadata?.freshnessMode).toBe("unverified");
    expect(result.metadata?.sourceTimestamp).toBeUndefined();
    expect(result.metadata?.snapshotDate).toBeUndefined();
    expectWarningEffect(result, "source-timestamp-coverage-incomplete", "degraded");
  });
});

describe("fetchSkyMakercoreReserves PSM attribution", () => {
  it.each(["usds-sky", "dai-makerdao"])("reconciles the capture-derived reconstruction for %s", async (coinId) => {
    const measuredUsd = Number(captureDerived.measuredUsdcBalanceRaw) / 1e6;
    const groupDebt = Number(captureDerived.groups[0].debt);
    const { result } = await runAdapter("sky-makercore", coinId, {
      network: installAdapterNetwork(skyNetwork(captureDerived.groups, {
        balance: BigInt(captureDerived.measuredUsdcBalanceRaw),
      })),
      nowSec: Date.parse(captureDerived.groups[0].datetime) / 1000 + 60,
    });
    expect(result.slices.find((slice) => slice.coinId === "usdc-circle")?.pct).toBeCloseTo(39.4, 10);
    expect(result.slices.some((slice) => typeof slice.sourceKey === "string"
      && slice.sourceKey.endsWith("stablecoins-residual"))).toBe(false);
    expect(result.metadata).toMatchObject({
      balanceSheetScope: "shared-sky-maker",
      sharedBookAssetIds: ["dai-makerdao", "usds-sky"],
      sharedBookMeasuredHoldings: { "usdc-circle": measuredUsd },
      reconciliationExcessUsd: measuredUsd - groupDebt,
    });
    expect(result.metadata?.reconciliationExcessShare).toBeCloseTo((measuredUsd - groupDebt) / captureDerived.totalGroupDebtUsd, 12);
    expect(result.slices.reduce((sum, slice) => sum + slice.pct, 0)).toBeCloseTo(100, 10);
    expect(result.slices.some((slice) => ["usdt-tether", "usdp-paxos"].includes(slice.coinId ?? ""))).toBe(false);
  });

  it.each([
    [40_249_999n, true],
    [40_250_000n, true],
    [40_250_001n, false],
  ] as const)("applies the absolute 0.25 percentage-point reconciliation boundary (%s)", async (balance, admitted) => {
    const { result } = await runSky([
      { group: "stablecoins", group_name: "Stablecoins", debt: "40", collateral: "40", datetime: "2026-04-05T17:33:24" },
      { group: "spark", group_name: "Spark", debt: "60", collateral: "60", datetime: "2026-04-05T17:33:24" },
    ], { balance });
    expect(result.slices.some((slice) => slice.coinId === "usdc-circle")).toBe(admitted);
    if (admitted) {
      expect(result.slices.find((slice) => slice.coinId === "usdc-circle")?.pct).toBe(40);
    } else {
      expect(result.metadata?.reconciliationIssue).toBe("litepsm-reconciliation-excess");
      expectWarningEffect(result, "litepsm-reconciliation-excess", "info");
      expect(result.slices.find((slice) => slice.sourceKey === "sky-makercore:module:stablecoins-residual"))
        .toMatchObject({ pct: 40, risk: "very-low", assetClass: "stablecoin" });
    }
    expect(result.slices.reduce((sum, slice) => sum + slice.pct, 0)).toBeCloseTo(100, 10);
  });

  it("does not create legacy edges or a USDC edge for a verified zero pocket", async () => {
    const { result } = await runSky(SAMPLE_GROUPS, { balance: 0n });
    expect(result.slices.filter((slice) => slice.coinId)).toEqual([]);
    expect(result.slices.find((slice) => slice.sourceKey === "sky-makercore:module:stablecoins-residual")?.pct)
      .toBeCloseTo(Number(SAMPLE_GROUPS[0].debt) / SAMPLE_GROUPS.reduce((sum, row) => sum + Number(row.debt), 0) * 100, 10);
  });
  it.each(["gem", "pocket"] as const)("withholds attribution when the pinned %s identity differs", async (field) => {
    const { result } = await runSky(SAMPLE_GROUPS, { [field]: "0x0000000000000000000000000000000000000001" });
    expect(result.slices.filter((slice) => slice.coinId)).toEqual([]);
    expect(result.metadata?.sharedBookMeasuredHoldings).toBeUndefined();
    expect(result.slices.find((slice) => slice.sourceKey === "sky-makercore:module:stablecoins-residual")?.risk)
      .toBe("very-low");
  });


  it.each(["", "invalid"])("withholds verified freshness for 90%% undated debt (%s)", async (datetime) => {
    const { result } = await runSky([
      { group: "stablecoins", group_name: "Stablecoins", debt: "100", collateral: "100", datetime: "2026-04-05T17:33:24" },
      { group: "spark", group_name: "Spark", debt: "900", collateral: "900", datetime },
    ]);
    expect(result.metadata?.freshnessMode).toBe("unverified");
    expect(result.metadata?.sourceTimestamp).toBeUndefined();
    expect(result.metadata?.snapshotDate).toBeUndefined();
    expectWarningEffect(result, "source-timestamp-coverage-incomplete", "degraded");
    expect(result.slices.find((slice) => slice.pct === 90)?.pct).toBe(90);
  });

  it("ignores an undated zero-debt row for contributing timestamp coverage", async () => {
    const { result } = await runSky([
      { group: "stablecoins", group_name: "Stablecoins", debt: "100", collateral: "100", datetime: "2026-04-05T17:33:24" },
      { group: "spark", group_name: "Spark", debt: "0", collateral: "0", datetime: "" },
    ]);
    expect(result.metadata?.freshnessMode).toBe("verified");
    expect(result.metadata?.sourceTimestampCount).toBe(1);
    expect(result.warnings?.some((warning) => warning.code === "source-timestamp-coverage-incomplete") ?? false).toBe(false);
  });

  it("publishes one shared system book for both DAI and USDS without allocation", async () => {
    for (const coinId of ["dai-makerdao", "usds-sky"]) {
      const { result } = await runAdapter("sky-makercore", coinId, {
        network: installAdapterNetwork(skyNetwork(SAMPLE_GROUPS)),
        nowSec: SKY_NOW,
      });
      expect(result.metadata).toMatchObject({
        balanceSheetScope: "shared-sky-maker",
        sharedBookAssetIds: ["dai-makerdao", "usds-sky"],
        sharedBookMeasuredHoldings: { "usdc-circle": 123456 },
        totalLiabilitiesUsd: Math.round(SAMPLE_GROUPS.reduce((sum, row) => sum + Number(row.debt), 0)),
      });
    }
  });

  it("attributes only measured canonical USDC and leaves the remainder unlinked", async () => {
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
    const usdc = result.slices.find((slice) => slice.coinId === "usdc-circle");
    const residual = result.slices.find((slice) => slice.sourceKey === "sky-makercore:module:stablecoins-residual");
    expect(usdc).toMatchObject({ depType: "collateral", sourceKey: "sky-makercore:lite-psm:usdc" });
    expect(usdc?.pct).toBeCloseTo(123456 / 7000000000 * 100, 10);
    expect(residual?.pct).toBeCloseTo((4000000000 - 123456) / 7000000000 * 100, 10);
    expect(residual).toMatchObject({ risk: "very-low", assetClass: "stablecoin" });
    expect(residual?.coinId).toBeUndefined();
    expect(result.slices.reduce((sum, slice) => sum + slice.pct, 0)).toBeCloseTo(100, 10);
    expect(result.slices.filter((slice) => slice.coinId && slice.coinId !== "usdc-circle")).toEqual([]);
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
    expect(network.rpcCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ selector: TIN_SELECTOR }),
      expect.objectContaining({ selector: TOUT_SELECTOR }),
    ]));
  });

  it.each([
    [{ tout: HALTED_SWAP_FEE }, "paused", "onchain"],
    [{ tin: null }, "unknown", "static-config"],
  ] as const)("publishes %s LitePSM route evidence without changing capacity", async (
    networkOptions,
    routeStatus,
    routeStatusSource,
  ) => {
    const { result } = await runSky(SAMPLE_GROUPS, networkOptions);

    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: 123456,
      routeStatus,
      routeStatusSource,
    });
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
    expectWarningEffect(result, "litepsm-attribution-unavailable", "info");
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

  it("rejects the shared book when an unknown module has malformed debt", async () => {
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
    await expect(runSky(groups)).rejects.toThrow(/new-module\.debt/);
  });

  it("rejects the shared book when a known module has malformed debt", async () => {
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
    await expect(runSky(groups)).rejects.toThrow(/stablecoins\.debt/);
  });

  it.each(["", "-1", "NaN", "Infinity", "0x10"])("rejects unreadable group debt before normalizing the mix (%s)", async (debt) => {
    const groups: SkyGroupResult[] = [
      { group: "spark", group_name: "Spark", debt: "900", collateral: "900", datetime: "2026-04-05T17:33:24" },
      { group: "new-module", group_name: "New Module", debt, collateral: "1000", datetime: "2026-04-05T17:33:24" },
    ];
    expect(() => adaptSkyModules(groups)).toThrow(/new-module\.debt/);
    await expect(runSky(groups)).rejects.toThrow(/new-module\.debt/);
  });

  it("publishes complete shared-book statistics for genuine zero and positive debt", async () => {
    const { result } = await runSky([
      { group: "spark", group_name: "Spark", debt: "900", collateral: "1000", datetime: "2026-04-05T17:33:24" },
      { group: "new-module", group_name: "New Module", debt: "100", collateral: "100", datetime: "2026-04-05T17:33:24" },
      { group: "legacy-rwa", group_name: "Legacy RWA", debt: "0", collateral: "0", datetime: "" },
    ], { capacity: false });

    expect(result.metadata).toMatchObject({
      totalLiabilitiesUsd: 1000,
      totalReserveUsd: 1100,
      collateralizationRatio: 1.1,
      unknownExposurePct: 10,
    });
    expect(result.slices.find((slice) => slice.name === "Other modules")?.pct).toBe(10);
    expect(result.warnings?.some((warning) => warning.code === "source-timestamp-coverage-incomplete")).toBe(false);
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
