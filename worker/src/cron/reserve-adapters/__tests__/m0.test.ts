import { afterEach, describe, expect, it, vi } from "vitest";
import musdReserves from "@shared/data/stablecoins/domains/reserves/musd-metamask.json";
import ctusdReserves from "@shared/data/stablecoins/domains/reserves/ctusd-citrea.json";
import usdatReserves from "@shared/data/stablecoins/domains/reserves/usdat-saturn.json";
import ctusdCoin from "@shared/data/stablecoins/coins/ctusd-citrea.json";
import usdatCoin from "@shared/data/stablecoins/coins/usdat-saturn.json";
import type { StablecoinMeta } from "@shared/types/core";
import type * as OnchainModule from "../onchain";
import * as onchain from "../onchain";
import type { OnchainLogEntry } from "../onchain";
import { adaptM0Collateral, adaptM0OnchainCollateral } from "../m0";
import { getReserveAdapter } from "../index";
import { validateAdapterOutput } from "../validate";
import { expectWarningEffect, expectWarnings, runAdapter } from "./reserve-adapter.test-support";

// The CollateralUpdated scan is the only M0 on-chain fallback step the adapter
// harness cannot answer (it routes eth_call/block methods only), so it is
// wrapped here: tests can script a completed window scan, while the default
// implementation still exercises the real vetted RPC log path and its
// fail-closed `complete: false` result.
vi.mock("../onchain", async (importOriginal) => {
  const actual = await importOriginal<typeof OnchainModule>();
  return { ...actual, fetchOnchainLogs: vi.fn(actual.fetchOnchainLogs) };
});

afterEach(() => {
  vi.mocked(onchain.fetchOnchainLogs).mockClear();
});

// Live payload shape observed against protocol-api.m0.org on 2026-08-20, after
// M0 retired the off-chain CollateralCurrent composition feed and moved the
// endpoint to keyed access. Values are 6-decimal token units.
const SAMPLE_PAYLOAD = {
  data: {
    minterGateway_totalCollateralSnapshots: [
      { timestamp: "1787171387", value: "277097642539488" },
    ],
    minterGateway_minters: [
      { id: "minter-0x1d5b695d13f231a605d231631c688fb33477b249", collateral: "162911451780" },
      { id: "minter-0x5d238f4eac94da0a635ee39fa389a4754395d5d9", collateral: "9799887431160" },
      { id: "minter-0x7f7489582b64abe46c074a45d758d701c2ca5446", collateral: "238711590186548" },
      { id: "minter-0xcd1394d24e1e404f9eb3609f872b0736becb9d74", collateral: "28422026810000" },
    ],
    collateralUpdateds: [
      { timestamp: "1787176804", blockTimestamp: "1787176847" },
    ],
    minterGateway_latestUpdateTimestampSnapshots: [
      { timestamp: "1787176847", value: "1787176847" },
    ],
  },
};

describe("adaptM0Collateral", () => {
  it("keeps M0-backed curated aggregate collateral on the conservative classification", () => {
    for (const coinId of ["musd-metamask"]) {
      const aggregateCollateral = musdReserves.reserves.find(
        ({ name }) => name === "U.S. Treasury bills & cash (M0 eligible collateral)",
      );
      expect(aggregateCollateral, coinId).toMatchObject({
        sourceKey: "m0:eligible-collateral",
        pct: 100,
        risk: "very-low",
        assetClass: "other",
        issuerOrObligor: "M0 permissioned minters and eligible collateral SPVs",
      });
    }
  });

  it("keeps exact extension claims out of the generic M0 collateral cohort", () => {
    const ctusd = { ...ctusdCoin, reserves: ctusdReserves.reserves } as unknown as StablecoinMeta;
    const usdat = { ...usdatCoin, reserves: usdatReserves.reserves } as unknown as StablecoinMeta;

    expect(ctusd?.reserves).toEqual([
      expect.objectContaining({
        name: "M token held by Citrea USD",
        pct: 100,
        coinId: "m-m0",
        depType: "wrapper",
      }),
    ]);
    expect(ctusd?.liveReservesConfig).toMatchObject({
      adapter: "m0-wrapper-underlying",
      breakerScope: "ctusd-citrea",
      params: {
        mode: "m-extension",
        expectedMTokenAddress: "0x866A2BF4E572CbcF37D5071A7a58503Bfb36be1b",
        expectedSwapFacilityAddress: "0xB6807116b3B1B321a390594e31ECD6e0076f6278",
      },
    });

    expect(usdat?.reserves).toEqual([
      expect.objectContaining({
        name: "PYUSDx held by Saturn USDat",
        pct: 100,
        coinId: "pyusd-paypal",
        depType: "wrapper",
      }),
    ]);
    expect(usdat?.liveReservesConfig).toMatchObject({ adapter: "saturn-pyusdx", breakerScope: "usdat-saturn" });
  });

  it("converts the total collateral snapshot into the single protocol-constrained slice", () => {
    const result = adaptM0Collateral(SAMPLE_PAYLOAD);

    expect(result.slices).toEqual([
      {
        sourceKey: "m0:eligible-collateral",
        name: "U.S. Treasury bills & cash (M0 eligible collateral)",
        pct: 100,
        risk: "very-low",
      },
    ]);
    expect(result.warnings).toBeUndefined();
    expect(validateAdapterOutput(result, { adapter: getReserveAdapter("m0") ?? undefined }).valid).toBe(true);
  });

  it("normalizes 6-decimal units and reconciles the per-minter sum in metadata", () => {
    const result = adaptM0Collateral(SAMPLE_PAYLOAD);

    expect(result.metadata).toMatchObject({
      freshnessMode: "verified",
      sourceTimestamp: 1787171387,
      collateralValueDivisor: 1_000_000,
      normalizedReserveTotal: 277_097_642.539488,
      minterCount: 4,
      minterCollateralTotalUsd: 277_096_415.879488,
      earliestCollateralUpdateTimestamp: 1787176804,
      latestCollateralUpdateTimestamp: 1787176847,
      snapshotLagSec: 5460,
      details: {
        collateralLagSec: 5460,
        collateralLagCapSec: 43_200,
      },
    });
    expect(result.metadata?.redemption).toBeUndefined();
  });

  it("tolerates the routine indexing skew between the snapshot and the update stream", () => {
    // Observed live 2026-08-20: the collateral-update events run ~1.5h ahead of
    // the latest total snapshot. That must not degrade every run.
    const result = adaptM0Collateral(SAMPLE_PAYLOAD);
    expect(result.warnings).toBeUndefined();
  });

  it("degrades when the total snapshot lags known collateral updates materially", () => {
    const result = adaptM0Collateral({
      data: {
        ...SAMPLE_PAYLOAD.data,
        collateralUpdateds: [
          // 13h after the total snapshot at 1787171387.
          { timestamp: "1787218187", blockTimestamp: "1787218187" },
        ],
        minterGateway_latestUpdateTimestampSnapshots: [
          { timestamp: "1787218187", value: "1787218187" },
        ],
      },
    });

    expect(result.warnings?.some((warning) => warning.code === "total-collateral-snapshot-lag")).toBe(true);
    expect(result.metadata).toMatchObject({
      snapshotLagSec: 46_800,
      details: { collateralLagSec: 46_800, collateralLagCapSec: 43_200 },
    });
  });

  it("no longer degrades at the production 27,000s lag under the 12h cap", () => {
    // Production lag on 2026-09-09 was 27,000s (7.5h), which previously tripped
    // the 6h cap and degraded all five M0 coins. P11 widens the cap to 12h.
    const result = adaptM0Collateral({
      data: {
        ...SAMPLE_PAYLOAD.data,
        collateralUpdateds: [
          { timestamp: "1787198387", blockTimestamp: "1787198387" },
        ],
        minterGateway_latestUpdateTimestampSnapshots: [
          { timestamp: "1787198387", value: "1787198387" },
        ],
      },
    });

    expect(result.warnings).toBeUndefined();
    expect(result.metadata).toMatchObject({
      snapshotLagSec: 27_000,
      details: { collateralLagSec: 27_000, collateralLagCapSec: 43_200 },
    });
  });

  it("degrades when the per-minter sum diverges from the total snapshot", () => {
    const result = adaptM0Collateral({
      data: {
        ...SAMPLE_PAYLOAD.data,
        minterGateway_minters: [
          { id: "minter-0x1d5b695d13f231a605d231631c688fb33477b249", collateral: "200000000000000" },
        ],
      },
    });

    expect(result.warnings?.some((warning) => warning.code === "minter-collateral-reconciliation")).toBe(true);
  });

  it("falls back to unverified freshness when the snapshot timestamp is unparseable", () => {
    const result = adaptM0Collateral({
      data: {
        ...SAMPLE_PAYLOAD.data,
        minterGateway_totalCollateralSnapshots: [
          { timestamp: "not-a-timestamp", value: "277097642539488" },
        ],
      },
    });

    expect(result.metadata).toMatchObject({
      freshnessMode: "unverified",
      details: { freshnessSource: "protocol-api-graphql" },
    });
    expect(result.slices).toHaveLength(1);
  });

  // Observed 2026-08-08 (and still true for retired Collateral* resolvers on
  // 2026-08-20): protocol-api.m0.org answers dead resolvers with its gateway
  // error envelope (`{"status":false,"statusCode":500,"message":"fetch failed"}`).
  // HTTP 500 already throws in the transport, but the envelope must never be
  // adapted into a snapshot if the gateway ever returns it with a 200.
  it("refuses the M0 gateway error envelope instead of publishing an empty snapshot", () => {
    expect(() => adaptM0Collateral(
      { status: false, statusCode: 500, message: "fetch failed", result: {} } as never,
    )).toThrow(/missing minterGateway_totalCollateralSnapshots/);
  });

  it("refuses an empty snapshot list", () => {
    expect(() => adaptM0Collateral({ data: { minterGateway_totalCollateralSnapshots: [] } }))
      .toThrow(/missing minterGateway_totalCollateralSnapshots/);
  });

  it("refuses a non-numeric total collateral value", () => {
    expect(() => adaptM0Collateral({
      data: {
        minterGateway_totalCollateralSnapshots: [
          { timestamp: "1787171387", value: "fetch failed" },
        ],
      },
    })).toThrow(/not a usable number/);
  });

  it("emits no publishable slices when the total collateral reports zero", () => {
    const result = adaptM0Collateral({
      data: {
        minterGateway_totalCollateralSnapshots: [
          { timestamp: "1787171387", value: "0" },
        ],
      },
    });

    expect(result.slices).toEqual([]);
    const adapter = getReserveAdapter("m0") ?? undefined;
    const report = validateAdapterOutput(result, { adapter });
    expect(report.valid).toBe(false);
    expect(report.warnings.map((warning) => warning.code)).toContain("empty-slices");
  });
});

describe("fetchM0Reserves", () => {
  it("fetches the keyed GraphQL payload through the shared network harness", async () => {
    const { result, network } = await runAdapter("m0", "musd-metamask", {
      network: {
        json: {
          "https://protocol-api.m0.org/graphql": (request: Request) => {
            expect(request.method).toBe("POST");
            expect(request.headers.get("authorization")).toBe("ApiKey test-key");
            return SAMPLE_PAYLOAD;
          },
        },
      },
      ctx: { m0ApiKey: "test-key" },
      nowSec: 1_787_171_387 + 3_600,
    });

    expect(result.slices).toEqual([
      {
        sourceKey: "m0:eligible-collateral",
        name: "U.S. Treasury bills & cash (M0 eligible collateral)",
        pct: 100,
        risk: "very-low",
      },
    ]);
    expect(network.requests).toEqual([{ url: "https://protocol-api.m0.org/graphql", method: "POST" }]);
  });

  it("fails closed before fetching when M0_API_KEY is not configured", async () => {
    for (const m0ApiKey of [undefined, "   "]) {
      await expect(runAdapter("m0", "musd-metamask", {
        network: { json: { "https://protocol-api.m0.org/graphql": SAMPLE_PAYLOAD } },
        ctx: { m0ApiKey },
        nowSec: 1_787_171_387 + 3_600,
      })).rejects.toThrow(/M0_API_KEY not configured/);
    }
  });
});

// ---------------------------------------------------------------------------
// On-chain fallback (decision 2026-09-24)
//
// The fallback derives the contributing minter set from the gateway's own
// CollateralUpdated events over a window bounded by `updateCollateralInterval()`:
// `collateralOf()` returns zero once an update expires, so the window is a
// provable superset of minters that still contribute collateral. The fixtures
// below pin one such window (block 23,000,000 at 1,800,000,000; interval
// 108,000s) and prove the fail-closed edges.
// ---------------------------------------------------------------------------

const ONCHAIN_BLOCK = { number: 23_000_000, timestamp: 1_800_000_000 };
const ONCHAIN_INTERVAL_SEC = 108_000;
const ONCHAIN_WINDOW_BLOCKS = Math.ceil((ONCHAIN_INTERVAL_SEC * 2) / 12);
const ONCHAIN_WINDOW_FROM_BLOCK = ONCHAIN_BLOCK.number - ONCHAIN_WINDOW_BLOCKS;
const ONCHAIN_WINDOW_FROM_TIMESTAMP = ONCHAIN_BLOCK.timestamp - ONCHAIN_INTERVAL_SEC * 2;
const ONCHAIN_COLLATERAL_UPDATED_TOPIC0 =
  "0x8c7a373ea6d1cedfcb77f0e5520921cc5d5a1a16b960c0c13c0f96b8dc24caa8";
const MINTER_CONTRIBUTING_A = "0x1d5b695d13f231a605d231631c688fb33477b249";
const MINTER_CONTRIBUTING_B = "0x5d238f4eac94da0a635ee39fa389a4754395d5d9";
const MINTER_WITHOUT_COLLATERAL = "0xcd1394d24e1e404f9eb3609f872b0736becb9d74";
const STALE_INDEXER_PAYLOAD = {
  data: {
    ...SAMPLE_PAYLOAD.data,
    // The last internally consistent indexed snapshot: the frozen total equals
    // its per-minter sum (so only the timestamp makes this payload stale), four
    // days before the pinned on-chain block the fallback observes.
    minterGateway_totalCollateralSnapshots: [
      { timestamp: String(ONCHAIN_BLOCK.timestamp - 4 * 86_400), value: "277096415879488" },
    ],
  },
};
const ONCHAIN_WINDOW_FROM_KEY = `eth_getBlockByNumber:0x${ONCHAIN_WINDOW_FROM_BLOCK.toString(16)}`;
const ONCHAIN_INTERVAL_KEY = "ethereum:updateCollateralInterval()";

function m0CollateralUpdatedLog(minter: string, blockNumber: number): OnchainLogEntry {
  return {
    address: "0xf7f9638cb444d65e5a40bf5ff98ebe4ff319f04e",
    topics: [ONCHAIN_COLLATERAL_UPDATED_TOPIC0, `0x${minter.slice(2).padStart(64, "0")}`],
    data: `0x${"00".repeat(96)}`,
    blockNumber: `0x${blockNumber.toString(16)}`,
  };
}

function m0OnchainNetwork(options: {
  collateralByMinter: Record<string, bigint>;
  updatedByMinter: Record<string, number>;
}) {
  return {
    block: ONCHAIN_BLOCK,
    rpc: {
      [ONCHAIN_INTERVAL_KEY]: ONCHAIN_INTERVAL_SEC,
      [ONCHAIN_WINDOW_FROM_KEY]: { timestamp: ONCHAIN_WINDOW_FROM_TIMESTAMP },
      "ethereum:isMinterApproved(address)": true,
      "ethereum:collateralOf(address)": (call: { data: string }) =>
        options.collateralByMinter[`0x${call.data.slice(-40)}`] ?? 0n,
      "ethereum:collateralUpdateTimestampOf(address)": (call: { data: string }) =>
        options.updatedByMinter[`0x${call.data.slice(-40)}`] ?? 0n,
    },
  };
}

describe("adaptM0OnchainCollateral", () => {
  const observation = {
    reads: [
      { minter: MINTER_CONTRIBUTING_A, approved: true, collateralRaw: 1_000_000_000_000n, updatedAtSec: 1_799_996_400 },
      { minter: MINTER_CONTRIBUTING_B, approved: true, collateralRaw: 500_000_000_000n, updatedAtSec: 1_799_992_800 },
      { minter: MINTER_WITHOUT_COLLATERAL, approved: true, collateralRaw: 0n, updatedAtSec: 1_799_996_400 },
    ],
    discoveredMinterCount: 3,
    updateCollateralIntervalSec: ONCHAIN_INTERVAL_SEC,
    windowFromBlock: ONCHAIN_WINDOW_FROM_BLOCK,
    windowCoverageSec: 216_000,
    observedBlock: { chain: "ethereum", ...ONCHAIN_BLOCK },
  };

  it("derives the total and the oldest contributing update timestamp", () => {
    const result = adaptM0OnchainCollateral(observation);

    expect(result.slices).toEqual([
      {
        sourceKey: "m0:eligible-collateral",
        name: "U.S. Treasury bills & cash (M0 eligible collateral)",
        pct: 100,
        risk: "very-low",
      },
    ]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "verified",
      sourceTimestamp: 1_799_992_800,
      collateralValueDivisor: 1_000_000,
      normalizedReserveTotal: 1_500_000,
      minterCount: 2,
      minterCollateralTotalUsd: 1_500_000,
      earliestCollateralUpdateTimestamp: 1_799_992_800,
      latestCollateralUpdateTimestamp: 1_799_996_400,
      observedBlock: { chain: "ethereum", ...ONCHAIN_BLOCK },
      details: {
        collateralSource: "minter-gateway-collateral-updated-window",
        fallbackReason: "indexer-snapshot-stale",
        discoveredMinterCount: 3,
        nonContributingMinterCount: 1,
        updateCollateralIntervalSec: ONCHAIN_INTERVAL_SEC,
        collateralWindowFromBlock: ONCHAIN_WINDOW_FROM_BLOCK,
        collateralWindowToBlock: ONCHAIN_BLOCK.number,
        collateralWindowBlocks: ONCHAIN_BLOCK.number - ONCHAIN_WINDOW_FROM_BLOCK + 1,
        collateralWindowCoverageSec: 216_000,
      },
    });
    expect(validateAdapterOutput(result, { adapter: getReserveAdapter("m0") ?? undefined, now: ONCHAIN_BLOCK.timestamp }).valid).toBe(true);
  });

  it("treats a window with no unexpired collateral as unavailable, never as zero reserves", () => {
    expect(() => adaptM0OnchainCollateral({
      ...observation,
      reads: observation.reads.map((read) => ({ ...read, collateralRaw: 0n })),
    })).toThrow(/no minter with unexpired collateral/);
  });

  it("fails closed on a discovered minter that is not TTG-approved", () => {
    expect(() => adaptM0OnchainCollateral({
      ...observation,
      reads: observation.reads.map((read) =>
        read.minter === MINTER_CONTRIBUTING_B ? { ...read, approved: false } : read,
      ),
    })).toThrow(/not approved by the TTG Registrar/);
  });

  it("fails closed on a contributing update outside the update interval", () => {
    expect(() => adaptM0OnchainCollateral({
      ...observation,
      reads: observation.reads.map((read) =>
        read.minter === MINTER_CONTRIBUTING_B
          ? { ...read, updatedAtSec: ONCHAIN_BLOCK.timestamp - ONCHAIN_INTERVAL_SEC }
          : read,
      ),
    })).toThrow(/outside the 108000s update interval/);
  });

  it("fails closed on a future-dated contributing update", () => {
    expect(() => adaptM0OnchainCollateral({
      ...observation,
      reads: observation.reads.map((read) =>
        read.minter === MINTER_CONTRIBUTING_A
          ? { ...read, updatedAtSec: ONCHAIN_BLOCK.timestamp + 1 }
          : read,
      ),
    })).toThrow(/future collateral update timestamp/);
  });

  it("fails closed when the window does not cover one update interval", () => {
    expect(() => adaptM0OnchainCollateral({ ...observation, windowCoverageSec: ONCHAIN_INTERVAL_SEC - 1 }))
      .toThrow(/less than the 108000s update interval/);
  });

  it("fails closed when reads do not cover every discovered minter", () => {
    expect(() => adaptM0OnchainCollateral({ ...observation, discoveredMinterCount: 4 }))
      .toThrow(/discovered 4 minters but only 3 were read/);
  });
});

describe("fetchM0Reserves on-chain fallback", () => {
  it("publishes verified on-chain collateral when the indexer snapshot is beyond the source-age cap", async () => {
    vi.mocked(onchain.fetchOnchainLogs).mockResolvedValueOnce({
      logs: [
        m0CollateralUpdatedLog(MINTER_CONTRIBUTING_A, ONCHAIN_BLOCK.number - 100),
        m0CollateralUpdatedLog(MINTER_CONTRIBUTING_B, ONCHAIN_BLOCK.number - 50),
        m0CollateralUpdatedLog(MINTER_WITHOUT_COLLATERAL, ONCHAIN_BLOCK.number - 10),
      ],
      complete: true,
      calls: 1,
    });

    const { result, report } = await runAdapter("m0", "musd-metamask", {
      network: {
        json: { "https://protocol-api.m0.org/graphql": STALE_INDEXER_PAYLOAD },
        ...m0OnchainNetwork({
          collateralByMinter: {
            [MINTER_CONTRIBUTING_A]: 1_000_000_000_000n,
            [MINTER_CONTRIBUTING_B]: 500_000_000_000n,
          },
          updatedByMinter: {
            [MINTER_CONTRIBUTING_A]: 1_799_996_400,
            [MINTER_CONTRIBUTING_B]: 1_799_992_800,
            [MINTER_WITHOUT_COLLATERAL]: 1_799_996_400,
          },
        }),
      },
      ctx: { m0ApiKey: "test-key" },
      nowSec: ONCHAIN_BLOCK.timestamp,
    });

    expectWarnings(result, ["m0-onchain-collateral-fallback"]);
    expectWarningEffect(result, "m0-onchain-collateral-fallback", "info");
    expect(result.slices).toEqual([
      {
        sourceKey: "m0:eligible-collateral",
        name: "U.S. Treasury bills & cash (M0 eligible collateral)",
        pct: 100,
        risk: "very-low",
      },
    ]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "verified",
      sourceTimestamp: 1_799_992_800,
      normalizedReserveTotal: 1_500_000,
      minterCount: 2,
      observedBlock: { chain: "ethereum", ...ONCHAIN_BLOCK },
      details: {
        collateralSource: "minter-gateway-collateral-updated-window",
        fallbackReason: "indexer-snapshot-stale",
        discoveredMinterCount: 3,
        nonContributingMinterCount: 1,
        collateralWindowFromBlock: ONCHAIN_WINDOW_FROM_BLOCK,
        collateralWindowToBlock: ONCHAIN_BLOCK.number,
        collateralWindowCoverageSec: ONCHAIN_BLOCK.timestamp - ONCHAIN_WINDOW_FROM_TIMESTAMP,
      },
    });
    expect(report.valid).toBe(true);
    expect(report.warnings.map((warning) => warning.code)).not.toContain("stale-source-data");

    const scanCall = vi.mocked(onchain.fetchOnchainLogs).mock.calls[0];
    expect(scanCall?.[0]).toMatchObject({
      chain: "ethereum",
      topics: [ONCHAIN_COLLATERAL_UPDATED_TOPIC0],
      fromBlock: ONCHAIN_WINDOW_FROM_BLOCK,
      toBlock: ONCHAIN_BLOCK.number,
      maxCalls: 4,
    });
  });

  it("keeps the degraded indexer snapshot when the window scan is incomplete", async () => {
    const { result, report, network } = await runAdapter("m0", "musd-metamask", {
      network: {
        json: { "https://protocol-api.m0.org/graphql": STALE_INDEXER_PAYLOAD },
        block: ONCHAIN_BLOCK,
        rpc: {
          [ONCHAIN_INTERVAL_KEY]: ONCHAIN_INTERVAL_SEC,
          [ONCHAIN_WINDOW_FROM_KEY]: { timestamp: ONCHAIN_WINDOW_FROM_TIMESTAMP },
        },
      },
      ctx: { m0ApiKey: "test-key" },
      nowSec: ONCHAIN_BLOCK.timestamp,
      allowUnmatched: true,
    });

    expectWarnings(result, ["m0-onchain-fallback-unavailable"]);
    expectWarningEffect(result, "m0-onchain-fallback-unavailable", "info");
    expect(result.metadata).toMatchObject({
      freshnessMode: "verified",
      sourceTimestamp: ONCHAIN_BLOCK.timestamp - 4 * 86_400,
      normalizedReserveTotal: 277_096_415.879488,
    });
    expect(report.warnings.map((warning) => warning.code)).toContain("stale-source-data");
    expect(network.unmatched.some((entry) => entry.includes("eth_getLogs"))).toBe(true);
  });

  it("keeps the degraded indexer snapshot when the window discovers more minters than the cap", async () => {
    const manyMinters = Array.from(
      { length: 33 },
      (_, index) => `0x${(index + 1).toString(16).padStart(40, "0")}`,
    );
    vi.mocked(onchain.fetchOnchainLogs).mockResolvedValueOnce({
      logs: manyMinters.map((minter, index) => m0CollateralUpdatedLog(minter, ONCHAIN_BLOCK.number - 1 - index)),
      complete: true,
      calls: 1,
    });

    const { result } = await runAdapter("m0", "musd-metamask", {
      network: {
        json: { "https://protocol-api.m0.org/graphql": STALE_INDEXER_PAYLOAD },
        block: ONCHAIN_BLOCK,
        rpc: {
          [ONCHAIN_INTERVAL_KEY]: ONCHAIN_INTERVAL_SEC,
          [ONCHAIN_WINDOW_FROM_KEY]: { timestamp: ONCHAIN_WINDOW_FROM_TIMESTAMP },
        },
      },
      ctx: { m0ApiKey: "test-key" },
      nowSec: ONCHAIN_BLOCK.timestamp,
    });

    expectWarnings(result, ["m0-onchain-fallback-unavailable"]);
    expect(result.metadata).toMatchObject({
      sourceTimestamp: ONCHAIN_BLOCK.timestamp - 4 * 86_400,
      normalizedReserveTotal: 277_096_415.879488,
    });
  });
});
