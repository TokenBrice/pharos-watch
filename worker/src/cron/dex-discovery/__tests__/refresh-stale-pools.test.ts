import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import type { CgPool } from "../../../lib/coingecko-onchain";
import { makeNoopD1 } from "../../../test-helpers/noop-d1";
import { upsertStagedPools } from "../persistence";
import {
  planStalePoolRefreshBatches,
  refreshStaleRegistryPools,
  STALE_POOL_REFRESH_POLICY,
  type StalePoolRefreshCandidate,
  type StalePoolRefreshDependencies,
} from "../refresh-stale-pools";
import { coinGeckoPool, stagedPool } from "./discovery.test-support";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => { fixtures.closeAll(); vi.useRealTimers(); });

const NOW = 1_800_000_000;
const HOUR = 3600;
const USDC = {
  ethereum: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  base: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  optimism: "0x0b2c639c533813f4aa9d7837caf62653d097ff85",
} as const;
const STABLECOINS = [{
  id: "usdc-circle",
  contracts: Object.entries(USDC).map(([chain, address]) => ({ chain, address })),
}];

function addr(prefix: string, index: number): string {
  return `0x${prefix}${index.toString(16).padStart(40 - prefix.length, "0")}`;
}

async function seed(db: D1Database, rows: Array<Parameters<typeof stagedPool>[0]>): Promise<void> {
  await upsertStagedPools(db, rows.map((row) => stagedPool({
    stablecoinId: "usdc-circle", source: "cg_onchain", chain: "ethereum", ...row,
    discoveredAt: (row?.refreshedAt ?? NOW) - HOUR,
  })));
}

/** A coherent CG pool with USDC as the base leg. */
function usdcPool(chain: keyof typeof USDC, poolAddress: string, overrides: Parameters<typeof coinGeckoPool>[0] = {}): CgPool {
  return coinGeckoPool({
    address: poolAddress, network: "net", baseToken: USDC[chain], quoteToken: addr("ee", 1),
    basePrice: "1.0001", quotePrice: "0.9999", reserve: "2000000", volume: "750000", dex: "uniswap-v3",
    ...overrides,
  }) as CgPool;
}

function makeDeps(
  respond: (network: string, addresses: readonly string[]) => Promise<{ transportOk: boolean; schemaDegraded: boolean; pools: CgPool[] }>,
  options: { circuitAllowed?: boolean; circuitAfter?: "closed" | "open" } = {},
) {
  const closed = { state: "closed", consecutiveFailures: 0, lastFailureAt: null, openedAt: null };
  const deps = {
    shouldAttemptFetch: vi.fn(async () => options.circuitAllowed ?? true),
    recordOutcome: vi.fn(async (_db: D1Database, _source: string, _success: boolean) =>
      ({ before: closed, after: { ...closed, state: options.circuitAfter ?? "closed" } })),
    fetchCgPoolsByAddressesWithStatus: vi.fn(async (network: string, addresses: readonly string[]) => respond(network, addresses)),
    sleepWithSignal: vi.fn(async () => undefined),
  };
  return deps as typeof deps & StalePoolRefreshDependencies;
}

function registryRows(sqlite: { prepare(sql: string): { all(): unknown[] } }) {
  return sqlite.prepare(
    "SELECT pool_id, source, tvl_usd, volume_24h, refreshed_at FROM dex_pool_registry ORDER BY pool_id, source",
  ).all();
}

describe("refreshStaleRegistryPools", () => {
  it("refreshes due CG-family and Slipstream pools stale-first by retained TVL", async () => {
    const { sqlite, db } = fixtures.open();
    const p = (index: number) => addr("aa", index);
    const b = (index: number) => addr("bb", index);
    await seed(db, [
      { poolId: `ethereum:${p(1)}`, tvlUsd: 5_000_000, refreshedAt: NOW - 30 * HOUR },
      { poolId: `ethereum:${p(2)}`, tvlUsd: 50_000_000, refreshedAt: NOW - 21 * HOUR },
      { poolId: `ethereum:${p(3)}`, tvlUsd: 1_000_000, refreshedAt: NOW - 100 * HOUR, source: "gecko_terminal" },
      { poolId: `ethereum:${p(4)}`, tvlUsd: 90_000_000, refreshedAt: NOW - 2 * HOUR },
      { poolId: `ethereum:${p(5)}`, tvlUsd: 99_000_000, refreshedAt: NOW - 15 * 24 * HOUR },
      { poolId: `ethereum:${p(6)}`, tvlUsd: 80_000_000, refreshedAt: NOW - 30 * HOUR, source: "dl" },
      { poolId: `base:${b(1)}`, chain: "base", source: "direct_api", poolType: "aerodrome-slipstream-1bp", tvlUsd: 20_000_000, refreshedAt: NOW - HOUR },
      { poolId: `base:${b(2)}`, chain: "base", source: "direct_api", poolType: "aerodrome-slipstream-5bp", tvlUsd: 30_000_000, refreshedAt: NOW - HOUR },
      { poolId: `base:${b(2)}`, chain: "base", tvlUsd: 30_000_000, refreshedAt: NOW - HOUR },
      { poolId: `base:${b(3)}`, chain: "base", source: "direct_api", poolType: "aerodrome-volatile", tvlUsd: 40_000_000, refreshedAt: NOW - HOUR },
      { poolId: `optimism:${b(4)}`, chain: "optimism", source: "direct_api", poolType: "velodrome-slipstream-5bp", tvlUsd: 3_000_000, refreshedAt: NOW - HOUR },
    ]);
    const chainByNetwork: Record<string, keyof typeof USDC> = { eth: "ethereum", base: "base", optimism: "optimism" };
    const deps = makeDeps(async (network, addresses) => ({
      transportOk: true,
      schemaDegraded: false,
      pools: addresses.map((address) => usdcPool(chainByNetwork[network]!, address, { dex: "aerodrome-slipstream" })),
    }));

    const summary = await refreshStaleRegistryPools({
      db, cgApiKey: "key", stablecoins: STABLECOINS, nowSec: NOW, deadlineMs: Date.now() + 60_000, dependencies: deps,
    });

    expect(deps.fetchCgPoolsByAddressesWithStatus.mock.calls.map(([network, addresses]) => [network, addresses])).toEqual([
      ["base", [b(1)]],
      ["eth", [p(1), p(3), p(2)]],
      ["optimism", [b(4)]],
    ]);
    expect(summary).toMatchObject({
      outcome: "completed", poolsDue: 5, poolsSelected: 5, requests: 3, refreshed: 5, failed: 0, deferred: 0,
      stalePoolsRemaining: 0, staleTvlRemaining: 0,
    });
    const rows = registryRows(sqlite);
    expect(rows).toEqual(expect.arrayContaining([
      { pool_id: `base:${b(1)}`, source: "cg_onchain", tvl_usd: 2_000_000, volume_24h: 750_000, refreshed_at: NOW },
      { pool_id: `optimism:${b(4)}`, source: "cg_onchain", tvl_usd: 2_000_000, volume_24h: 750_000, refreshed_at: NOW },
      { pool_id: `ethereum:${p(3)}`, source: "cg_onchain", tvl_usd: 2_000_000, volume_24h: 750_000, refreshed_at: NOW },
      { pool_id: `ethereum:${p(4)}`, source: "cg_onchain", tvl_usd: 90_000_000, volume_24h: 1_000, refreshed_at: NOW - 2 * HOUR },
      { pool_id: `ethereum:${p(5)}`, source: "cg_onchain", tvl_usd: 99_000_000, volume_24h: 1_000, refreshed_at: NOW - 15 * 24 * HOUR },
    ]));
    expect(rows).not.toContainEqual(expect.objectContaining({ pool_id: `base:${b(3)}`, source: "cg_onchain" }));
  });

  it("writes only rows that pass the crawl's admission gates and keeps rejected pools due", async () => {
    const { sqlite, db } = fixtures.open();
    const q = (index: number) => addr("cc", index);
    await seed(db, [1, 2, 3, 4, 5].map((index) => ({
      poolId: `ethereum:${q(index)}`, tvlUsd: index * 1_000_000, refreshedAt: NOW - 48 * HOUR,
    })));
    const respond = async () => ({
      transportOk: true,
      schemaDegraded: false,
      pools: [
        usdcPool("ethereum", q(1)),
        usdcPool("ethereum", q(2), { reserve: "500" }),
        { ...usdcPool("ethereum", q(3)), attributes: { ...usdcPool("ethereum", q(3)).attributes, base_token_price_quote_token: "1.2" } } as CgPool,
        usdcPool("ethereum", q(4), { basePrice: "1.6" }),
        // q(5) is not returned by the provider.
      ],
    });

    const first = await refreshStaleRegistryPools({
      db, cgApiKey: "key", stablecoins: STABLECOINS, nowSec: NOW, deadlineMs: Date.now() + 60_000, dependencies: makeDeps(respond),
    });

    expect(first).toMatchObject({ refreshed: 1, failed: 4, stalePoolsRemaining: 4, staleTvlRemaining: 14_000_000 });
    expect(sqlite.prepare("SELECT pool_id FROM dex_pool_registry WHERE refreshed_at = ?").all(NOW))
      .toEqual([{ pool_id: `ethereum:${q(1)}` }]);

    const next = await refreshStaleRegistryPools({
      db, cgApiKey: "key", stablecoins: STABLECOINS, nowSec: NOW + 2 * HOUR, deadlineMs: Date.now() + 60_000,
      dependencies: makeDeps(async () => ({ transportOk: true, schemaDegraded: false, pools: [] })),
    });
    expect(next).toMatchObject({ poolsDue: 4, refreshed: 0, stalePoolsRemaining: 4 });
  });

  it("stores a zero volume only when the provider also reports zero 24h trades", async () => {
    const { sqlite, db } = fixtures.open();
    const z = (index: number) => addr("fa", index);
    await seed(db, [1, 2, 3, 4].map((index) => ({ poolId: `ethereum:${z(index)}`, tvlUsd: 5_000_000, refreshedAt: NOW - 48 * HOUR })));
    const withAttributes = (index: number, attributes: Record<string, unknown>) => {
      const pool = usdcPool("ethereum", z(index));
      return { ...pool, attributes: { ...pool.attributes, ...attributes } } as CgPool;
    };
    const deps = makeDeps(async () => ({
      transportOk: true,
      schemaDegraded: false,
      pools: [
        withAttributes(1, { volume_usd: { h24: "0.0" }, transactions: { h24: { buys: 0, sells: 0 } } }),
        withAttributes(2, { volume_usd: { h24: "0.0" }, transactions: { h24: { buys: 3, sells: 1 } } }),
        withAttributes(3, { volume_usd: { h24: null }, transactions: { h24: { buys: null, sells: null } } }),
        withAttributes(4, { volume_usd: { h24: "0.0" } }),
      ],
    }));

    await refreshStaleRegistryPools({
      db, cgApiKey: "key", stablecoins: STABLECOINS, nowSec: NOW, deadlineMs: Date.now() + 60_000, dependencies: deps,
    });

    expect(sqlite.prepare("SELECT pool_id, volume_24h, refreshed_at FROM dex_pool_registry ORDER BY pool_id").all()).toEqual([
      { pool_id: `ethereum:${z(1)}`, volume_24h: 0, refreshed_at: NOW },
      { pool_id: `ethereum:${z(2)}`, volume_24h: null, refreshed_at: NOW },
      { pool_id: `ethereum:${z(3)}`, volume_24h: null, refreshed_at: NOW },
      { pool_id: `ethereum:${z(4)}`, volume_24h: null, refreshed_at: NOW },
    ]);
  });

  it("stops at the run budget and leaves the lowest-TVL remainder due for the next run", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 1_000_000 });
    const { db } = fixtures.open();
    const r = (index: number) => addr("dd", index);
    await seed(db, Array.from({ length: 31 }, (_, index) => ({
      poolId: `ethereum:${r(index)}`, tvlUsd: (index + 1) * 100_000, refreshedAt: NOW - 30 * HOUR,
    })));
    const deps = makeDeps(async (_network, addresses) => {
      vi.setSystemTime(Date.now() + 5_000);
      return { transportOk: true, schemaDegraded: false, pools: addresses.map((address) => usdcPool("ethereum", address)) };
    });

    const first = await refreshStaleRegistryPools({
      db, cgApiKey: "key", stablecoins: STABLECOINS, nowSec: NOW, dependencies: deps,
      deadlineMs: Date.now() + STALE_POOL_REFRESH_POLICY.requestTimeoutMs + 1_000,
    });

    expect(first).toMatchObject({
      outcome: "stopped-budget", poolsDue: 31, poolsSelected: 31, requests: 1, refreshed: 30, deferred: 1,
      stalePoolsRemaining: 1, staleTvlRemaining: 100_000,
    });
    expect(deps.fetchCgPoolsByAddressesWithStatus.mock.calls[0]![1]).toEqual(
      Array.from({ length: 30 }, (_, index) => r(30 - index)),
    );

    const next = await refreshStaleRegistryPools({
      db, cgApiKey: "key", stablecoins: STABLECOINS, nowSec: NOW + 2 * HOUR, deadlineMs: Date.now() + 60_000, dependencies: deps,
    });
    expect(deps.fetchCgPoolsByAddressesWithStatus.mock.calls[1]![1]).toEqual([r(0)]);
    expect(next).toMatchObject({ outcome: "completed", poolsDue: 1, refreshed: 1, stalePoolsRemaining: 0 });
  });

  it("ends the pass after consecutive provider failures without throwing", async () => {
    const { db } = fixtures.open();
    await seed(db, ["ethereum", "base", "optimism", "polygon"].map((chain, index) => ({
      poolId: `${chain}:${addr("ab", index)}`, chain, tvlUsd: 3_000_000 - index * 1_000_000 + 1_000, refreshedAt: NOW - 30 * HOUR,
    })));
    let calls = 0;
    const deps = makeDeps(async () => {
      calls += 1;
      if (calls === 2) throw new DOMException("timed out", "TimeoutError");
      return { transportOk: false, schemaDegraded: false, pools: [] };
    });

    const summary = await refreshStaleRegistryPools({
      db, cgApiKey: "key", stablecoins: STABLECOINS, nowSec: NOW, deadlineMs: Date.now() + 60_000, dependencies: deps,
    });

    expect(summary).toMatchObject({
      outcome: "stopped-provider-failures", requests: 3, refreshed: 0, failed: 3, deferred: 1, stalePoolsRemaining: 4,
    });
    expect(deps.recordOutcome.mock.calls.map((call) => call[2])).toEqual([false, false, false]);
  });

  it("skips an open circuit and stops when a request trips it", async () => {
    const { db } = fixtures.open();
    await seed(db, [
      { poolId: `ethereum:${addr("ef", 1)}`, tvlUsd: 2_000_000, refreshedAt: NOW - 30 * HOUR },
      { poolId: `base:${addr("ef", 2)}`, chain: "base", tvlUsd: 1_000_000, refreshedAt: NOW - 30 * HOUR },
    ]);
    const failing = async () => ({ transportOk: false, schemaDegraded: false, pools: [] as CgPool[] });

    const closedCircuit = makeDeps(failing, { circuitAllowed: false });
    await expect(refreshStaleRegistryPools({
      db, cgApiKey: "key", stablecoins: STABLECOINS, nowSec: NOW, deadlineMs: Date.now() + 60_000, dependencies: closedCircuit,
    })).resolves.toMatchObject({ outcome: "skipped-circuit-open", requests: 0, deferred: 2, staleTvlRemaining: 3_000_000 });
    expect(closedCircuit.fetchCgPoolsByAddressesWithStatus).not.toHaveBeenCalled();

    const tripping = makeDeps(failing, { circuitAfter: "open" });
    await expect(refreshStaleRegistryPools({
      db, cgApiKey: "key", stablecoins: STABLECOINS, nowSec: NOW, deadlineMs: Date.now() + 60_000, dependencies: tripping,
    })).resolves.toMatchObject({ outcome: "stopped-circuit-opened", requests: 1, failed: 1, deferred: 1 });
  });

  it("reports a registry read failure as a failed pass instead of throwing", async () => {
    const db = makeNoopD1({
      prepare: () => ({ bind: () => ({ all: async () => { throw new Error("D1_ERROR: overloaded"); } }) }),
    });

    await expect(refreshStaleRegistryPools({
      db, cgApiKey: "key", stablecoins: STABLECOINS, nowSec: NOW, deadlineMs: Date.now() + 60_000, dependencies: makeDeps(async () => {
        throw new Error("unreachable");
      }),
    })).resolves.toMatchObject({ outcome: "failed", error: "D1_ERROR: overloaded", requests: 0 });
  });
});

describe("planStalePoolRefreshBatches", () => {
  it("packs same-network pools in priority order and caps the request count", () => {
    const candidate = (poolId: string, network: string): StalePoolRefreshCandidate => ({
      poolId, network, chain: network, address: poolId, tvlUsd: 1, expired: true, stablecoinIds: ["usdc-circle"],
    });
    const ordered = [candidate("a1", "a"), candidate("b1", "b"), candidate("a2", "a"), candidate("a3", "a"), candidate("c1", "c")];

    expect(planStalePoolRefreshBatches(ordered, 2, 2).map((batch) => batch.candidates.map((entry) => entry.poolId)))
      .toEqual([["a1", "a2"], ["b1"]]);
  });
});
