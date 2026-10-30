import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvmCodeAtBlockResult } from "../evm-rpc";
import { TOTAL_SUPPLY_SELECTOR } from "../evm-selectors";
import { buildChainRpcs } from "../chain-registry";
import { SafetyScoreV9DeploymentSupplyCensusSchema, V9DeploymentSupplyCensusRowSchema } from "@shared/types/safety-score-v9-deployment-supply-census";
import {
  observeDeploymentSupplyCensusEvm,
  observeDeploymentSupplyCensusEvmChain,
  resolveDeploymentSupplyCensusEvmPins,
  type DeploymentSupplyCensusEvmChainAnchor,
  type DeploymentSupplyCensusEvmDependencies,
  type DeploymentSupplyCensusEvmPinResolution,
  type DeploymentSupplyCensusReadTarget,
  type DeploymentSupplyCensusReferencePrice,
} from "../safety-score-v9/deployment-supply-census-evm";
import rpcGeneration from "./fixtures/deployment-supply-census-evm/rpc-generation.json";
import shareBoundary from "./fixtures/deployment-supply-census-evm/share-boundary-rows.json";

const CLOCK = 1_793_294_244;
const AGGREGATE_USD = 1_000_000_000;
const ETHEREUM = "ethereum";
const BASE = "base";

function address(value: number): string {
  return `0x${value.toString(16).padStart(40, "0")}`;
}

function anchor(
  blockTimeSec = CLOCK - 60,
  blockNumber = 100,
  blockHash: `0x${string}` = `0x${"ab".repeat(32)}`,
): DeploymentSupplyCensusEvmChainAnchor {
  return { blockNumber, blockHash, blockTimeSec };
}

function target(routeKey: string, overrides: Partial<DeploymentSupplyCensusReadTarget> = {}): DeploymentSupplyCensusReadTarget {
  return {
    assetId: "fixture-asset",
    chainId: ETHEREUM,
    tokenAddress: address(1),
    routeId: routeKey,
    expectedDecimals: 6,
    ...overrides,
  };
}

function word(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

interface SupplyFixture {
  readonly raw: bigint;
  readonly decimals: bigint;
}

function evmDependencies(options: {
  codes?: ReadonlyMap<string, EvmCodeAtBlockResult>;
  supplies?: ReadonlyMap<string, SupplyFixture>;
} = {}) {
  const code = vi.fn(async (_chain: string | undefined, tokenAddress: string): Promise<EvmCodeAtBlockResult> =>
    options.codes?.get(tokenAddress.toLowerCase()) ?? { status: "available", code: "0x6000" });
  const multicall = vi.fn(async (
    _chain: string | undefined,
    calls: readonly { label: string; target: string; callData: string }[],
  ) => calls.map((call) => {
    const supply = options.supplies?.get(call.target.toLowerCase()) ?? { raw: 1_000_000n, decimals: 6n };
    return {
      label: call.label,
      success: true,
      returnData: word(call.callData === TOTAL_SUPPLY_SELECTOR ? supply.raw : supply.decimals),
    };
  }));
  const dependencies: Partial<DeploymentSupplyCensusEvmDependencies> = {
    fetchEvmCodeStatusAtBlock: code,
    fetchEvmMulticall3Aggregate3AtBlock: multicall,
    sha256Hex: async () => `f`.repeat(64),
  };
  return { dependencies, code, multicall };
}

function pinned(chainAnchor: DeploymentSupplyCensusEvmChainAnchor): DeploymentSupplyCensusEvmPinResolution {
  return { kind: "pinned", anchor: chainAnchor };
}

function readCensus(
  input: {
    targets: readonly DeploymentSupplyCensusReadTarget[];
    pins?: Map<string, DeploymentSupplyCensusEvmPinResolution>;
    chainSupplyUsdByChainId?: Map<string, number>;
    referencePrices?: Map<string, DeploymentSupplyCensusReferencePrice | null>;
    aggregateSupplyUsd?: number;
  },
  dependencies: Partial<DeploymentSupplyCensusEvmDependencies> = {},
) {
  return observeDeploymentSupplyCensusEvm({
    targets: input.targets,
    scoringClockSec: CLOCK,
    aggregateSupplyUsd: input.aggregateSupplyUsd ?? AGGREGATE_USD,
    chainSupplyUsdByChainId: input.chainSupplyUsdByChainId ?? new Map(),
    referencePrices: input.referencePrices ?? new Map(input.targets.map(row =>
      [row.routeId, { priceUsd: 1000, observedAtSec: CLOCK - 60 }])),
    pins: input.pins ?? new Map([...new Set(input.targets.map(row => row.chainId))]
      .map(chainId => [chainId, pinned(anchor())])),
    chainRpcs: new Map(),
  }, dependencies);
}

function codes(entries: readonly (readonly [string, EvmCodeAtBlockResult])[]): ReadonlyMap<string, EvmCodeAtBlockResult> {
  return new Map(entries.map(([tokenAddress, result]) => [tokenAddress.toLowerCase(), result]));
}

function supplies(entries: readonly (readonly [string, SupplyFixture])[]): ReadonlyMap<string, SupplyFixture> {
  return new Map(entries.map(([tokenAddress, result]) => [tokenAddress.toLowerCase(), result]));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("deployment supply census EVM rows", () => {
  it("admits a measured deployment as one upper-bound row with its per-row code hash and pin", async () => {
    const { dependencies } = evmDependencies({
      supplies: supplies([[address(1), { raw: 9_999_000_000n, decimals: 6n }]]),
    });
    const census = await readCensus({ targets: [target("ethereum:0x01")] }, dependencies);

    expect(census.rejected).toEqual([]);
    expect(census.rows).toHaveLength(1);
    expect(V9DeploymentSupplyCensusRowSchema.parse(census.rows[0])).toEqual(census.rows[0]);
    expect(census.rows[0]).toMatchObject({
      routeId: "ethereum:0x01",
      chainId: ETHEREUM,
      tokenAddress: address(1),
      readKind: "evm-total-supply",
      decimals: 6,
      totalSupplyRaw: "9999000000",
      referencePriceUsd: 1000,
      referencePriceObservedAtSec: CLOCK - 60,
      evidenceKind: "upper-bound",
      pin: {
        kind: "evm-header",
        blockNumber: 100,
        blockHash: `0x${"ab".repeat(32)}`,
        blockTimeSec: CLOCK - 60,
        runtimeCodeSha256: "f".repeat(64),
      },
    });
    // Rounded up in the last ULPs: the row is a bound, never a spot value.
    expect(census.rows[0]!.supplyUsdUpper).toBeCloseTo(9_999_000, 6);
    expect(census.rows[0]!.shareUpper).toBeCloseTo(0.009999, 12);
    expect(census.rows[0]!.shareUpper).toBeLessThan(0.01);
  });

  it("rejects the whole chain's partition when measured USD exceeds the tier-0 chain bound", async () => {
    const { dependencies } = evmDependencies({
      supplies: supplies([
        [address(1), { raw: 9_999_000_000n, decimals: 6n }],
        [address(2), { raw: 1_000_000n, decimals: 6n }],
      ]),
    });
    const census = await readCensus({
      targets: [target("ethereum:0x01"), target("ethereum:0x02", { tokenAddress: address(2) })],
      // 9,999,000 + 1,000 measured against a 9,000,000 chain bound.
      chainSupplyUsdByChainId: new Map([[ETHEREUM, 9_000_000]]),
    }, dependencies);

    expect(census.rows).toEqual([]);
    expect(census.rejected.map(row => [row.routeId, row.code])).toEqual([
      ["ethereum:0x01", "census-rejected:conservation-breach"],
      ["ethereum:0x02", "census-rejected:conservation-breach"],
    ]);
  });

  it("admits a partition that fits the chain bound exactly at the conservation ceiling", async () => {
    const { dependencies } = evmDependencies({
      supplies: supplies([[address(1), { raw: 9_000_000_000n, decimals: 6n }]]),
    });
    const census = await readCensus({
      targets: [target("ethereum:0x01")],
      chainSupplyUsdByChainId: new Map([[ETHEREUM, 9_000_000]]),
    }, dependencies);
    expect(census.rejected).toEqual([]);
    expect(census.rows).toHaveLength(1);
  });

  it("rejects 121 seconds of cross-chain skew and admits exactly 120", async () => {
    const skewDependencies = evmDependencies().dependencies;
    const targets = [
      target("ethereum:0x01"),
      target("base:0x02", { chainId: BASE, tokenAddress: address(2) }),
    ];
    const rejected = await readCensus({
      targets,
      pins: new Map([
        [ETHEREUM, pinned(anchor(CLOCK - 180))],
        [BASE, pinned(anchor(CLOCK - 59))],
      ]),
    }, skewDependencies);
    expect(rejected.rows).toEqual([]);
    expect(rejected.rejected.map(row => row.code)).toEqual([
      "census-rejected:cross-chain-skew",
      "census-rejected:cross-chain-skew",
    ]);

    const admitted = await readCensus({
      targets,
      pins: new Map([
        [ETHEREUM, pinned(anchor(CLOCK - 180))],
        [BASE, pinned(anchor(CLOCK - 60))],
      ]),
    }, skewDependencies);
    expect(admitted.rejected).toEqual([]);
    expect(admitted.rows.map(row => row.chainId)).toEqual([BASE, ETHEREUM]);
  });

  it("rejects a deployment without runtime code and one whose code read is unavailable", async () => {
    const { dependencies } = evmDependencies({
      codes: codes([
        [address(1), { status: "absent" }],
        [address(2), { status: "unavailable" }],
      ]),
    });
    const census = await readCensus({
      targets: [target("ethereum:0x01"), target("ethereum:0x02", { tokenAddress: address(2) })],
    }, dependencies);
    expect(census.rows).toEqual([]);
    expect(census.rejected.map(row => [row.routeId, row.code])).toEqual([
      ["ethereum:0x01", "census-rejected:missing-code-hash"],
      ["ethereum:0x02", "census-rejected:read-unavailable"],
    ]);
  });

  it("rejects the whole asset when its roster exceeds 64 deployments, without any read", async () => {
    const { dependencies, code, multicall } = evmDependencies();
    const targets = Array.from({ length: 65 }, (_, index) => target(`ethereum:0x${index}`, { tokenAddress: address(index + 1) }));
    const census = await readCensus({ targets }, dependencies);
    expect(census).toEqual({
      rows: [],
      rejected: [{ routeId: null, code: "census-rejected:deployment-over-cap" }],
    });
    expect(code).not.toHaveBeenCalled();
    expect(multicall).not.toHaveBeenCalled();
  });

  it("serializes two same-chain deployments with different code hashes into one packet", async () => {
    const { dependencies } = evmDependencies({
      codes: codes([
        [address(1), { status: "available", code: "0x6001" }],
        [address(2), { status: "available", code: "0x6002" }],
      ]),
      supplies: supplies([[address(1), { raw: 1_000_000n, decimals: 6n }]]),
    });
    const census = await readCensus({
      targets: [target("ethereum:0x01"), target("ethereum:0x02", { tokenAddress: address(2) })],
    }, {
      ...dependencies,
      sha256Hex: async (value) => String(value).replace("0x", "").padStart(64, "0"),
    });
    expect(census.rows).toHaveLength(2);
    expect(new Set(census.rows.map(row => row.pin.kind === "evm-header" ? row.pin.runtimeCodeSha256 : ""))).toEqual(
      new Set(["0".repeat(60) + "6001", "0".repeat(60) + "6002"]),
    );
    const packet = {
      model: "deployment-supply-census-v1",
      observedAtSec: CLOCK,
      deployments: census.rows,
      conservation: {
        aggregateSupplyUsd: AGGREGATE_USD,
        measuredSupplyUsd: census.rows.reduce((sum, row) => sum + row.supplyUsdUpper, 0),
        measuredShareSum: census.rows.reduce((sum, row) => sum + row.shareUpper, 0),
        relativeTolerance: 1e-12,
        absoluteToleranceUsd: 0.000001,
        rosterComplete: true,
        conserved: true,
      },
      rejected: census.rejected,
    };
    expect(SafetyScoreV9DeploymentSupplyCensusSchema.safeParse(packet).success).toBe(true);
  });

  it("admits a 64-deployment roster at the cap", async () => {
    const { dependencies } = evmDependencies();
    const targets = Array.from({ length: 64 }, (_, index) => target(`ethereum:0x${index}`, { tokenAddress: address(index + 1) }));
    const census = await readCensus({ targets }, dependencies);
    expect(census.rejected).toEqual([]);
    expect(census.rows).toHaveLength(64);
  });

  it("admits the 1,800-second pin boundary and rejects 1,801 or a future pin", async () => {
    const dependencies = evmDependencies().dependencies;
    const fresh = await readCensus({
      targets: [target("ethereum:0x01")],
      pins: new Map([[ETHEREUM, pinned(anchor(CLOCK - 1800))]]),
    }, dependencies);
    expect(fresh.rows).toHaveLength(1);

    const stale = await readCensus({
      targets: [target("ethereum:0x01")],
      pins: new Map([[ETHEREUM, pinned(anchor(CLOCK - 1801))]]),
    }, dependencies);
    expect(stale.rows).toEqual([]);
    expect(stale.rejected).toEqual([
      { routeId: "ethereum:0x01", code: "census-rejected:observation-stale" },
    ]);

    const future = await readCensus({
      targets: [target("ethereum:0x01")],
      pins: new Map([[ETHEREUM, pinned(anchor(CLOCK + 1))]]),
    }, dependencies);
    expect(future.rejected).toEqual([
      { routeId: "ethereum:0x01", code: "census-rejected:future-dated-pin" },
    ]);
  });

  it("rejects decimals that disagree with the reviewed route and unusable decimal scales", async () => {
    const { dependencies } = evmDependencies({
      supplies: supplies([
        [address(1), { raw: 1_000_000n, decimals: 18n }],
        [address(2), { raw: 1_000_000n, decimals: 37n }],
      ]),
    });
    const census = await readCensus({
      targets: [target("ethereum:0x01"), target("ethereum:0x02", { tokenAddress: address(2) })],
    }, dependencies);
    expect(census.rows).toEqual([]);
    expect(census.rejected.map(row => row.code)).toEqual([
      "census-rejected:route-unreviewed",
      "census-rejected:read-unavailable",
    ]);
  });

  it("rejects missing, stale, and future reference prices instead of sharing a spot value", async () => {
    const { dependencies } = evmDependencies();
    const targets = [
      target("ethereum:0x01"),
      target("ethereum:0x02", { tokenAddress: address(2) }),
      target("ethereum:0x03", { tokenAddress: address(3) }),
    ];
    const census = await readCensus({
      targets,
      referencePrices: new Map([
        ["ethereum:0x01", null],
        ["ethereum:0x02", { priceUsd: 1, observedAtSec: CLOCK - 1801 }],
        ["ethereum:0x03", { priceUsd: 1, observedAtSec: CLOCK + 1 }],
      ]),
    }, dependencies);
    expect(census.rows).toEqual([]);
    expect(census.rejected.map(row => row.code)).toEqual([
      "census-rejected:reference-price-unavailable",
      "census-rejected:reference-price-unavailable",
      "census-rejected:future-dated-pin",
    ]);
  });

  it("rejects a duplicated route key as an inconsistent roster", async () => {
    const { dependencies } = evmDependencies();
    const census = await readCensus({
      targets: [target("ethereum:0x01"), target("ethereum:0x01")],
    }, dependencies);
    expect(census).toEqual({
      rows: [],
      rejected: [{ routeId: null, code: "census-rejected:roster-incomplete" }],
    });
  });

  it("rejects a target on a chain without an EVM census read kind", async () => {
    const { dependencies } = evmDependencies();
    const census = await readCensus({
      targets: [target("solana:mint", { chainId: "solana", tokenAddress: "So11111111111111111111111111111111111111112" })],
    }, dependencies);
    expect(census.rejected).toEqual([
      { routeId: "solana:mint", code: "census-rejected:read-unavailable" },
    ]);
  });

  it("keeps the share boundary fixtures: 0.009999 documents, 0.01 stays required", async () => {
    const documents = await readCensus({
      targets: [target("ethereum:0x01")],
    }, evmDependencies({
      supplies: supplies([[address(1), { raw: 9_999_000_000n, decimals: 6n }]]),
    }).dependencies);
    const required = await readCensus({
      targets: [target("ethereum:0x01")],
    }, evmDependencies({
      supplies: supplies([[address(1), { raw: 10_000_000_000n, decimals: 6n }]]),
    }).dependencies);

    expect(documents.rows[0]!.shareUpper).toBe(shareBoundary.documents.shareUpper);
    expect(required.rows[0]!.shareUpper).toBe(shareBoundary.required.shareUpper);
    // The consumer treats the strict `< 1%` predicate as documentation; the
    // fixture pins both sides of that boundary for the SA-6 consumer tests.
    for (const row of [shareBoundary.documents, shareBoundary.required]) {
      expect(V9DeploymentSupplyCensusRowSchema.safeParse(row).success).toBe(true);
    }
    expect(shareBoundary.documents.shareUpper).toBeLessThan(shareBoundary.thresholdShare);
    expect(shareBoundary.required.shareUpper).toBeGreaterThanOrEqual(shareBoundary.thresholdShare);
  });
});

describe("pinned EVM chain reads", () => {
  it("reports a missing pin when the header cannot resolve, and never reads at latest", async () => {
    const resolveBlock = vi.fn(async () => null);
    const header = vi.fn(async () => null);
    const chainRead = await observeDeploymentSupplyCensusEvmChain({
      chainId: ETHEREUM,
      targets: [target("ethereum:0x01")],
      anchor: anchor(),
      scoringClockSec: CLOCK,
      chainRpcs: new Map(),
    }, { fetchEvmBlockHeader: header } as Partial<DeploymentSupplyCensusEvmDependencies>);
    expect(chainRead.kind).toBe("measured");
    expect(resolveBlock).not.toHaveBeenCalled();

    const pins = await resolveDeploymentSupplyCensusEvmPins({
      chainIds: [ETHEREUM, "solana"],
      scoringClockSec: CLOCK,
      chainRpcs: new Map(),
    }, {
      resolveClosestBlockAtOrBeforeTimestamp: resolveBlock as unknown as DeploymentSupplyCensusEvmDependencies["resolveClosestBlockAtOrBeforeTimestamp"],
      fetchEvmBlockHeader: header as unknown as DeploymentSupplyCensusEvmDependencies["fetchEvmBlockHeader"],
    });
    expect(pins.get(ETHEREUM)).toEqual({ kind: "rejected", reason: "missing-block-pin" });
    expect(pins.get("solana")).toEqual({ kind: "rejected", reason: "read-unavailable" });
    expect(resolveBlock).toHaveBeenCalledTimes(1);
  });

  it("pins on the chain's finalized header when the bracket search cannot resolve", async () => {
    // A pruned or rate-limited endpoint cannot bracket the observation clock;
    // the chain's own finalized header is a real hashed block behind the tip.
    const header = vi.fn(async (_chain: unknown, block: unknown) => (block === "finalized"
      ? { number: 99, hash: `0x${"cd".repeat(32)}`, timestamp: CLOCK - 300 }
      : null));
    const pins = await resolveDeploymentSupplyCensusEvmPins({
      chainIds: [ETHEREUM],
      scoringClockSec: CLOCK,
      chainRpcs: new Map(),
    }, {
      resolveClosestBlockAtOrBeforeTimestamp: async () => null,
      fetchEvmBlockHeader: header as unknown as DeploymentSupplyCensusEvmDependencies["fetchEvmBlockHeader"],
    });
    expect(pins.get(ETHEREUM)).toEqual({
      kind: "pinned",
      anchor: { blockNumber: 99, blockHash: `0x${"cd".repeat(32)}`, blockTimeSec: CLOCK - 300 },
    });
    expect(header.mock.calls.map(([, block]) => block)).toEqual(["finalized"]);

    const future = await resolveDeploymentSupplyCensusEvmPins({
      chainIds: [ETHEREUM],
      scoringClockSec: CLOCK,
      chainRpcs: new Map(),
    }, {
      resolveClosestBlockAtOrBeforeTimestamp: async () => null,
      // A finalized header that still postdates the observation clock is
      // future-dated, never silently re-dated to the clock.
      fetchEvmBlockHeader: (async () => ({
        number: 100, hash: `0x${"ef".repeat(32)}`, timestamp: CLOCK + 1,
      })) as unknown as DeploymentSupplyCensusEvmDependencies["fetchEvmBlockHeader"],
    });
    expect(future.get(ETHEREUM)).toEqual({ kind: "rejected", reason: "future-dated-pin" });
  });

  it("keeps one multicall request per 64 calls at the policy batch cap", async () => {
    const requests: number[] = [];
    const dependencies = evmDependencies();
    const multicall = dependencies.multicall;
    const chainRead = await observeDeploymentSupplyCensusEvmChain({
      chainId: ETHEREUM,
      targets: Array.from({ length: 40 }, (_, index) => target(`ethereum:0x${index}`, { tokenAddress: address(index + 1) })),
      anchor: anchor(),
      scoringClockSec: CLOCK,
      chainRpcs: new Map(),
    }, {
      ...dependencies.dependencies,
      fetchEvmMulticall3Aggregate3AtBlock: (async (...args: Parameters<typeof multicall>) => {
        requests.push((args[1] as readonly unknown[]).length);
        return multicall(...args);
      }) as unknown as DeploymentSupplyCensusEvmDependencies["fetchEvmMulticall3Aggregate3AtBlock"],
    });
    expect(chainRead.kind).toBe("measured");
    expect(requests).toEqual([80]);
  });
});

describe("recorded census generation", () => {
  it("regenerates the recorded RPC bodies byte-identically", async () => {
    const chainRpcs = buildChainRpcs();
    const exchanges = rpcGeneration.exchanges;
    // Chains are read concurrently and each chain has its own endpoint, so
    // replay matches by (url, method, params) instead of recording order.
    const queues = new Map<string, { status: number; body: string }[]>();
    for (const exchange of exchanges) {
      const key = `${exchange.url}\u0000${exchange.method}:${JSON.stringify(exchange.params)}`;
      queues.set(key, [...(queues.get(key) ?? []), { status: exchange.status, body: exchange.body }]);
    }
    const sent: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = String(init?.body);
      const body = JSON.parse(raw) as { method: string; params: unknown[] };
      const key = `${String(input)}\u0000${body.method}:${JSON.stringify(body.params)}`;
      const queue = queues.get(key);
      const exchange = queue?.shift();
      expect(exchange, `unrecorded RPC ${key}`).toBeDefined();
      sent.push(raw);
      return new Response(exchange!.body, {
        status: exchange!.status,
        headers: { "content-type": "application/json" },
      });
    });

    const pins = await resolveDeploymentSupplyCensusEvmPins({
      chainIds: rpcGeneration.chainIds,
      scoringClockSec: rpcGeneration.clockSec,
      chainRpcs,
    });
    const census = await observeDeploymentSupplyCensusEvm({
      targets: rpcGeneration.targets as readonly DeploymentSupplyCensusReadTarget[],
      scoringClockSec: rpcGeneration.clockSec,
      aggregateSupplyUsd: rpcGeneration.aggregateSupplyUsd,
      chainSupplyUsdByChainId: new Map(Object.entries(rpcGeneration.chainSupplyUsdByChainId)),
      referencePrices: new Map(Object.entries(rpcGeneration.referencePrices)),
      pins,
      chainRpcs,
    });

    // Every recorded request is replayed once, byte for byte.
    expect(sent.sort()).toEqual(exchanges.map(exchange => exchange.request).sort());
    expect([...queues.values()].every(queue => queue.length === 0)).toBe(true);
    expect(census).toEqual(rpcGeneration.census);
    expect(pins.size).toBe(rpcGeneration.chainIds.length);
    for (const resolution of pins.values()) expect(resolution.kind).toBe("pinned");
  });
});
