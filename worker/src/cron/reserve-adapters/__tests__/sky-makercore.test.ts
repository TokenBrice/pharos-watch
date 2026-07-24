import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import {
  adaptSkyModules,
  fetchSkyMakercoreReserves,
  listUnknownGroups,
  resolveSkyTimestampSummary,
  resolveSkyImmediateRedeemableUsd,
  type SkyGroupResult,
} from "../sky-makercore";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  const fetchOnchainRawCall = vi.fn();
  const fetchOnchainUint256 = vi.fn();
  return {
    ...actual,
    fetchJsonWithRetry: vi.fn(),
    fetchOnchainRawCall,
    fetchOnchainUint256,
    makeOnchainCallers: vi.fn((input, options) => ({
      uint256: (contract: string, data: string) =>
        fetchOnchainUint256({
          ...options,
          contract,
          data,
          rpcMode: input.rpcMode,
          chain: input.chain,
        }),
      raw: (contract: string, data: string) =>
        fetchOnchainRawCall({
          ...options,
          contract,
          data,
          rpcMode: input.rpcMode,
          chain: input.chain,
        }),
    })),
  };
});

import { fetchJsonWithRetry, fetchOnchainRawCall, fetchOnchainUint256 } from "../helpers";
import { getReserveAdapter } from "../index";
import { validateAdapterOutput } from "../validate";

const signal = AbortSignal.timeout(5000);
const SKY_LITE_PSM_USDC_ADDRESS = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const SKY_LITE_PSM_USDC_POCKET = "0x37305b1cd40574E4C5Ce33f8e8306Be057fD7341";
const GEM_SELECTOR = "0x7bd2bea7";
const POCKET_SELECTOR = "0xcccef9e2";

function encodeAddressWord(address: string): string {
  return `0x${address.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;
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
    // Sky PSM aggregates multiple stables (USDC/USDT/USDP) without per-stable
    // breakdown; the slice is intentionally unattributed.
    expect(byName["Stablecoins (PSM)"].coinId).toBeUndefined();
    expect(byName["Stablecoins (PSM)"].depType).toBeUndefined();

    expect(byName["Spark (lending)"].risk).toBe("low");
    expect(byName["Grove (RWA)"].risk).toBe("low");
    expect(byName["Obex"].risk).toBe("medium");
    expect(byName["Core (crypto vaults)"].risk).toBe("medium");
    expect(byName["Staking Engine"].risk).toBe("high");
    expect(byName["Legacy RWA"].risk).toBe("low");
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
    expect(otherSlice!.pct).toBe(10);
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
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchOnchainRawCall).mockImplementation(async ({ data }) => {
      if (data === GEM_SELECTOR) return encodeAddressWord(SKY_LITE_PSM_USDC_ADDRESS);
      if (data === POCKET_SELECTOR) return encodeAddressWord(SKY_LITE_PSM_USDC_POCKET);
      return null;
    });
    vi.mocked(fetchOnchainUint256).mockResolvedValue(123_456_000000n);
  });

  const coin = { id: "usds-sky" } as unknown as StablecoinMeta;
  const config: LiveReservesConfig = {
    adapter: "sky-makercore",
    version: 1,
    semantics: "protocol-reserve",
    inputs: {
      primary: {
        kind: "http-json",
        url: "https://info-sky.blockanalitica.com/groups/?days_ago=1&order=-debt",
      },
    },
  };

  it("PSM slice carries no coinId attribution and metadata surfaces the multi-stable note", async () => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValue({
      count: 2,
      results: [
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
      ],
    });

    const result = await fetchSkyMakercoreReserves(coin, config, signal);
    const psmSlice = result.slices.find((s) => s.name === "Stablecoins (PSM)");
    expect(psmSlice).toBeDefined();
    expect(psmSlice?.coinId).toBeUndefined();
    expect(psmSlice?.depType).toBeUndefined();

    const details = result.metadata?.details as { psmComposition?: string };
    expect(details?.psmComposition).toMatch(/USDC.*USDT.*USDP/);
    expect(result.metadata?.skyStablecoinsModuleCollateralUsd).toBe(4000000000);
    expect(result.metadata?.immediateRedeemableUsd).toBe(123456);
    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: 123456,
      capacityKind: "live-direct",
      freshnessKind: "same-run-onchain",
      routeStatus: "open",
      routeStatusSource: "onchain",
      holderEligibility: "any-holder",
      settlementDelaySec: 0,
    });
    expect(fetchOnchainUint256).toHaveBeenCalledWith(
      expect.objectContaining({
        chain: "ethereum",
        contract: SKY_LITE_PSM_USDC_ADDRESS,
      }),
    );
  });

  it("falls back without redemption metadata when LitePSM capacity is unavailable", async () => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValue({
      count: 2,
      results: [
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
      ],
    });
    vi.mocked(fetchOnchainRawCall).mockResolvedValue(null);

    const result = await fetchSkyMakercoreReserves(coin, config, signal);

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
      vi.mocked(fetchJsonWithRetry).mockResolvedValue({
        count: 2,
        results: [
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
        ],
      });

      const result = await fetchSkyMakercoreReserves(coin, config, signal);
      expect(
        result.warnings?.some((warning) => warning.code === "unknown-asset" && warning.effect === "info") ?? false,
      ).toBe(emitsDiscovery);
      const validation = validateAdapterOutput(result, {
        adapter: getReserveAdapter("sky-makercore") ?? undefined,
        now: Date.parse("2026-04-05T17:34:24Z") / 1_000,
      });
      expect(
        validation.warnings.some(
          (warning) => warning.code === "material-unknown-exposure" && warning.effect === "degraded",
        ),
      ).toBe(degraded);
    },
  );

  it("propagates aborts from the optional LitePSM capacity read", async () => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValue({
      count: 2,
      results: [
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
      ],
    });
    const controller = new AbortController();
    const reason = new Error("cron timed out");
    controller.abort(reason);
    vi.mocked(fetchOnchainRawCall).mockRejectedValue(new Error("rpc aborted"));

    await expect(fetchSkyMakercoreReserves(coin, config, controller.signal)).rejects.toBe(reason);
  });
});
