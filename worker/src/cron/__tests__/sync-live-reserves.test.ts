import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAIN_META } from "@shared/types/chain-identity";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapters";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { ReserveAdapterCoin } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { installAdapterNetwork } from "../reserve-adapters/__tests__/reserve-adapter.test-support";
import { fetchEscrowBalanceReserves } from "../reserve-adapters/escrow-balance";
import { fetchCrvUsdReserves } from "../reserve-adapters/crvusd";
import { fetchFraxFpiCollateralReserves } from "../reserve-adapters/frax";
import { fetchFlyingTulipFtUsdReserves } from "../reserve-adapters/flying-tulip-ftusd";
import flyingTulipCapture from "../reserve-adapters/__tests__/fixtures/flying-tulip-ftusd-dashboard-2026-09-30.json";
import { fetchJupUsdReserves } from "../reserve-adapters/jupusd";
import { fetchKavaCdpReserves } from "../reserve-adapters/kava-cdp";
import { KAVA_LCD_FIXTURES, LATEST_BLOCK, TOTAL_COLLATERAL, TOTAL_COLLATERAL_URL } from "../reserve-adapters/__tests__/kava-cdp.test-support";
import { adaptUnitedPorPayload } from "../reserve-adapters/united-por";
import { UNITED_POR_PAYLOAD } from "../reserve-adapters/__tests__/united-por.test-support";
import { resolveReserveResult } from "../../lib/live-reserves/store-views";
import { buildChainRpcs, hasRegistryRpc } from "../../lib/chain-registry";
import { unverifiedFreshnessMetadata } from "../reserve-adapters/freshness";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { breakerKeyForConfig, SYNC_ORDERED_CONFIGURED_COINS } from "../sync-live-reserves-shared";
import { finalizeReserveSyncRun } from "../sync-live-reserves-finalize";
import { resolveLiveReserveSyncBudgetConfig } from "../sync-live-reserves-config";
import { createAdapterLatencyCollector, syncReserveCoin } from "../sync-live-reserves-core";
import { RESERVE_FEED_REVIEWS } from "../../lib/reserve-feed-reviews";
import type { ReserveSyncStateRecord } from "../../lib/live-reserves/store";
import {
  checkpointIdentity as makeCheckpointIdentity,
  checkpointTable as makeCheckpointTable,
  getReserveAdapterMock,
  mockLiveReserveAdapterRegistry,
  mockLiveReserveD1,
  recordOutcomeSafeMock,
  recoverNoCandidateMock,
  shouldAttemptFetchMock,
} from "./live-reserves.test-support";

const mockD1 = mockLiveReserveD1;
const mockAdapterRegistry = mockLiveReserveAdapterRegistry;

/**
 * Adapters whose gross-supply denominator aggregates totalSupply() across
 * every EVM/Tron deployment in `coin.contracts` (via
 * `aggregateMultichainErc20Supply` or its inline equivalent). These are the
 * only adapters whose contract chains are read through the shared chain RPC
 * map; every other adapter reads only its own input/params chains, so its
 * `coin.contracts` list is deployment metadata rather than a read scope.
 */
const MULTICHAIN_SUPPLY_ADAPTERS = new Set([
  "usd1-bundle-oracle",
  "chronicle-nav",
  "chainlink-por",
  "sodax-sonic",
]);

/**
 * EVM/Tron chains a live-reserve config reads over public RPC: the primary
 * onchain input, every EVM/Tron deployment in the coin's contracts (for
 * multichain-supply adapters), and any chain id carried in adapter params
 * (branch/leg/contract entries). Non-EVM chains (Solana, Aptos, …) are outside
 * the shared RPC map's scope.
 */
function referencedLiveReserveChains(coin: (typeof ACTIVE_STABLECOINS)[number]): Set<string> {
  const chains = new Set<string>();
  const config = coin.liveReservesConfig;
  const primary = config?.inputs.primary;
  if (primary?.kind === "onchain-evm") chains.add(primary.chain);

  if (config && MULTICHAIN_SUPPLY_ADAPTERS.has(config.adapter)) {
    for (const contract of coin.contracts ?? []) {
      const type = CHAIN_META[contract.chain]?.type;
      if (type === "evm" || type === "tron") chains.add(contract.chain);
    }
  }

  collectParamChainIds(config?.params, chains);
  return chains;
}

function collectParamChainIds(value: unknown, chains: Set<string>): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectParamChainIds(item, chains);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["chain", "chains"] as const) {
    const chainValue = record[key];
    if (typeof chainValue === "string") {
      const type = CHAIN_META[chainValue]?.type;
      if (type === "evm" || type === "tron") chains.add(chainValue);
    } else if (Array.isArray(chainValue)) {
      for (const chain of chainValue) {
        if (typeof chain === "string") {
          const type = CHAIN_META[chain]?.type;
          if (type === "evm" || type === "tron") chains.add(chain);
        }
      }
    }
  }
  // Only branch/leg arrays read their chains through the shared chain RPC map
  // (no per-entry URL). Other chain-bearing params — `deployments`,
  // `additionalDeployments`, `supplyChain` — resolve through explicit RPC URLs
  // or `getPublicRpcUrl()` and sit outside this assertion's scope.
  for (const key of ["branches", "legs"] as const) {
    collectParamChainIds(record[key], chains);
  }
}

describe("syncLiveReserves", () => {
  const fixtures = createLatestSchemaFixtureTracker();
  let replacedStore = false;
  afterEach(() => {
    fixtures.closeAll();
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (replacedStore) {
      vi.doUnmock("../../lib/live-reserves/store");
      vi.resetModules();
      replacedStore = false;
    }
  });
  const configuredCoinCount = ACTIVE_STABLECOINS.filter((coin) => coin.liveReservesConfig).length;
  const sharedSourceInvocationCount = ACTIVE_STABLECOINS
    .filter((coin) => coin.liveReservesConfig)
    .reduce((keys, coin) => {
      const config = coin.liveReservesConfig!;
      const definition = LIVE_RESERVE_ADAPTER_DEFINITIONS[config.adapter];
      const primary = config.inputs.primary;
      if (
        definition.sharedSourceMode !== "source-invariant"
        || (primary.kind !== "http-json" && primary.kind !== "http-html")
      ) {
        keys.add(`coin:${coin.id}`);
        return keys;
      }

      keys.add(JSON.stringify({
        adapter: config.adapter,
        version: config.version,
        semantics: config.semantics,
        inputs: {
          primary,
          fallbacks: config.inputs.fallbacks ?? null,
        },
        params: config.params ?? null,
      }));
      return keys;
    }, new Set<string>())
    .size;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    shouldAttemptFetchMock.mockResolvedValue(true);
    recordOutcomeSafeMock.mockResolvedValue(undefined);
    recoverNoCandidateMock.mockClear();
  });

  it("keeps public RPC live-reserve inputs resolvable", () => {
    const chainRpcs = buildChainRpcs();
    const missingRpc = ACTIVE_STABLECOINS
      .filter((coin) => {
        const primary = coin.liveReservesConfig?.inputs.primary;
        return primary?.kind === "onchain-evm" && primary.rpcMode === "public-rpc";
      })
      .flatMap((coin) => {
        const config = coin.liveReservesConfig!;
        const primary = config.inputs.primary;
        if (primary.kind !== "onchain-evm") return [];

        const params = config.params;
        const explicitRpcUrl = typeof params === "object" && params !== null && !Array.isArray(params)
          ? (params as { rpcUrl?: unknown }).rpcUrl
          : undefined;
        const hasExplicitRpcUrl = typeof explicitRpcUrl === "string" && explicitRpcUrl.length > 0;

        return [...referencedLiveReserveChains(coin)]
          .filter((chain) => {
            // The primary input may resolve through its own configured RPC URL;
            // every other referenced chain is read through buildChainRpcs().
            if (chain === primary.chain && hasExplicitRpcUrl) return false;
            return !hasRegistryRpc(chainRpcs.get(chain));
          })
          .map((chain) => `${coin.id}:${chain}`);
      });

    expect(missingRpc).toEqual([]);
  });

  it("refuses a recovery suffix when the configured queue hash changed", async () => {
    const checkpointIdentity = makeCheckpointIdentity(2, "recovery-owner");
    const db = mockD1([makeCheckpointTable({
      attemptNo: checkpointIdentity.attemptNo,
      invocationId: checkpointIdentity.invocationId,
      nextItemKey: SYNC_ORDERED_CONFIGURED_COINS[0]?.id ?? null,
      itemsDone: 0,
      queueHash: "stale-queue-hash",
    })]);
    const { syncLiveReserves } = await import("../sync-live-reserves");

    await expect(syncLiveReserves(
      db,
      new AbortController().signal,
      {},
      undefined,
      undefined,
      checkpointIdentity,
    )).rejects.toThrow("refusing unsafe suffix replay");
    expect(getReserveAdapterMock).not.toHaveBeenCalled();
  });

  it("rejects a recovery attempt when its checkpoint is missing", async () => {
    const checkpointIdentity = makeCheckpointIdentity(2, "missing-owner");
    const db = mockD1([{ match: "FROM worker_scheduled_checkpoints", rows: [] }]);
    const { syncLiveReserves } = await import("../sync-live-reserves");

    await expect(syncLiveReserves(
      db,
      new AbortController().signal,
      {},
      undefined,
      undefined,
      checkpointIdentity,
    )).rejects.toThrow("live reserve checkpoint missing");
    expect(getReserveAdapterMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "an authoritative checkpoint item left the queue",
      nextItemKey: "removed-coin",
      currentDomainAttemptId: "authoritative-attempt",
      expected: "live reserve checkpoint item removed-coin no longer exists in the queue",
    },
    {
      label: "a pending checkpoint item left the queue",
      nextItemKey: "removed-coin",
      currentDomainAttemptId: null,
      expected: "live reserve checkpoint item removed-coin no longer exists in the queue",
    },
  ])("rejects unsafe recovery when $label", async ({ nextItemKey, currentDomainAttemptId, expected }) => {
    const checkpointIdentity = makeCheckpointIdentity(2, "recovery-owner");
    const db = mockD1([
      makeCheckpointTable({
        attemptNo: checkpointIdentity.attemptNo,
        invocationId: checkpointIdentity.invocationId,
        nextItemKey,
        currentItemKey: currentDomainAttemptId ? nextItemKey : null,
        currentDomainAttemptId,
        itemsDone: 0,
      }),
      ...(currentDomainAttemptId
        ? [
            { match: "SELECT 1 AS finalized", rows: [{ finalized: 1 }] },
          ]
        : []),
    ]);
    const { syncLiveReserves } = await import("../sync-live-reserves");

    await expect(syncLiveReserves(
      db,
      new AbortController().signal,
      {},
      undefined,
      undefined,
      checkpointIdentity,
    )).rejects.toThrow(expected);
    expect(getReserveAdapterMock).not.toHaveBeenCalled();
  });

  it("refreshes the adapter clock after time spent earlier in the reserve queue", async () => {
    const startedMs = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(startedMs);
    const fetch = mockAdapterRegistry(async () => ({
      slices: [{ name: "Cash", pct: 100, risk: "low" as const }],
    }));
    fetch.mockImplementationOnce(async () => {
      clock.mockReturnValue(startedMs + 180_000);
      return {
        slices: [{ name: "Cash", pct: 100, risk: "low" as const }],
        metadata: { freshnessMode: "not-applicable" as const },
      };
    });
    try {
      const { syncLiveReserves } = await import("../sync-live-reserves");
      await syncLiveReserves(mockD1(), new AbortController().signal, {}, undefined, { runBudgetMs: 720_000 });
      expect(fetch).toHaveBeenCalledWith(
        expect.anything(), expect.anything(), expect.anything(),
        expect.objectContaining({ nowSec: Math.floor(startedMs / 1_000) + 180 }),
      );
    } finally {
      clock.mockRestore();
    }
  });


  it("reuses identical shared HTTP reserve sources within a run", async () => {
    const adapterFetch = mockAdapterRegistry(async () => ({
      slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }],
    }));

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const { db, sqlite } = fixtures.open();
    const result = await syncLiveReserves(db, new AbortController().signal, {});

    expect(adapterFetch).toHaveBeenCalledTimes(sharedSourceInvocationCount);
    expect(sharedSourceInvocationCount).toBeLessThan(configuredCoinCount);
    expect(result.itemCount).toBe(configuredCoinCount);
    const snapshots = sqlite.prepare("SELECT stablecoin_id, slices FROM reserve_composition ORDER BY stablecoin_id").all();
    expect(snapshots.map((row) => row.stablecoin_id)).toEqual(
      ACTIVE_STABLECOINS.filter((coin) => coin.liveReservesConfig).map((coin) => coin.id).sort(),
    );
    expect(snapshots.map((row) => JSON.parse(String(row.slices)))).toEqual(
      snapshots.map(() => [{ name: "Mock Farm", pct: 100, risk: "low" }]),
    );
  });

  // Reservoir's exact preceding leg is coin-dependent: srUSD uses the
  // SavingModule fee; current wsrUSD unwraps directly to rUSD with no fee.
  // Sharing one result across the three coins would misattribute that evidence.
  const RESERVOIR_COIN_IDS = ["rusd-reservoir", "srusd-reservoir", "wsrusd-reservoir"] as const;

  interface ReserveCompositionRow {
    stablecoin_id: string;
    metadata: string;
  }

  function parseReserveCompositionRow(row: Record<string, unknown>): ReserveCompositionRow {
    const stablecoinId = row.stablecoin_id;
    const metadata = row.metadata;
    if (typeof stablecoinId !== "string" || typeof metadata !== "string") {
      throw new TypeError("Expected reserve composition row strings");
    }
    return { stablecoin_id: stablecoinId, metadata };
  }

  async function runReservoirQueue(order: "canonical" | "reversed") {
    vi.resetModules();
    const shared = await import("../sync-live-reserves-shared");
    const queue = [...shared.SYNC_ORDERED_CONFIGURED_COINS];
    const slots = queue.flatMap((coin, index) =>
      (RESERVOIR_COIN_IDS as readonly string[]).includes(coin.id) ? [index] : [],
    );
    const reservoirCoins = slots.map((index) => queue[index]!);
    if (order === "reversed") reservoirCoins.reverse();
    slots.forEach((index, position) => { queue[index] = reservoirCoins[position]!; });
    vi.doMock("../sync-live-reserves-shared", () => ({
      ...shared,
      SYNC_ORDERED_CONFIGURED_COINS: queue,
    }));

    const adapterFetch = mockAdapterRegistry(async (coin, config) => {
      if (config?.adapter !== "reservoir") {
        return { slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] };
      }
      return {
        slices: [{ name: "USDC positions", pct: 100, risk: "low" as const }],
        metadata: {
          ...unverifiedFreshnessMetadata("protocol-balance-sheet-api", "fixture balance sheet carries no timestamp"),
          unknownExposurePct: 0,
          supplyUsd: 95,
          redemption: {
            capacityUsd: 4,
            capacityKind: "live-direct",
            freshnessKind: "same-run-onchain",
            sourceTimestamp: Math.floor(Date.now() / 1000) - 12,
            blockNumber: 26_142_993,
            outputAssetKeys: ["usdc-circle"],
            sharedResourceKey: "ethereum:reservoir-psm:0x4809010926aec940b550d34a46a52739f996d75d",
            routeStatus: "open",
            routeStatusSource: "onchain",
            holderEligibility: "any-holder",
            settlementDelaySec: 0,
            ...(coin!.id === "srusd-reservoir" ? { feeBps: 1.34 } :
              coin!.id === "wsrusd-reservoir" ? { feeBps: 0 } : {}),
          },
        },
      };
    });

    try {
      const { syncLiveReserves } = await import("../sync-live-reserves");
      const { db, sqlite } = fixtures.open();
      await syncLiveReserves(db, new AbortController().signal, {});
      // Reading back through the persisted row proves the orchestrator wrote
      // three distinct snapshots rather than one shared result.
      const rows = sqlite
        .prepare("SELECT stablecoin_id, metadata FROM reserve_composition ORDER BY stablecoin_id")
        .all()
        .map(parseReserveCompositionRow);
      const redemptionByCoin: Record<string, unknown> = {};
      for (const row of rows) {
        if (!(RESERVOIR_COIN_IDS as readonly string[]).includes(row.stablecoin_id)) continue;
        const metadata: unknown = JSON.parse(row.metadata);
        redemptionByCoin[row.stablecoin_id] =
          metadata && typeof metadata === "object" && "redemption" in metadata ? metadata.redemption : undefined;
      }
      const reservoirCallCount = adapterFetch.mock.calls.filter(
        ([, config]) => config?.adapter === "reservoir",
      ).length;
      return { redemptionByCoin, reservoirCallCount };
    } finally {
      vi.doUnmock("../sync-live-reserves-shared");
      vi.resetModules();
    }
  }

  it.each(["canonical", "reversed"] as const)(
    "publishes each Reservoir coin's own redemption contract in %s queue order",
    async (order) => {
      const { redemptionByCoin, reservoirCallCount } = await runReservoirQueue(order);

      expect(reservoirCallCount).toBe(RESERVOIR_COIN_IDS.length);
      expect(Object.keys(redemptionByCoin).sort()).toEqual([...RESERVOIR_COIN_IDS]);
      expect(redemptionByCoin["rusd-reservoir"]).not.toHaveProperty("feeBps");
      expect(redemptionByCoin["srusd-reservoir"]).toMatchObject({ feeBps: 1.34 });
      expect(redemptionByCoin["wsrusd-reservoir"]).toMatchObject({ feeBps: 0 });
      for (const redemption of Object.values(redemptionByCoin)) {
        expect(redemption).not.toHaveProperty("capacityRatioOfSupply");
      }
    },
  );

  it.each(["observed-zero", "unavailable"] as const)(
    "replaces positive escrow capacity only with an observed value (%s)", async (outcome) => {
      let nowMs = Date.now();
      vi.spyOn(Date, "now").mockImplementation(() => nowMs);
      let balance: bigint | null = 100_000_000n;
      const network = installAdapterNetwork({
        chains: { ethereum: "https://rpc.example" },
        rpc: { "0xc47cf5ef": () => balance, "0x5c975abb": false },
      });
      getReserveAdapterMock.mockImplementation((adapterKey: keyof typeof LIVE_RESERVE_ADAPTER_DEFINITIONS) => ({
        ...LIVE_RESERVE_ADAPTER_DEFINITIONS[adapterKey],
        key: adapterKey,
        fetch: async (coin: ReserveAdapterCoin, config: LiveReservesConfig) => {
          if (coin.id === "usdcx-movement") {
            return fetchEscrowBalanceReserves(coin, config, new AbortController().signal, { chainRpcs: network.chainRpcs });
          }
          return { slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] };
        },
      }));
      const { db, sqlite } = fixtures.open();
      // This suite resets/mocks the producer module graph between cases.
      const { syncLiveReserves } = await import("../sync-live-reserves");
      await syncLiveReserves(db, new AbortController().signal, {});
      const before = sqlite.prepare(
        "SELECT fetched_at, attempt_id, metadata FROM reserve_composition WHERE stablecoin_id = ?",
      ).get("usdcx-movement");
      expect(before).toBeDefined();
      expect((await resolveReserveResult(db, "usdcx-movement", Math.floor(nowMs / 1000)))?.metadata?.redemption)
        .toMatchObject({ capacityUsd: 100 });
      nowMs += 60_000;
      balance = outcome === "observed-zero" ? 0n : null;
      await syncLiveReserves(db, new AbortController().signal, {});
      const after = sqlite.prepare(
        "SELECT fetched_at, attempt_id, metadata FROM reserve_composition WHERE stablecoin_id = ?",
      ).get("usdcx-movement");
      const served = await resolveReserveResult(db, "usdcx-movement", Math.floor(nowMs / 1000));
      expect(served?.metadata?.redemption).toMatchObject({ capacityUsd: outcome === "observed-zero" ? 0 : 100 });
      if (outcome === "observed-zero") {
        expect(after).not.toEqual(before);
        expect(served?.liveAt).toBe(Math.floor(nowMs / 1000));
        nowMs += 60_000;
        balance = null;
        await syncLiveReserves(db, new AbortController().signal, {});
        expect(sqlite.prepare(
          "SELECT fetched_at, attempt_id, metadata FROM reserve_composition WHERE stablecoin_id = ?",
        ).get("usdcx-movement")).toEqual(after);
        const retainedZero = await resolveReserveResult(db, "usdcx-movement", Math.floor(nowMs / 1000));
        expect(retainedZero?.metadata?.redemption).toMatchObject({ capacityUsd: 0 });
        expect(retainedZero?.liveAt).toBe(Math.floor(nowMs / 1000) - 60);
      } else {
        expect(after).toEqual(before);
        expect(served?.liveAt).toBe(Math.floor(nowMs / 1000) - 60);
      }
    },
  );

  it("replaces retained healthy aggregate backing with observed zero and retains that loss after a failed read", async () => {
    let nowMs = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    let totalReserve = "110";
    getReserveAdapterMock.mockImplementation((adapterKey: keyof typeof LIVE_RESERVE_ADAPTER_DEFINITIONS) => ({
      ...LIVE_RESERVE_ADAPTER_DEFINITIONS[adapterKey],
      key: adapterKey,
      fetch: async (coin: ReserveAdapterCoin) => coin.id === "u-united-stables"
        ? adaptUnitedPorPayload({
            ...UNITED_POR_PAYLOAD, totalReserve, totalToken: "100", updatedAt: new Date(nowMs).toISOString(),
          }, { name: "Aggregate backing", risk: "low" })
        : { slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] },
    }));
    const { db, sqlite } = fixtures.open();
    // The producer graph is reset between cases; load its current mocks.
    const { syncLiveReserves } = await import("../sync-live-reserves");
    await syncLiveReserves(db, new AbortController().signal, {});
    const healthy = sqlite.prepare("SELECT * FROM reserve_composition WHERE stablecoin_id = ?").get("u-united-stables");
    expect(healthy).toBeDefined();
    expect((await resolveReserveResult(db, "u-united-stables", Math.floor(nowMs / 1000)))?.metadata)
      .toMatchObject({ totalReserveUsd: 110, collateralizationRatio: 1.1 });
    nowMs += 60_000;
    totalReserve = "0";
    await syncLiveReserves(db, new AbortController().signal, {});
    const adverse = sqlite.prepare("SELECT * FROM reserve_composition WHERE stablecoin_id = ?").get("u-united-stables");
    expect(adverse).not.toEqual(healthy);
    const served = await resolveReserveResult(db, "u-united-stables", Math.floor(nowMs / 1000));
    expect(served?.metadata).toMatchObject({ totalReserveUsd: 0, supplyUsd: 100, collateralizationRatio: 0 });
    expect(served?.liveAt).toBe(Math.floor(nowMs / 1000));
    const state = sqlite.prepare("SELECT last_status, warnings, last_success_at FROM reserve_sync_state WHERE stablecoin_id = ?")
      .get("u-united-stables")!;
    expect(state.last_status).toBe("degraded");
    expect(state.last_success_at).toBe(Math.floor(nowMs / 1000));
    expect(JSON.parse(String(state.warnings))).toContainEqual(expect.objectContaining({
      code: "united-por-reserve-under-token", effect: "degraded",
    }));
    nowMs += 60_000;
    totalReserve = "unavailable";
    await syncLiveReserves(db, new AbortController().signal, {});
    expect(sqlite.prepare("SELECT * FROM reserve_composition WHERE stablecoin_id = ?").get("u-united-stables")).toEqual(adverse);
    const retained = await resolveReserveResult(db, "u-united-stables", Math.floor(nowMs / 1000));
    expect(retained?.metadata).toMatchObject({ totalReserveUsd: 0, collateralizationRatio: 0 });
    expect(retained?.liveAt).toBe(Math.floor(nowMs / 1000) - 60);
  });

  it.each(["curve-markets-incomplete", "yield-basis-incomplete"] as const)(
    "retains the complete crvUSD book and original clocks after %s", async (reason) => {
      let nowMs = Date.now();
      vi.spyOn(Date, "now").mockImplementation(() => nowMs);
      let incomplete = false;
      const network = installAdapterNetwork({
        chains: { ethereum: "https://rpc.example" },
        rpc: { "market_count()": () => incomplete && reason === "yield-basis-incomplete" ? null : 0n },
        json: { "https://curve.example/markets": () => ({ chains: { ethereum: { data: [
          { collateral_amount_usd: 100, collateral_token: { symbol: "WBTC" } },
          { ...(incomplete && reason === "curve-markets-incomplete" ? {} : { collateral_amount_usd: 100 }),
            collateral_token: { symbol: "WETH" } },
        ] } } }) },
      });
      getReserveAdapterMock.mockImplementation((adapterKey: keyof typeof LIVE_RESERVE_ADAPTER_DEFINITIONS) => ({
        ...LIVE_RESERVE_ADAPTER_DEFINITIONS[adapterKey], key: adapterKey,
        fetch: async (coin: ReserveAdapterCoin, config: LiveReservesConfig) => coin.id === "crvusd-curve"
          ? fetchCrvUsdReserves(coin, {
            ...config, inputs: { primary: { kind: "http-json", url: "https://curve.example/markets" } },
          }, new AbortController().signal, { chainRpcs: network.chainRpcs })
          : { slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] },
      }));
      const { db, sqlite } = fixtures.open();
      // This suite resets/mocks the producer module graph between cases, so a static import would retain stale mocks.
      const { syncLiveReserves } = await import("../sync-live-reserves");
      await syncLiveReserves(db, new AbortController().signal, {});
      const snapshot = sqlite.prepare("SELECT * FROM reserve_composition WHERE stablecoin_id = ?").get("crvusd-curve");
      expect(snapshot).toBeDefined();
      const original = await resolveReserveResult(db, "crvusd-curve", Math.floor(nowMs / 1000));
      expect(original?.reserves.map((slice) => slice.pct)).toEqual([50, 50]);
      for (let attempt = 0; attempt < 2; attempt++) {
        incomplete = true;
        nowMs += 60_000;
        await syncLiveReserves(db, new AbortController().signal, {});
        expect(sqlite.prepare("SELECT * FROM reserve_composition WHERE stablecoin_id = ?").get("crvusd-curve")).toEqual(snapshot);
        const served = await resolveReserveResult(db, "crvusd-curve", Math.floor(nowMs / 1000));
        expect(served?.reserves).toEqual(original?.reserves);
        expect(served?.liveAt).toBe(original?.liveAt);
        const state = sqlite.prepare("SELECT last_status, warnings, metadata FROM reserve_sync_state WHERE stablecoin_id = ?").get("crvusd-curve")!;
        expect(state.last_status).toBe("error");
        expect(JSON.parse(String(state.warnings))).toContainEqual(expect.objectContaining({ code: reason, effect: "fatal" }));
        const diagnostics = JSON.parse(String(state.metadata)).adapterDiagnostics;
        expect(diagnostics.details.measuredDirectCollateralUsd).toBe(reason === "curve-markets-incomplete" ? 100 : 200);
        expect(diagnostics).not.toHaveProperty("yieldBasisCollateralUsd");
        expect(diagnostics).not.toHaveProperty("yieldBasisCollateralPct");
      }
    },
  );

  it.each([
    { id: "fpi-frax", adapter: "frax-fpi-collateral", reason: "asset-coverage-incomplete" },
    { id: "ftusd-flying-tulip", adapter: "flying-tulip-ftusd", reason: "unexpected-chain" },
  ] as const)("retains the complete $id book and original clocks after scope loss", async ({ id, adapter, reason }) => {
    let nowMs = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    let incomplete = false;
    const endpoint = "https://reserves.example/book";
    const network = installAdapterNetwork({
      code: { "0x2397321b301b80a1c0911d6f9ed4b6033d43cf51": "0x" },
      json: { [endpoint]: () => adapter === "frax-fpi-collateral"
        ? {
          updatedAtTimestampSec: Math.floor(nowMs / 1000),
          assets: [
            { tokenSymbol: "FRAX", valueUsd: 100 }, { tokenSymbol: "FXS", valueUsd: 100 },
            ...(incomplete ? [{ tokenSymbol: "sfrxUSD", valueUsd: null }] : []),
          ],
          liabilities: [{ tokenSymbol: "FPI", valueUsd: 200 }],
        }
        : {
          ...flyingTulipCapture, lastUpdated: new Date(nowMs).toISOString(),
          chains: [
            ...flyingTulipCapture.chains,
            ...(incomplete ? [{ chainId: 137, chainName: "Polygon", tvlUsd: 900, metrics: { totalSupplyUsd: 900 } }] : []),
          ],
        },
      },
    });
    getReserveAdapterMock.mockImplementation((adapterKey: keyof typeof LIVE_RESERVE_ADAPTER_DEFINITIONS) => ({
      ...LIVE_RESERVE_ADAPTER_DEFINITIONS[adapterKey], key: adapterKey,
      fetch: async (coin: ReserveAdapterCoin, config: LiveReservesConfig) => {
        if (coin.id !== id) return { slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] };
        const fetcher = adapter === "frax-fpi-collateral" ? fetchFraxFpiCollateralReserves : fetchFlyingTulipFtUsdReserves;
        return fetcher(coin, { ...config, inputs: { primary: { kind: "http-json", url: endpoint } } },
          new AbortController().signal, { chainRpcs: network.chainRpcs });
      },
    }));
    const { db, sqlite } = fixtures.open();
    // The suite resets the producer graph between cases; a static import would retain stale mocks.
    const { syncLiveReserves } = await import("../sync-live-reserves");
    await syncLiveReserves(db, new AbortController().signal, {});
    const snapshot = sqlite.prepare("SELECT * FROM reserve_composition WHERE stablecoin_id = ?").get(id);
    expect(snapshot).toBeDefined();
    const original = await resolveReserveResult(db, id, Math.floor(nowMs / 1000));
    expect(original?.mode).toBe("live");
    expect(original?.reserves.length).toBeGreaterThan(0);
    const success = sqlite.prepare("SELECT last_success_at, last_success_attempt_id FROM reserve_sync_state WHERE stablecoin_id = ?").get(id);
    for (let attempt = 0; attempt < 2; attempt++) {
      incomplete = true;
      nowMs += 60_000;
      await syncLiveReserves(db, new AbortController().signal, {});
      expect(sqlite.prepare("SELECT * FROM reserve_composition WHERE stablecoin_id = ?").get(id)).toEqual(snapshot);
      expect(sqlite.prepare("SELECT last_success_at, last_success_attempt_id FROM reserve_sync_state WHERE stablecoin_id = ?").get(id)).toEqual(success);
      const served = await resolveReserveResult(db, id, Math.floor(nowMs / 1000));
      expect(served?.reserves).toEqual(original?.reserves);
      expect(served?.metadata?.sourceTimestamp).toBe(original?.metadata?.sourceTimestamp);
      expect(served?.liveAt).toBe(original?.liveAt);
      const state = sqlite.prepare("SELECT last_status, last_error, warnings, metadata FROM reserve_sync_state WHERE stablecoin_id = ?").get(id)!;
      expect(state.last_status).toBe("error");
      if (adapter === "frax-fpi-collateral") {
        expect(JSON.parse(String(state.warnings))).toContainEqual(expect.objectContaining({ code: reason, effect: "fatal" }));
        expect(JSON.parse(String(state.metadata)).adapterDiagnostics).toMatchObject({
          compositionComplete: false, knownCollateralUsd: 200, totalLiabilitiesUsd: 200,
        });
      } else {
        expect(state.last_error).toContain(reason);
      }
    }
  });

  it.each([
    { id: "jupusd-jupiter", adapter: "jupusd", reason: "holdings-incomplete" },
    { id: "usdx-kava", adapter: "kava-cdp", reason: "collateral-coverage-incomplete" },
  ] as const)("retains the complete $id book and original clocks after unavailable valuation", async ({ id, adapter, reason }) => {
    let nowMs = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    let incomplete = false;
    const endpoint = adapter === "jupusd" ? "https://jupusd.example/data" : TOTAL_COLLATERAL_URL;
    installAdapterNetwork({
      json: adapter === "jupusd" ? {
        [endpoint]: () => ({
          totalSupply: "200000000",
          holdings: [
            { name: "USDC", amount: "100000000", decimals: 6 },
            { name: "USDtb", amount: "100000000", ...(incomplete ? {} : { decimals: 6 }) },
          ],
        }),
        "https://jupusd.example/snapshots": () => ({ snapshots: [{ timestamp: Math.floor(nowMs / 1000) }] }),
      } : {
        ...KAVA_LCD_FIXTURES,
        [TOTAL_COLLATERAL_URL]: () => {
          const payload = structuredClone(TOTAL_COLLATERAL);
          if (incomplete) payload.total_collateral.find((row) => row.collateral_type === "swp-a")!.amount.amount = "1000000000";
          return payload;
        },
        "https://api.kava.io/cosmos/base/tendermint/v1beta1/blocks/latest": () => ({
          block: { header: { ...LATEST_BLOCK.block.header, time: new Date(nowMs).toISOString() } },
        }),
      },
    });
    getReserveAdapterMock.mockImplementation((adapterKey: keyof typeof LIVE_RESERVE_ADAPTER_DEFINITIONS) => ({
      ...LIVE_RESERVE_ADAPTER_DEFINITIONS[adapterKey], key: adapterKey,
      fetch: async (coin: ReserveAdapterCoin, config: LiveReservesConfig) => {
        if (coin.id !== id) return { slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] };
        const fetcher = adapter === "jupusd" ? fetchJupUsdReserves : fetchKavaCdpReserves;
        return fetcher(coin, {
          ...config, inputs: { primary: { kind: "http-json", url: endpoint } },
          ...(adapter === "jupusd" ? { params: { snapshotsUrl: "https://jupusd.example/snapshots" } } : {}),
        }, new AbortController().signal, { nowSec: Math.floor(nowMs / 1000) });
      },
    }));
    const { db, sqlite } = fixtures.open();
    // The suite resets the producer module graph between cases; static imports retain stale mocks.
    const { syncLiveReserves } = await import("../sync-live-reserves");
    await syncLiveReserves(db, new AbortController().signal, {});
    const snapshot = sqlite.prepare("SELECT * FROM reserve_composition WHERE stablecoin_id = ?").get(id);
    expect(snapshot).toBeDefined();
    const original = await resolveReserveResult(db, id, Math.floor(nowMs / 1000));
    expect(original?.mode).toBe("live");
    expect(original?.reserves.length).toBeGreaterThan(0);
    const success = sqlite.prepare("SELECT last_success_at, last_success_attempt_id FROM reserve_sync_state WHERE stablecoin_id = ?").get(id);
    for (let attempt = 0; attempt < 2; attempt++) {
      incomplete = true;
      nowMs += 60_000;
      await syncLiveReserves(db, new AbortController().signal, {});
      expect(sqlite.prepare("SELECT * FROM reserve_composition WHERE stablecoin_id = ?").get(id)).toEqual(snapshot);
      expect(sqlite.prepare("SELECT last_success_at, last_success_attempt_id FROM reserve_sync_state WHERE stablecoin_id = ?").get(id)).toEqual(success);
      const served = await resolveReserveResult(db, id, Math.floor(nowMs / 1000));
      expect(served?.reserves).toEqual(original?.reserves);
      expect(served?.liveAt).toBe(original?.liveAt);
      expect(served?.metadata?.sourceTimestamp).toBe(original?.metadata?.sourceTimestamp);
      const state = sqlite.prepare("SELECT last_status, warnings, metadata FROM reserve_sync_state WHERE stablecoin_id = ?").get(id)!;
      expect(state.last_status).toBe("error");
      expect(JSON.parse(String(state.warnings))).toContainEqual(expect.objectContaining({ code: reason, effect: "fatal" }));
      const diagnostics = JSON.parse(String(state.metadata)).adapterDiagnostics;
      expect(diagnostics).not.toHaveProperty("totalReserveUsd");
      expect(diagnostics).not.toHaveProperty("collateralizationRatio");
      expect(diagnostics).not.toHaveProperty("unknownExposurePct");
      expect(diagnostics).not.toHaveProperty("redemption");
      expect(diagnostics.details).toMatchObject(adapter === "jupusd"
        ? { measuredHoldingsUsd: 100, unavailableHoldingNames: ["1:USDtb"] }
        : { unpricedCollateralTypes: ["swp-a"], unpricedPrincipalTokens: 4.889684 });
    }
  });

  it("returns ok with warning metadata when the adapter yields warnings (warnings are metadata-only)", async () => {
    mockAdapterRegistry(
      async () => ({
        slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }],
        warnings: [{ code: "unknown-position", message: "Unmapped reserve position: new-farm", severity: "warning" as const }],
      }),
    );

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();
    const result = await syncLiveReserves(db, new AbortController().signal, {});
    const metadata = JSON.parse(result?.metadata ?? "{}") as { warningCount?: number };

    // Warnings remain metadata; unacknowledged failures determine execution status.
    expect(result?.status).toBe("ok");
    expect(metadata.warningCount).toBeGreaterThanOrEqual(configuredCoinCount);
  });

  it.each(["open", "half-open"])("retains %s breaker admission/probe handling after the bulk read", async (state) => {
    shouldAttemptFetchMock.mockResolvedValue(false);
    mockAdapterRegistry(async () => {
      throw new Error("adapter should not run when circuit is open");
    });

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1([{
      match: "SELECT key, value, updated_at FROM cache WHERE key IN",
      rows: SYNC_ORDERED_CONFIGURED_COINS.map((coin) => ({
        key: `circuit:${breakerKeyForConfig(coin.liveReservesConfig!)}`,
        value: JSON.stringify({
          state, consecutiveFailures: 3, lastFailureAt: Math.floor(Date.now() / 1000),
          lastSuccessAt: null, openedAt: Math.floor(Date.now() / 1000),
        }),
        updated_at: Math.floor(Date.now() / 1000),
      })),
    }]);
    const result = await syncLiveReserves(db, new AbortController().signal, {});

    // An all-circuit-open run synced nothing but had no genuine failures and no
    // budget-deferred tail; this is healthy recovery behavior, surfaced as
    // "degraded" rather than masked as "error".
    expect(result?.status).toBe("degraded");
    expect(result?.itemCount).toBe(0);
    expect(db.getHistory().some((entry) => entry.sql.includes("reserve_sync_state"))).toBe(true);
    expect(recordOutcomeSafeMock).not.toHaveBeenCalled();
    expect(shouldAttemptFetchMock).toHaveBeenCalledTimes(new Set(
      SYNC_ORDERED_CONFIGURED_COINS.map((coin) => breakerKeyForConfig(coin.liveReservesConfig!)),
    ).size);
  });

  it("records circuit breaker outcome only once per unique breakerKey per run", async () => {
    mockAdapterRegistry(
      async () => ({ slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] }),
    );

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();
    await syncLiveReserves(db, new AbortController().signal, {});

    const callsByKey = new Map<string, number>();
    for (const call of recordOutcomeSafeMock.mock.calls) {
      const key = call[1] as string;
      callsByKey.set(key, (callsByKey.get(key) ?? 0) + 1);
    }

    for (const [key, count] of callsByKey) {
      expect(count, `breakerKey "${key}" recorded ${count} times, expected 1`).toBe(1);
    }

    const uniqueBreakerKeys = new Set(
      ACTIVE_STABLECOINS
        .filter((c) => c.liveReservesConfig)
        .map((c) => `live-reserves:${c.liveReservesConfig!.breakerScope ?? c.liveReservesConfig!.adapter}`),
    );
    expect(recordOutcomeSafeMock).toHaveBeenCalledTimes(uniqueBreakerKeys.size);
  });

  it("skips closed success breaker heartbeats but still records failed outcomes", async () => {
    const firstQueuedCoin = SYNC_ORDERED_CONFIGURED_COINS[0]!;
    const failedBreakerKey = `live-reserves:${
      firstQueuedCoin.liveReservesConfig!.breakerScope ?? firstQueuedCoin.liveReservesConfig!.adapter
    }`;
    mockAdapterRegistry(async (coin) => {
      if (coin?.id === firstQueuedCoin.id) {
        throw new Error("HTTP 503 forced reserve source outage");
      }
      return { slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] };
    });

    const uniqueBreakerKeys = new Set(
      ACTIVE_STABLECOINS
        .filter((c) => c.liveReservesConfig)
        .map((c) => `live-reserves:${c.liveReservesConfig!.breakerScope ?? c.liveReservesConfig!.adapter}`),
    );
    const closedBreakerRows = Array.from(uniqueBreakerKeys, (key) => ({
      key: `circuit:${key}`,
      value: JSON.stringify({
        state: "closed",
        consecutiveFailures: 0,
        lastFailureAt: null,
        lastSuccessAt: 1_700_000_000,
        openedAt: null,
      }),
    }));

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1([
      {
        match: "SELECT key, value, updated_at FROM cache WHERE key IN",
        rows: closedBreakerRows.map((row) => ({ ...row, updated_at: 1_700_000_000 })),
      },
    ]);
    const result = await syncLiveReserves(db, new AbortController().signal, {});
    const metadata = JSON.parse(result?.metadata ?? "{}") as {
      breakerOutcomesRecorded?: number;
      breakerOutcomesSkippedClosedSuccess?: number;
    };

    expect(recordOutcomeSafeMock).toHaveBeenCalledTimes(1);
    expect(recordOutcomeSafeMock).toHaveBeenCalledWith(expect.anything(), failedBreakerKey, false);
    expect(metadata.breakerOutcomesRecorded).toBe(1);
    expect(metadata.breakerOutcomesSkippedClosedSuccess).toBe(uniqueBreakerKeys.size - 1);
  });

  it("records success breaker outcomes that still need state recovery", async () => {
    mockAdapterRegistry(
      async () => ({ slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] }),
    );

    const uniqueBreakerKeys = Array.from(new Set(
      ACTIVE_STABLECOINS
        .filter((c) => c.liveReservesConfig)
        .map((c) => `live-reserves:${c.liveReservesConfig!.breakerScope ?? c.liveReservesConfig!.adapter}`),
    ));
    const keysNeedingRecovery = new Set(uniqueBreakerKeys.slice(0, 4));
    const [halfOpenKey, failureDebtKey, missingSuccessKey, lingeringOpenedKey] = uniqueBreakerKeys;
    const closedBreakerRows = uniqueBreakerKeys.map((key) => {
      let record = {
        state: "closed",
        consecutiveFailures: 0,
        lastFailureAt: null as number | null,
        lastSuccessAt: 1_700_000_000 as number | null,
        openedAt: null as number | null,
      };
      if (key === halfOpenKey) {
        record = { ...record, state: "half-open", consecutiveFailures: 2, lastFailureAt: 1_699_999_990, openedAt: 1_699_999_990 };
      } else if (key === failureDebtKey) {
        record = { ...record, consecutiveFailures: 2, lastFailureAt: 1_699_999_990 };
      } else if (key === missingSuccessKey) {
        record = { ...record, lastSuccessAt: null };
      } else if (key === lingeringOpenedKey) {
        record = { ...record, openedAt: 1_699_999_990 };
      }
      return {
        key: `circuit:${key}`,
        value: JSON.stringify(record),
      };
    });

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1([
      {
        match: "SELECT key, value, updated_at FROM cache WHERE key IN",
        rows: closedBreakerRows.map((row) => ({ ...row, updated_at: 1_700_000_000 })),
      },
    ]);
    const result = await syncLiveReserves(db, new AbortController().signal, {});
    const metadata = JSON.parse(result?.metadata ?? "{}") as {
      breakerOutcomesRecorded?: number;
      breakerOutcomesSkippedClosedSuccess?: number;
    };

    expect(recordOutcomeSafeMock).toHaveBeenCalledTimes(keysNeedingRecovery.size);
    for (const key of keysNeedingRecovery) {
      expect(recordOutcomeSafeMock).toHaveBeenCalledWith(expect.anything(), key, true);
    }
    expect(metadata.breakerOutcomesRecorded).toBe(keysNeedingRecovery.size);
    expect(metadata.breakerOutcomesSkippedClosedSuccess).toBe(uniqueBreakerKeys.length - keysNeedingRecovery.size);
  });

  it("falls back to per-outcome breaker writes when the bulk breaker read fails", async () => {
    mockAdapterRegistry(
      async () => ({ slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] }),
    );

    const uniqueBreakerKeys = new Set(
      ACTIVE_STABLECOINS
        .filter((c) => c.liveReservesConfig)
        .map((c) => `live-reserves:${c.liveReservesConfig!.breakerScope ?? c.liveReservesConfig!.adapter}`),
    );

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1([
      {
        match: "SELECT key, value, updated_at FROM cache WHERE key IN",
        rows: [],
        throwError: new Error("bulk breaker read unavailable"),
      },
    ]);
    const result = await syncLiveReserves(db, new AbortController().signal, {});
    const metadata = JSON.parse(result?.metadata ?? "{}") as {
      breakerOutcomesRecorded?: number;
      breakerOutcomesSkippedClosedSuccess?: number;
    };

    expect(recordOutcomeSafeMock).toHaveBeenCalledTimes(uniqueBreakerKeys.size);
    expect(metadata.breakerOutcomesRecorded).toBe(uniqueBreakerKeys.size);
    expect(metadata.breakerOutcomesSkippedClosedSuccess).toBe(0);
    expect(db.getHistory().some((entry) => (
      entry.binds[0] === "cron:event:sync-live-reserves:live-reserve-breaker-bulk-read-failed"
    ))).toBe(true);
  });

  it("reports breaker outcome write failures without counting them as recorded", async () => {
    const firstQueuedCoin = SYNC_ORDERED_CONFIGURED_COINS[0]!;
    const failedBreakerKey = `live-reserves:${
      firstQueuedCoin.liveReservesConfig!.breakerScope ?? firstQueuedCoin.liveReservesConfig!.adapter
    }`;
    mockAdapterRegistry(async (coin) => {
      if (coin?.id === firstQueuedCoin.id) {
        throw new Error("HTTP 503 forced reserve source outage");
      }
      return { slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] };
    });
    recordOutcomeSafeMock.mockImplementation(async (_db, key) => (
      key === failedBreakerKey ? null : undefined
    ));

    const uniqueBreakerKeys = new Set(
      ACTIVE_STABLECOINS
        .filter((c) => c.liveReservesConfig)
        .map((c) => `live-reserves:${c.liveReservesConfig!.breakerScope ?? c.liveReservesConfig!.adapter}`),
    );

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();
    const result = await syncLiveReserves(db, new AbortController().signal, {});
    const metadata = JSON.parse(result?.metadata ?? "{}") as {
      breakerOutcomesRecorded?: number;
      breakerOutcomeWriteFailures?: number;
    };

    expect(recordOutcomeSafeMock).toHaveBeenCalledWith(expect.anything(), failedBreakerKey, false);
    expect(metadata.breakerOutcomesRecorded).toBe(uniqueBreakerKeys.size - 1);
    expect(metadata.breakerOutcomeWriteFailures).toBe(1);
  });

  it("skips breaker outcome writes when finalization tail budget is exhausted", async () => {
    let nowMs = 1_700_000_000_000;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    mockAdapterRegistry(async () => {
      return { slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] };
    });

    try {
      const { syncLiveReserves } = await import("../sync-live-reserves");
      const db = mockD1();
      const result = await syncLiveReserves(
        db,
        new AbortController().signal,
        {},
        async (update) => { if (update.stage === "finalizing") nowMs += 10_000; },
        {
          runBudgetMs: 5_000,
          adapterTimeoutMs: 1,
          d1FinalizeTimeoutMs: 1,
          finalizationMarginMs: 1,
        },
      );
      const metadata = JSON.parse(result?.metadata ?? "{}") as {
        breakerOutcomeBudgetExhausted?: boolean;
        breakerOutcomesRecorded?: number;
        breakerOutcomesSkippedBudget?: number;
        staleBreakerRecoveriesSkipped?: number;
      };

      expect(recordOutcomeSafeMock).not.toHaveBeenCalled();
      expect(metadata.breakerOutcomeBudgetExhausted).toBe(true);
      expect(metadata.breakerOutcomesRecorded).toBe(0);
      expect(metadata.breakerOutcomesSkippedBudget).toBeGreaterThan(0);
      expect(metadata.staleBreakerRecoveriesSkipped).toBe(1);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("cleans stale reserve artifacts by deleting only rows outside the active keep-list", async () => {
    mockAdapterRegistry(
      async () => ({ slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] }),
    );

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1([
      {
        match: "SELECT stablecoin_id FROM reserve_sync_state",
        rows: [
          { stablecoin_id: "stale-sync-state" },
          { stablecoin_id: ACTIVE_STABLECOINS.find((coin) => coin.liveReservesConfig)?.id },
        ],
      },
      {
        match: "SELECT stablecoin_id FROM reserve_composition",
        rows: [
          { stablecoin_id: "stale-composition" },
          { stablecoin_id: ACTIVE_STABLECOINS.find((coin) => coin.liveReservesConfig)?.id },
        ],
      },
      {
        match: "SELECT key FROM cache WHERE key LIKE 'circuit:live-reserves:%'",
        rows: [
          { key: "circuit:live-reserves:stale-breaker" },
          { key: "circuit:live-reserves:infinifi" },
        ],
      },
    ]);

    await syncLiveReserves(db, new AbortController().signal, {});

    const deleteStateRows = db.getHistory().filter((entry) => (
      entry.sql.includes("DELETE FROM reserve_sync_state WHERE stablecoin_id IN")
    ));
    expect(deleteStateRows).toHaveLength(1);
    expect(deleteStateRows[0]?.binds).toEqual(["stale-sync-state"]);

    const deleteCompositionRows = db.getHistory().filter((entry) => (
      entry.sql.includes("DELETE FROM reserve_composition WHERE stablecoin_id IN")
    ));
    expect(deleteCompositionRows).toHaveLength(1);
    expect(deleteCompositionRows[0]?.binds).toEqual(["stale-composition"]);

    const deleteCacheRows = db.getHistory().filter((entry) => (
      entry.sql.includes("DELETE FROM cache WHERE key IN")
    ));
    expect(deleteCacheRows).toHaveLength(1);
    expect(deleteCacheRows[0]?.binds).toEqual(["circuit:live-reserves:stale-breaker"]);

    // Per-row DELETE FROM reserve_sync_state WHERE stablecoin_id = ? must be gone.
    expect(
      db.getHistory().some((entry) => (
        entry.sql.includes("DELETE FROM reserve_sync_state WHERE stablecoin_id = ?")
      )),
    ).toBe(false);
  });

  it("keeps stale artifact cleanup best-effort and records warning metadata", async () => {
    mockAdapterRegistry(
      async () => ({ slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] }),
    );

    const actualStore = await vi.importActual<typeof import("../../lib/live-reserves/store")>("../../lib/live-reserves/store");
    replacedStore = true;
    vi.resetModules();
    vi.doMock("../../lib/live-reserves/store", async () => ({
      ...actualStore,
      cleanupStaleLiveReserveArtifacts: vi.fn(async () => {
        throw new Error("artifact cleanup unavailable");
      }),
    }));

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();
    const result = await syncLiveReserves(db, new AbortController().signal, {});
    const metadata = JSON.parse(result?.metadata ?? "{}") as {
      artifactCleanup?: unknown;
      artifactCleanupWarningCount?: number;
      artifactCleanupWarnings?: Array<{ eventType?: string; message?: string; error?: string }>;
    };

    expect(result?.status).toBe("ok");
    expect(metadata.artifactCleanup).toBeNull();
    expect(metadata.artifactCleanupWarningCount).toBe(1);
    expect(metadata.artifactCleanupWarnings).toEqual([
      {
        eventType: "live-reserve-artifact-cleanup-failed",
        message: "Ghost live-reserve artifact cleanup failed.",
        error: "artifact cleanup unavailable",
      },
    ]);
    const cleanupEvent = db.getHistory().find((entry) => (
      entry.sql.includes("INSERT INTO cache")
      && entry.binds[0] === "cron:event:sync-live-reserves:live-reserve-artifact-cleanup-failed"
    ));
    expect(cleanupEvent).toBeDefined();
  });

  it("recovers stale live-reserve circuit breakers with no configured candidates", async () => {
    const staleBreakerKey = "live-reserves:removed-adapter-key";
    const configuredBreakerKey = `live-reserves:${
      SYNC_ORDERED_CONFIGURED_COINS[0]!.liveReservesConfig!.breakerScope
      ?? SYNC_ORDERED_CONFIGURED_COINS[0]!.liveReservesConfig!.adapter
    }`;
    const staleState = JSON.stringify({
      state: "open",
      consecutiveFailures: 3,
      lastFailureAt: Math.floor(Date.now() / 1000) - 30,
      lastSuccessAt: null,
      openedAt: Math.floor(Date.now() / 1000) - 30,
    });
    const configuredState = JSON.stringify({
      state: "open",
      consecutiveFailures: 3,
      lastFailureAt: Math.floor(Date.now() / 1000) - 30,
      lastSuccessAt: null,
      openedAt: Math.floor(Date.now() / 1000) - 30,
    });
    mockAdapterRegistry(async () => ({ slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] }));

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1([
      {
        match: "key LIKE 'circuit:%'",
        rows: [
          { key: `circuit:${staleBreakerKey}`, value: staleState },
          { key: `circuit:${configuredBreakerKey}`, value: configuredState },
        ],
      },
    ]);

    await syncLiveReserves(db, new AbortController().signal, {});

    const staleRecoveryCalls = recoverNoCandidateMock.mock.calls.filter((call) => call[1] === staleBreakerKey);
    expect(staleRecoveryCalls).toHaveLength(1);
    const configuredRecoveryCalls = recoverNoCandidateMock.mock.calls.filter((call) => call[1] === configuredBreakerKey);
    expect(configuredRecoveryCalls).toHaveLength(0);
  });

  it("skips remaining stale breaker recoveries when the finalization tail budget runs out mid-loop", async () => {
    let nowMs = 1_700_000_000_000;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    mockAdapterRegistry(async () => ({ slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] }));
    const staleState = JSON.stringify({
      state: "open",
      consecutiveFailures: 3,
      lastFailureAt: Math.floor(nowMs / 1000) - 30,
      lastSuccessAt: null,
      openedAt: Math.floor(nowMs / 1000) - 30,
    });
    recoverNoCandidateMock.mockImplementationOnce(async () => {
      nowMs += 10_000;
    });

    try {
      const { syncLiveReserves } = await import("../sync-live-reserves");
      const db = mockD1([
        {
          match: "key LIKE 'circuit:%'",
          rows: [
            { key: "circuit:live-reserves:removed-a", value: staleState },
            { key: "circuit:live-reserves:removed-b", value: staleState },
          ],
        },
      ]);
      const result = await syncLiveReserves(
        db,
        new AbortController().signal,
        {},
        undefined,
        {
          runBudgetMs: 5_000,
          adapterTimeoutMs: 1,
          d1FinalizeTimeoutMs: 1,
          finalizationMarginMs: 1,
        },
      );
      const metadata = JSON.parse(result?.metadata ?? "{}") as {
        staleBreakerRecoveriesSkipped?: number;
        finalizationTailBudgetExhausted?: boolean;
      };

      expect(metadata.staleBreakerRecoveriesSkipped).toBe(1);
      expect(metadata.finalizationTailBudgetExhausted).toBe(true);
      expect(recoverNoCandidateMock.mock.calls.map((call) => call[1])).toEqual([
        "live-reserves:removed-a",
      ]);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("keeps finalization best-effort and records a warning when stale breaker recovery fails", async () => {
    const staleState = JSON.stringify({
      state: "open",
      consecutiveFailures: 3,
      lastFailureAt: Math.floor(Date.now() / 1000) - 30,
      lastSuccessAt: null,
      openedAt: Math.floor(Date.now() / 1000) - 30,
    });
    mockAdapterRegistry(async () => ({ slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] }));
    recoverNoCandidateMock.mockRejectedValueOnce(new Error("stale recovery unavailable"));

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1([
      {
        match: "key LIKE 'circuit:%'",
        rows: [{ key: "circuit:live-reserves:removed-adapter-key", value: staleState }],
      },
    ]);
    const result = await syncLiveReserves(db, new AbortController().signal, {});

    expect(result?.status).toBe("ok");
    expect(recoverNoCandidateMock).toHaveBeenCalledTimes(1);
    const recoveryFailureEvent = db.getHistory().find((entry) => (
      entry.sql.includes("INSERT INTO cache")
      && entry.binds[0] === "cron:event:sync-live-reserves:live-reserve-breaker-recovery-failed"
    ));
    expect(recoveryFailureEvent).toBeDefined();
    const event = JSON.parse(String(recoveryFailureEvent?.binds[1])) as {
      severity?: string;
      metadata?: { error?: string };
    };
    expect(event.severity).toBe("warning");
    expect(event.metadata?.error).toBe("stale recovery unavailable");
  });

  it("keeps finalization best-effort and records a warning when history pruning fails", async () => {
    mockAdapterRegistry(async () => ({ slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] }));

    const actualStore = await vi.importActual<typeof import("../../lib/live-reserves/store")>("../../lib/live-reserves/store");
    replacedStore = true;
    vi.resetModules();
    vi.doMock("../../lib/live-reserves/store", async () => ({
      ...actualStore,
      pruneLiveReserveHistory: vi.fn(async () => {
        throw new Error("history prune unavailable");
      }),
    }));

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();
    const result = await syncLiveReserves(db, new AbortController().signal, {});
    const metadata = JSON.parse(result?.metadata ?? "{}") as {
      historyPrune?: unknown;
      historyPruneSkipped?: boolean;
    };

    expect(result?.status).toBe("ok");
    expect(metadata.historyPrune).toBeUndefined();
    expect(metadata.historyPruneSkipped).toBe(false);
    const pruneFailureEvent = db.getHistory().find((entry) => (
      entry.sql.includes("INSERT INTO cache")
      && entry.binds[0] === "cron:event:sync-live-reserves:live-reserve-history-prune-failed"
    ));
    expect(pruneFailureEvent).toBeDefined();
    const event = JSON.parse(String(pruneFailureEvent?.binds[1])) as {
      severity?: string;
      metadata?: { error?: string };
    };
    expect(event.severity).toBe("warning");
    expect(event.metadata?.error).toBe("history prune unavailable");
  });

  it("classifies parser drift in sync attempt metadata", async () => {
    mockAdapterRegistry(async () => {
      throw new Error("circle-transparency: layout-changed: missing reserve attributes");
    });

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();
    await syncLiveReserves(db, new AbortController().signal, {});

    const attemptInsert = db.getHistory().find((entry) => entry.sql.includes("reserve_sync_attempt_history"));
    expect(attemptInsert).toBeDefined();
    const metadataJson = attemptInsert!.binds[9] as string;
    expect(JSON.parse(metadataJson)).toMatchObject({
      reason: "adapter-exception",
      failureCategory: "parser-drift",
    });
  });

  it("records timed out write finalization as a non-authoritative storage failure", async () => {
    vi.useFakeTimers();
    mockAdapterRegistry(
      async () => ({ slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] }),
    );

    const actualStore = await vi.importActual<typeof import("../../lib/live-reserves/store")>("../../lib/live-reserves/store");
    let finalizeCalls = 0;
    replacedStore = true;
    vi.resetModules();
    vi.doMock("../../lib/live-reserves/store", async () => ({
      ...actualStore,
      finalizeReserveSyncSuccess: vi.fn(async (...args: Parameters<typeof actualStore.finalizeReserveSyncSuccess>) => {
        finalizeCalls++;
        if (finalizeCalls === 1) {
          return await new Promise<Awaited<ReturnType<typeof actualStore.finalizeReserveSyncSuccess>>>(() => undefined);
        }
        return actualStore.finalizeReserveSyncSuccess(...args);
      }),
    }));

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();
    const runPromise = syncLiveReserves(db, new AbortController().signal, {});

    await vi.advanceTimersByTimeAsync(30_100);
    const result = await runPromise;

    expect(result?.itemCount).toBe(configuredCoinCount - 1);
    expect(result.status).toBe("degraded");
    expect(JSON.parse(result.metadata!)).toMatchObject({ persistenceFailed: 1, reason: "reserve-adapter-or-persistence-failed" });
    const timeoutAttempt = db.getHistory().find((entry) => (
      entry.sql.includes("reserve_sync_attempt_history")
      && entry.binds.some((bind) => typeof bind === "string" && bind.includes("storage-write-timeout"))
    ));
    expect(timeoutAttempt).toBeDefined();

    // Regression: a storage-write-timeout must produce exactly ONE attempt-history row
    // for the timed-out coin, not a second success-finalize-rejected row on top.
    const timedOutCoinId = timeoutAttempt!.binds[0];
    const attemptsForTimedOutCoin = db.getHistory().filter((entry) => (
      entry.sql.includes("reserve_sync_attempt_history")
      && entry.binds[0] === timedOutCoinId
    ));
    expect(attemptsForTimedOutCoin).toHaveLength(1);
    const duplicateFinalizeRejected = db.getHistory().find((entry) => (
      entry.sql.includes("reserve_sync_attempt_history")
      && entry.binds[0] === timedOutCoinId
      && entry.binds.some((bind) => typeof bind === "string" && bind.includes("success-finalize-rejected"))
    ));
    expect(duplicateFinalizeRejected).toBeUndefined();
  });

  it("accepts a timed out write finalization when authoritative readback proves success", async () => {
    vi.useFakeTimers();
    mockAdapterRegistry(
      async () => ({ slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] }),
    );

    const actualStore = await vi.importActual<typeof import("../../lib/live-reserves/store")>("../../lib/live-reserves/store");
    replacedStore = true;
    vi.resetModules();
    vi.doMock("../../lib/live-reserves/store", async () => ({
      ...actualStore,
      finalizeReserveSyncSuccess: vi.fn(async () => (
        await new Promise<Awaited<ReturnType<typeof actualStore.finalizeReserveSyncSuccess>>>(() => undefined)
      )),
      didReserveSyncSuccessBecomeAuthoritative: vi.fn(async () => true),
    }));

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();
    const runPromise = syncLiveReserves(
      db,
      new AbortController().signal,
      {},
      undefined,
      {
        runBudgetMs: 12,
        adapterTimeoutMs: 1,
        d1FinalizeTimeoutMs: 10,
        finalizationMarginMs: 1,
      },
    );

    await vi.advanceTimersByTimeAsync(11);
    const result = await runPromise;
    const metadata = JSON.parse(result?.metadata ?? "{}") as {
      synced?: number;
      failed?: number;
      warningCount?: number;
      warnings?: string[];
    };

    // The tiny budget admits exactly one coin: the head of the ordered queue.
    expect(result?.itemCount).toBe(1);
    // warningCount is deliberately not pinned: the head-of-queue coin's
    // adapter policy can add informational warnings (e.g. freshness) that are
    // orthogonal to the timed-out-write semantics under test.
    expect(metadata).toMatchObject({
      synced: 1,
      failed: 0,
    });
    const storageTimeoutAttempt = db.getHistory().find((entry) => (
      entry.sql.includes("reserve_sync_attempt_history")
      && entry.binds.some((bind) => typeof bind === "string" && bind.includes("storage-write-timeout"))
    ));
    expect(storageTimeoutAttempt).toBeUndefined();
  });

  it("hard-times out a non-cooperative adapter attempt", async () => {
    vi.useFakeTimers();
    const adapterFetch = mockAdapterRegistry(
      async () => await new Promise<never>(() => undefined),
    );

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();
    const runPromise = syncLiveReserves(
      db,
      new AbortController().signal,
      {},
      undefined,
      {
        runBudgetMs: 20,
        adapterTimeoutMs: 10,
        d1FinalizeTimeoutMs: 1,
        finalizationMarginMs: 1,
      },
    );

    await vi.advanceTimersByTimeAsync(11);
    const result = await runPromise;
    const metadata = JSON.parse(result?.metadata ?? "{}") as {
      failed?: number;
      deferredCoins?: number;
      runBudgetTruncated?: boolean;
    };

    expect(adapterFetch).toHaveBeenCalledTimes(1);
    expect(result?.status).toBe("error");
    expect(metadata).toMatchObject({
      failed: 1,
      deferredCoins: configuredCoinCount - 1,
      runBudgetTruncated: true,
      reason: "reserve-adapter-or-persistence-failed",
      reasons: ["reserve-adapter-or-persistence-failed", "reserve-run-budget-deferred"],
    });
    const timeoutAttempt = db.getHistory().find((entry) => (
      entry.sql.includes("reserve_sync_attempt_history")
      && entry.binds.some((bind) => typeof bind === "string" && bind.includes("adapter-timeout"))
    ));
    expect(timeoutAttempt).toBeDefined();
  });

  it("bounds non-cooperative fallback chains without treating the local deadline as source failure", async () => {
    vi.useFakeTimers();
    const target = SYNC_ORDERED_CONFIGURED_COINS.find((coin) =>
      (coin.liveReservesConfig?.inputs.fallbacks?.length ?? 0) >= 2
      && coin.liveReservesConfig?.adapter !== "hive-hbd-protocol");
    if (!target) throw new Error("Expected multi-fallback source");
    const adapterFetch = mockAdapterRegistry(async (coin) => {
      if (coin?.id === target.id) return await new Promise<never>(() => undefined);
      return { slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] };
    });
    const identity = makeCheckpointIdentity(2, "deadline-owner");
    const db = mockD1([makeCheckpointTable({
      attemptNo: identity.attemptNo, invocationId: identity.invocationId,
      nextItemKey: target.id, itemsDone: SYNC_ORDERED_CONFIGURED_COINS.findIndex((coin) => coin.id === target.id),
    }), { match: "UPDATE worker_scheduled_checkpoints", rows: [] }]);
    const { syncLiveReserves } = await import("../sync-live-reserves");
    const pending = syncLiveReserves(db, new AbortController().signal, {}, undefined, {
      runBudgetMs: 60_000, adapterTimeoutMs: 20_000, d1FinalizeTimeoutMs: 30_000, finalizationMarginMs: 5_000,
    }, identity);
    await vi.advanceTimersByTimeAsync(25_001);
    const result = await pending;
    expect(adapterFetch.mock.calls.filter(([coin]) => coin.id === target.id)).toHaveLength(2);
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({ failed: 1, runBudgetTruncated: false, continuationPending: true });
    const key = `live-reserves:${target.liveReservesConfig!.breakerScope ?? target.liveReservesConfig!.adapter}`;
    expect(recordOutcomeSafeMock).not.toHaveBeenCalledWith(expect.anything(), key, false);
    expect(db.getHistory().some((entry) =>
      entry.sql.includes("reserve_sync_attempt_history")
      && entry.binds[0] === target.id
      && entry.binds.some((value) => typeof value === "string" && value.includes('"failureCategory":"run-budget-exhausted"')),
    )).toBe(true);
  });

  it("records string abort reasons and the adapter fallback for non-error reasons", async () => {
    const { syncLiveReserves } = await import("../sync-live-reserves");
    for (const { reason, expectedAttemptError, expectedRunError } of [
      { reason: "operator cancelled", expectedAttemptError: "operator cancelled", expectedRunError: "operator cancelled" },
      { reason: 42, expectedAttemptError: "adapter-timeout", expectedRunError: "Operation aborted" },
    ]) {
      const controller = new AbortController();
      mockAdapterRegistry(async () => {
        controller.abort(reason);
        return await new Promise<never>(() => undefined);
      });
      const db = mockD1();

      await expect(syncLiveReserves(db, controller.signal, {})).rejects.toThrow(expectedRunError);
      const failedAttempt = db.getHistory().find((entry) => (
        entry.sql.includes("reserve_sync_attempt_history")
        && entry.binds.some((bind) => typeof bind === "string" && bind.includes(expectedAttemptError))
      ));
      expect(failedAttempt).toBeDefined();
    }
  });

  it("reports per-coin progress through the cron progress hook", async () => {
    mockAdapterRegistry(
      async () => ({ slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] }),
    );

    const reportProgress = vi.fn(async (_update: unknown) => undefined);
    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();
    await syncLiveReserves(db, new AbortController().signal, {}, reportProgress as never);

    expect(reportProgress).toHaveBeenCalled();
    const progressCalls = reportProgress.mock.calls as Array<[{
      stage?: string | null;
      itemsDone?: number | null;
      itemsTotal?: number | null;
      message?: string | null;
      metadata?: Record<string, unknown> | null;
    }]>;

    expect(progressCalls[0]?.[0]).toMatchObject({
      stage: "setup",
      itemsDone: 0,
      itemsTotal: configuredCoinCount,
      message: "Loaded live reserve sync state",
    });
    expect(progressCalls.some(([update]) => (
      update.stage === "syncing"
      && typeof update.metadata?.currentCoinId === "string"
      && typeof update.metadata?.currentAdapter === "string"
      && typeof update.metadata?.currentBreakerKey === "string"
    ))).toBe(true);
    const syncingCalls = progressCalls.filter(([update]) => update.stage === "syncing");
    expect(syncingCalls.length).toBeLessThanOrEqual(Math.ceil(configuredCoinCount / 10));
    expect(progressCalls.length).toBeLessThanOrEqual(Math.ceil(configuredCoinCount / 10) + 2);
    const finalUpdate = progressCalls[progressCalls.length - 1]?.[0];
    expect(finalUpdate).toMatchObject({
      stage: "finalizing",
      itemsDone: configuredCoinCount,
      itemsTotal: configuredCoinCount,
    });
  });

  it("defers the full queue safely when configured run budget is below adapter timeout", async () => {
    const adapterFetch = mockAdapterRegistry(async () => ({
      slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }],
    }));

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();
    const result = await syncLiveReserves(
      db,
      new AbortController().signal,
      {},
      undefined,
      { runBudgetMs: 1, adapterTimeoutMs: 20_000 },
    );
    const metadata = JSON.parse(result?.metadata ?? "{}") as {
      synced?: number;
      skipped?: number;
      deferredCoins?: number;
      runBudgetTruncated?: boolean;
    };

    expect(adapterFetch).not.toHaveBeenCalled();
    expect(result?.status).toBe("error");
    expect(metadata).toMatchObject({
      synced: 0,
      skipped: configuredCoinCount,
      deferredCoins: configuredCoinCount,
      runBudgetTruncated: true,
      reason: "reserve-run-budget-deferred",
      reasons: ["reserve-run-budget-deferred"],
    });
  });

  it("keeps Yuzu's failed attempt and retained snapshot unchanged when acknowledging the cron finding", async () => {
    let now = Math.floor(Date.now() / 1000);
    const reviews = await import("../../lib/reserve-feed-reviews");
    const review = { ...RESERVE_FEED_REVIEWS.find((item) => item.stablecoinId === "yzusd-yuzu")!, reviewedAt: now - 1, expiresAt: now + 86400 };
    vi.spyOn(reviews, "resolveReserveFeedReviews").mockReturnValue({ activeById: new Map([[review.stablecoinId, review]]), expiredIds: [], invalidIds: [] });
    vi.spyOn(Date, "now").mockImplementation(() => now * 1000);
    let fail = false;
    mockAdapterRegistry(async (coin) => {
      if (fail && coin?.id === review.stablecoinId) throw new Error(review.errorPrefix!.replace("primary:http-json: ", ""));
      return { slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] };
    });
    const { db, sqlite } = fixtures.open();
    const { syncLiveReserves } = await import("../sync-live-reserves");
    await syncLiveReserves(db, new AbortController().signal, {});
    const snapshot = sqlite.prepare("SELECT * FROM reserve_composition WHERE stablecoin_id = ?").get(review.stablecoinId);
    expect(snapshot).toBeDefined();
    const originalSuccess = sqlite.prepare("SELECT last_success_at, last_success_attempt_id FROM reserve_sync_state WHERE stablecoin_id = ?").get(review.stablecoinId);
    now += 60;
    fail = true;
    const result = await syncLiveReserves(db, new AbortController().signal, {});
    expect(result.status).toBe("ok");
    expect(JSON.parse(result.metadata!)).toMatchObject({
      failed: 1, unacknowledgedFailed: 0,
      quality: { reason: "reserve-feed-failure-reviewed", acknowledgedFeedIds: [review.stablecoinId] },
    });
    const state = sqlite.prepare("SELECT * FROM reserve_sync_state WHERE stablecoin_id = ?").get(review.stablecoinId)!;
    expect(state).toMatchObject({ ...originalSuccess, last_status: "error", last_error: review.errorPrefix, last_attempted_at: now });
    expect(JSON.parse(String(state.metadata)).failureCategory).toBe(review.failureCategory);
    expect(sqlite.prepare("SELECT * FROM reserve_composition WHERE stablecoin_id = ?").get(review.stablecoinId)).toEqual(snapshot);
  });

  it.each([0, 1])("exposes only a confirmed persisted failure for review (changed rows: %s)", async (changes) => {
    const coin = SYNC_ORDERED_CONFIGURED_COINS.find((item) => item.id === "yzusd-yuzu")!;
    const config = coin.liveReservesConfig!;
    const db = mockD1([{ match: "UPDATE reserve_sync_state", rows: [], runMeta: { changes } }]);
    const result = await syncReserveCoin({
      db, coin, signal: new AbortController().signal,
      adapter: { ...LIVE_RESERVE_ADAPTER_DEFINITIONS[config.adapter], fetch: vi.fn() },
      runAdapter: async () => { throw new Error("issuer failure"); },
      breakerCanFetch: new Map([[breakerKeyForConfig(config), true]]), previousState: null,
      d1FinalizeTimeoutMs: 1_000,
    });
    expect(result.status).toBe("failed");
    if (changes) expect(result.persistedFailure).toMatchObject({ stablecoinId: coin.id, lastStatus: "error", lastError: "issuer failure" });
    else expect(result.persistedFailure).toBeUndefined();
  });

  it.each([
    { name: "reviewed failure only", remaining: 0, expected: "ok" },
    { name: "mixed reviewed and unexplained failures", remaining: 1, expected: "degraded" },
    { name: "reviewed feed excluded from an at-budget cohort", synced: 6, remaining: 2, expected: "ok" },
    { name: "reviewed feed cannot dilute an over-budget cohort", synced: 5, remaining: 2, expected: "degraded" },
    { name: "expired review", expired: true, expected: "degraded" },
    { name: "changed cause", changed: true, expected: "degraded" },
    { name: "timeout", timeout: true, expected: "degraded" },
    { name: "uncertain persistence", uncertain: true, expected: "degraded" },
    { name: "unconfirmed persistence", unconfirmed: true, expected: "degraded" },
    { name: "all failed but reviewed", synced: 0, expected: "ok" },
    { name: "reviewed circuit skip", circuit: true, expected: "ok" },
    { name: "unreadable circuit history", circuit: true, unreadable: true, expected: "degraded" },
    { name: "budget exhausted before matching", budget: true, expected: "degraded" },
  ])("keeps raw attempts while accounting for $name", async (scenario) => {
    const review = RESERVE_FEED_REVIEWS.find((item) => item.stablecoinId === "yzusd-yuzu")!;
    const now = scenario.expired ? review.expiresAt : review.reviewedAt + 1;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const failure: ReserveSyncStateRecord = {
      stablecoinId: review.stablecoinId, adapterKey: review.adapterKey, breakerKey: "live-reserves:yzusd-yuzu",
      lastStatus: scenario.circuit ? "skipped" : "error", lastAttemptedAt: now, lastSuccessAt: now - 86400,
      lastAttemptId: "current-attempt", lastSuccessAttemptId: "retained-success", warningCount: 0, warnings: [],
      lastError: scenario.circuit ? null : `${review.errorPrefix}${scenario.changed ? ": new cause" : ""}`,
      metadata: {
        failureCategory: scenario.timeout ? "network" : scenario.circuit ? "circuit-open" : review.failureCategory,
        ...(scenario.uncertain ? { uncertainWrite: true } : {}),
      },
    };
    const original = structuredClone(failure);
    const collector = createAdapterLatencyCollector();
    const synced = scenario.synced ?? 1;
    const failed = scenario.circuit ? 0 : 1 + (scenario.remaining ?? 0);
    const circuitSkipped = scenario.circuit ? 1 : 0;
    const db = mockD1([{ match: "status != 'skipped'", rows: [], first: {
      stablecoin_id: review.stablecoinId, attempted_at: now - 1, adapter_key: review.adapterKey,
      breaker_key: failure.breakerKey, status: "error", warnings: "[]", last_error: review.errorPrefix,
      metadata: JSON.stringify({ failureCategory: review.failureCategory }),
    }, ...(scenario.unreadable ? { throwError: new Error("history unreadable") } : {}) }]);
    const result = await finalizeReserveSyncRun({
      db, total: synced + failed + circuitSkipped, runStartedAt: now,
      runStartedMs: (scenario.budget ? now - 3600 : now) * 1000,
      counts: { synced, failed, persistenceFailed: scenario.uncertain || scenario.unconfirmed ? 1 : 0,
        skipped: circuitSkipped, circuitSkipped, deferredCoins: 0, deferredSkipped: 0,
        attemptedCoins: synced + failed + circuitSkipped, ...(synced ? { latestPublishedAt: now - 2 } : {}) },
      persistedFailures: scenario.unconfirmed ? [] : [failure],
      warningMessages: [], coinsWithErrors: failed ? [review.stablecoinId] : [], coinsWithWarnings: [],
      breaker: { breakerKeys: new Set(), breakerOutcomes: new Map() },
      deferredTail: { nextCursorStablecoinId: null, cursorTailState: null, cursorRecordedAt: null,
        cursorTailCompletedAt: null, cursorTailFailedAt: null, cursorTailError: null, runBudgetTruncationCount: 0 },
      checkpointOwned: false, attemptFailureSummaries: [], budgetConfig: resolveLiveReserveSyncBudgetConfig(),
      phaseTimings: { setup: 0, queue: 0, adapter: 0, d1CoinPersistence: 0 },
      adapterLatency: collector.finalize(), adapterTelemetryProgress: collector.progress(),
    });
    expect(result.status).toBe(scenario.expected);
    expect(failure).toEqual(original);
    const metadata = JSON.parse(result.metadata!);
    const acknowledged = scenario.expected === "ok" || (scenario.remaining ?? 0) > 0;
    expect(metadata).toMatchObject({
      failed, skipped: circuitSkipped, synced,
      unacknowledgedFailed: failed - (acknowledged && !scenario.circuit ? 1 : 0),
      unacknowledgedCircuitSkipped: circuitSkipped - (acknowledged && scenario.circuit ? 1 : 0),
    });
    expect(metadata.adapterFailureBudget.attemptedFeeds).toBe(synced + failed - Number(acknowledged && !scenario.circuit));
    if (acknowledged) {
      expect(metadata.quality).toMatchObject({ reason: "reserve-feed-failure-reviewed", acknowledgedFeedIds: [review.stablecoinId] });
      expect(metadata.quality.acknowledgedFeeds).toEqual([review]);
    } else expect(metadata.quality).toBeUndefined();
    expect(metadata.reason).toBe(scenario.expected === "ok" ? undefined
      : scenario.circuit ? "reserve-circuit-open" : "reserve-adapter-or-persistence-failed");
    expect(result.productivity).toEqual({ productive: synced > 0 });
    expect(metadata.outputPublishedAt).toBe(synced ? now - 2 : undefined);
  });

  it.each([
    {
      name: "simultaneous failure, budget deferral and circuit skip",
      counts: { synced: 60, failed: 10, skipped: 30, deferredCoins: 25, deferredSkipped: 25, circuitSkipped: 5 },
      status: "degraded", reason: "reserve-circuit-open",
      reasons: ["reserve-adapter-or-persistence-failed", "reserve-run-budget-deferred", "reserve-circuit-open"],
    },
    {
      name: "budget deferral only",
      counts: { synced: 75, failed: 0, skipped: 25, deferredCoins: 25, deferredSkipped: 25, circuitSkipped: 0 },
      status: "degraded", reason: "reserve-run-budget-deferred", reasons: ["reserve-run-budget-deferred"],
    },
    {
      name: "circuit skip only",
      counts: { synced: 0, failed: 0, skipped: 100, deferredCoins: 0, deferredSkipped: 0, circuitSkipped: 100 },
      status: "degraded", reason: "reserve-circuit-open", reasons: ["reserve-circuit-open"],
    },
    {
      name: "clean",
      counts: { synced: 100, failed: 0, skipped: 0, deferredCoins: 0, deferredSkipped: 0, circuitSkipped: 0 },
      status: "ok", reason: undefined, reasons: [],
    },
    {
      name: "one failed member of a hundred",
      counts: { synced: 99, failed: 1, skipped: 0, deferredCoins: 0, deferredSkipped: 0, circuitSkipped: 0 },
      status: "ok", reason: undefined, reasons: ["reserve-adapter-or-persistence-failed"],
    },
    {
      name: "one failed member of two",
      counts: { synced: 1, failed: 1, skipped: 0, deferredCoins: 0, deferredSkipped: 0, circuitSkipped: 0 },
      status: "degraded", reason: "reserve-adapter-or-persistence-failed", reasons: ["reserve-adapter-or-persistence-failed"],
    },
    {
      name: "two failed members of twenty",
      counts: { synced: 18, failed: 2, skipped: 0, deferredCoins: 0, deferredSkipped: 0, circuitSkipped: 0 },
      status: "ok", reason: undefined, reasons: ["reserve-adapter-or-persistence-failed"],
    },
    {
      name: "at the failure budget",
      counts: { synced: 75, failed: 25, skipped: 0, deferredCoins: 0, deferredSkipped: 0, circuitSkipped: 0 },
      status: "ok", reason: undefined, reasons: ["reserve-adapter-or-persistence-failed"],
    },
    {
      name: "above the failure budget",
      counts: { synced: 74, failed: 26, skipped: 0, deferredCoins: 0, deferredSkipped: 0, circuitSkipped: 0 },
      status: "degraded", reason: "reserve-adapter-or-persistence-failed", reasons: ["reserve-adapter-or-persistence-failed"],
    },
    {
      name: "one persistence failure of a hundred",
      persistenceFailed: 1,
      counts: { synced: 99, failed: 1, skipped: 0, deferredCoins: 0, deferredSkipped: 0, circuitSkipped: 0 },
      status: "degraded", reason: "reserve-adapter-or-persistence-failed", reasons: ["reserve-adapter-or-persistence-failed"],
    },
    {
      name: "one circuit-held member of a hundred",
      counts: { synced: 99, failed: 0, skipped: 1, deferredCoins: 0, deferredSkipped: 0, circuitSkipped: 1 },
      status: "degraded", reason: "reserve-circuit-open", reasons: ["reserve-circuit-open"],
    },
    {
      name: "circuit holds cannot dilute an over-budget fetched cohort",
      counts: { synced: 2, failed: 1, skipped: 97, deferredCoins: 0, deferredSkipped: 0, circuitSkipped: 97 },
      status: "degraded", reason: "reserve-adapter-or-persistence-failed",
      reasons: ["reserve-adapter-or-persistence-failed", "reserve-circuit-open"],
    },
    {
      name: "exact fresh-coverage equality after circuit exclusion",
      counts: { synced: 3, failed: 1, skipped: 96, deferredCoins: 0, deferredSkipped: 0, circuitSkipped: 96 },
      status: "degraded", reason: "reserve-circuit-open",
      reasons: ["reserve-adapter-or-persistence-failed", "reserve-circuit-open"],
    },
    {
      name: "deferred skip without a recorded deferred-coin count",
      counts: { synced: 99, failed: 0, skipped: 1, deferredCoins: 0, deferredSkipped: 1, circuitSkipped: 0 },
      status: "ok", reason: undefined, reasons: ["reserve-run-budget-deferred"],
    },
  ])("retains all applicable reasons with budget-aware terminal priority: $name", async ({ counts, status, reason, reasons, persistenceFailed = 0 }) => {
    const collector = createAdapterLatencyCollector();
    const nowMs = Date.now();
    const result = await finalizeReserveSyncRun({
      db: mockD1(), total: 100, runStartedAt: Math.floor(nowMs / 1000), runStartedMs: nowMs,
      counts: { ...counts, persistenceFailed, attemptedCoins: counts.synced + counts.failed + counts.circuitSkipped,
        ...(counts.synced > 0 ? { latestPublishedAt: 1_000 } : {}) },
      warningMessages: [], coinsWithErrors: [], coinsWithWarnings: [],
      breaker: { breakerKeys: new Set(), breakerOutcomes: new Map() },
      deferredTail: {
        nextCursorStablecoinId: null, cursorTailState: null, cursorRecordedAt: null,
        cursorTailCompletedAt: null, cursorTailFailedAt: null, cursorTailError: null, runBudgetTruncationCount: 0,
      },
      checkpointOwned: false, attemptFailureSummaries: [],
      budgetConfig: resolveLiveReserveSyncBudgetConfig(),
      phaseTimings: { setup: 0, queue: 0, adapter: 0, d1CoinPersistence: 0 },
      adapterLatency: collector.finalize(), adapterTelemetryProgress: collector.progress(),
    });
    const metadata = JSON.parse(result.metadata ?? "{}");
    expect(result.status).toBe(status);
    expect(result.itemCount).toBe(counts.synced);
    expect(result.productivity).toEqual({ productive: counts.synced > 0 });
    expect(metadata.reason).toBe(reason);
    expect(metadata.reasons).toEqual(reasons);
    expect(metadata.failed).toBe(counts.failed);
    expect(metadata.unacknowledgedFailed).toBe(counts.failed);
    expect(metadata.persistenceFailed).toBe(persistenceFailed);
    expect(metadata.adapterFailureBudget).toEqual({
      maxFailureRatio: 0.25,
      attemptedFeeds: counts.synced + counts.failed,
      failedFeeds: counts.failed - persistenceFailed,
    });
    if (counts.failed > 0 && persistenceFailed === 0 && counts.failed <= (counts.synced + counts.failed) * 0.25) {
      expect(metadata.quality.reasons).toEqual(["reserve-adapter-or-persistence-failed"]);
    }
    expect(metadata.reasons.length).toBeLessThanOrEqual(3);
    expect(new Set(metadata.reasons).size).toBe(metadata.reasons.length);
    expect(metadata.outputPublishedAt).toBe(counts.synced > 0 ? 1_000 : undefined);
    expect(metadata.runBudgetTruncated).toBe(counts.deferredCoins > 0);
  });

  it.each([
    { name: "one failed feed in a two-feed tail", priorSynced: 328, priorFailed: 0, synced: 1, failed: 1, status: "ok" },
    { name: "an all-failed three-feed tail after a clean head", priorSynced: 327, priorFailed: 0, synced: 0, failed: 3, status: "ok" },
    { name: "an over-budget head followed by a clean tail", priorSynced: 90, priorFailed: 60, synced: 60, failed: 0, status: "degraded" },
    { name: "an exact-equality cohort", priorSynced: 6, priorFailed: 2, synced: 3, failed: 1, status: "ok" },
    { name: "a prior storage failure", priorSynced: 149, priorFailed: 1, priorPersistence: 1, synced: 2, failed: 0, status: "degraded" },
    { name: "missing prefix evidence", priorSynced: 150, priorFailed: 0, missing: true, synced: 2, failed: 0, status: "degraded" },
    { name: "a mismatched prefix frontier", priorSynced: 150, priorFailed: 0, mismatch: true, synced: 2, failed: 0, status: "degraded" },
  ])("grades the cumulative cohort for $name", async (scenario) => {
    const collector = createAdapterLatencyCollector();
    const nowMs = Date.now();
    const prefix = scenario.priorSynced + scenario.priorFailed;
    const complete = !scenario.missing && !scenario.mismatch;
    const result = await finalizeReserveSyncRun({
      db: mockD1(), total: scenario.synced + scenario.failed, runStartedAt: Math.floor(nowMs / 1000), runStartedMs: nowMs,
      counts: { synced: scenario.synced, failed: scenario.failed, persistenceFailed: 0,
        skipped: 0, circuitSkipped: 0, deferredCoins: 0, deferredSkipped: 0,
        attemptedCoins: scenario.synced + scenario.failed },
      cohortItemsDoneBeforeRun: prefix,
      cohortGradingBeforeRun: scenario.missing ? undefined : {
        itemsDone: prefix - Number(scenario.mismatch === true), complete: true,
        synced: scenario.priorSynced, failed: scenario.priorFailed, persistenceFailed: scenario.priorPersistence ?? 0,
        circuitSkipped: 0, attemptedCoins: prefix,
      },
      warningMessages: [], coinsWithErrors: [], coinsWithWarnings: [],
      breaker: { breakerKeys: new Set(), breakerOutcomes: new Map() },
      deferredTail: { nextCursorStablecoinId: null, cursorTailState: null, cursorRecordedAt: null,
        cursorTailCompletedAt: null, cursorTailFailedAt: null, cursorTailError: null, runBudgetTruncationCount: 0 },
      checkpointOwned: true, attemptFailureSummaries: [], budgetConfig: resolveLiveReserveSyncBudgetConfig(),
      phaseTimings: { setup: 0, queue: 0, adapter: 0, d1CoinPersistence: 0 },
      adapterLatency: collector.finalize(), adapterTelemetryProgress: collector.progress(),
    });
    expect(result.status).toBe(scenario.status);
    const metadata = JSON.parse(result.metadata!);
    expect(metadata.failed).toBe(scenario.failed);
    expect(metadata.synced).toBe(scenario.synced);
    expect(metadata.unacknowledgedFailed).toBe(scenario.failed);
    expect(metadata.adapterFailureBudget).toEqual({
      maxFailureRatio: 0.25,
      attemptedFeeds: complete ? prefix + scenario.synced + scenario.failed : null,
      failedFeeds: complete ? scenario.priorFailed + scenario.failed - (scenario.priorPersistence ?? 0) : null,
    });
    if (complete) expect(metadata.cohortGrading).toMatchObject({
      failed: scenario.priorFailed + scenario.failed, itemsDone: prefix + scenario.synced + scenario.failed,
    });
    else expect(metadata).toMatchObject({ cohortGrading: null, cohortGradingUnavailableReason: "checkpoint-grading-frontier-unavailable" });
  });

  it("finalizes breaker outcomes when deferred-tail persistence fails", async () => {
    const startedMs = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(startedMs);
    mockAdapterRegistry(async () => {
      clock.mockReturnValue(startedMs + 800);
      return { slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }] };
    });

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();
    const batch = db.batch.bind(db);
    vi.spyOn(db, "batch").mockImplementation(async (statements) => {
      const isDeferredTail = statements.some((statement) => {
        const prepared = statement as unknown as { sql?: string; boundValues?: unknown[] };
        return prepared.sql?.includes("INSERT INTO reserve_sync_state")
          && prepared.boundValues?.includes("run-budget-exhausted");
      });
      if (isDeferredTail) throw new Error("forced deferred-tail batch failure");
      return batch(statements);
    });

    const result = await syncLiveReserves(
      db,
      new AbortController().signal,
      {},
      undefined,
      {
        runBudgetMs: 1_000,
        adapterTimeoutMs: 100,
        d1FinalizeTimeoutMs: 100,
        finalizationMarginMs: 100,
      },
    );
    const metadata = JSON.parse(result?.metadata ?? "{}") as {
      cursorTailState?: string;
      cursorTailError?: string;
      breakerOutcomesRecorded?: number;
    };

    expect(metadata).toMatchObject({
      cursorTailState: "incomplete",
      cursorTailError: "Failed to record deferred reserve tail state: forced deferred-tail batch failure",
    });
    expect(metadata.breakerOutcomesRecorded).toBeGreaterThan(0);
    expect(recordOutcomeSafeMock).toHaveBeenCalled();
  });

  it("defers when remaining budget covers the adapter timeout but not finalize margin", async () => {
    const adapterFetch = mockAdapterRegistry(async () => ({
      slices: [{ name: "Mock Farm", pct: 100, risk: "low" as const }],
    }));

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();
    const result = await syncLiveReserves(
      db,
      new AbortController().signal,
      {},
      undefined,
      {
        runBudgetMs: 1_699,
        adapterTimeoutMs: 1_000,
        d1FinalizeTimeoutMs: 500,
        finalizationMarginMs: 200,
      },
    );
    const metadata = JSON.parse(result?.metadata ?? "{}") as {
      synced?: number;
      skipped?: number;
      deferredCoins?: number;
      runBudgetTruncated?: boolean;
      finalizationMarginMs?: number;
    };

    expect(adapterFetch).not.toHaveBeenCalled();
    expect(metadata).toMatchObject({
      synced: 0,
      skipped: configuredCoinCount,
      deferredCoins: configuredCoinCount,
      runBudgetTruncated: true,
      finalizationMarginMs: 200,
    });
  });

  it("does not repurpose Hive's corroborating node as a substitute primary", async () => {
    const adapterFetch = mockAdapterRegistry(async (coin) => {
      if (coin?.id === "hbd-hive") throw new Error("material reads crossed a changing Hive head");
      return { slices: [{ name: "Tracked vaults", pct: 100, risk: "low" as const }] };
    });
    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();
    await syncLiveReserves(db, new AbortController().signal, {});

    const hiveCalls = adapterFetch.mock.calls.filter(([coin]) => coin.id === "hbd-hive");
    expect(hiveCalls).toHaveLength(1);
    expect(hiveCalls[0]![1].inputs).toMatchObject({
      primary: { url: "https://api.hive.blog" },
      fallbacks: [{ url: "https://api.openhive.network" }],
    });
    expect(db.getHistory().some((entry) => (
      entry.sql.includes("INSERT INTO reserve_composition") && entry.binds[0] === "hbd-hive"
    ))).toBe(false);
  });

  it("emits a primary-fallback-used info warning when the fallback succeeds", async () => {
    const fallbackCoin = ACTIVE_STABLECOINS.find((coin) => (
      (coin.liveReservesConfig?.inputs.fallbacks?.length ?? 0) > 0
      && coin.liveReservesConfig?.inputs.primary.kind === "http-json"
      && coin.liveReservesConfig.inputs.primary.url.includes("chain=tron")
    ));
    expect(fallbackCoin).toBeDefined();

    mockAdapterRegistry(async (_coin, config) => {
      const currentInput = config?.inputs.primary;
      if (!currentInput || (currentInput.kind !== "http-json" && currentInput.kind !== "http-html")) {
        throw new Error("unexpected input kind");
      }
      if (currentInput.url.includes("chain=tron")) {
        throw new Error("primary source down");
      }
      return { slices: [{ name: "Tracked vaults", pct: 100, risk: "low" as const }] };
    });

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();
    const result = await syncLiveReserves(db, new AbortController().signal, {});

    const successAttempt = db.getHistory().find((entry) => (
      entry.sql.includes("reserve_sync_attempt_history")
      && entry.binds[0] === fallbackCoin!.id
    ));
    expect(successAttempt).toBeDefined();

    const warningsJson = successAttempt!.binds[6] as string | null;
    expect(typeof warningsJson).toBe("string");
    const parsed = JSON.parse(warningsJson!) as Array<{ code?: string; effect?: string; severity?: string }>;
    const fallbackInfo = parsed.find((w) => w.code === "primary-fallback-used");
    expect(fallbackInfo).toBeDefined();
    expect(fallbackInfo!.effect).toBe("info");
    expect(fallbackInfo!.severity).toBe("info");
    const runMetadata = JSON.parse(result.metadata ?? "{}") as {
      adapterLatency?: {
        groups?: Array<{ adapterKey?: string; stage?: string; attemptCount?: number }>;
        total?: { attemptCount?: number };
        overflow?: boolean;
      };
    };
    const fallbackGroup = runMetadata.adapterLatency?.groups?.find((group) => (
      group.adapterKey === fallbackCoin!.liveReservesConfig!.adapter
      && group.stage === "fallback"
    ));
    expect(
      fallbackGroup?.attemptCount === 1
      || (
        runMetadata.adapterLatency?.overflow === true
        && (runMetadata.adapterLatency.total?.attemptCount ?? 0) > configuredCoinCount
      ),
    ).toBe(true);
  });

  it("persists full primary-plus-fallback failure context for reserve source chains", async () => {
    const fallbackCoin = ACTIVE_STABLECOINS.find((coin) => (
      (coin.liveReservesConfig?.inputs.fallbacks?.length ?? 0) > 0
      && coin.liveReservesConfig?.inputs.primary.kind === "http-json"
      && coin.liveReservesConfig.inputs.primary.url.includes("chain=tron")
    ));
    expect(fallbackCoin).toBeDefined();

    mockAdapterRegistry(async (_coin, config) => {
      const currentInput = config?.inputs.primary;
      if (!currentInput || (currentInput.kind !== "http-json" && currentInput.kind !== "http-html")) {
        throw new Error("unexpected input kind");
      }
      if (currentInput.url.includes("chain=tron")) {
        throw new Error("primary reserve source failed");
      }
      throw new Error("fallback reserve source failed");
    });

    const { syncLiveReserves } = await import("../sync-live-reserves");
    const db = mockD1();
    const result = await syncLiveReserves(db, new AbortController().signal, {});

    const fallbackAttempt = db.getHistory().find((entry) => (
      entry.sql.includes("reserve_sync_attempt_history")
      && entry.binds.includes(fallbackCoin!.id)
      && entry.binds.some((bind) => typeof bind === "string" && bind.includes("\"attemptSummaries\""))
    ));
    expect(fallbackAttempt).toBeDefined();

    const metadataJson = fallbackAttempt!.binds.find((bind): bind is string => (
      typeof bind === "string" && bind.includes("\"attemptSummaries\"")
    ));
    expect(metadataJson).toBeDefined();
    expect(JSON.parse(metadataJson!)).toMatchObject({
      reason: "adapter-exception",
      attemptSummaries: [
        {
          source: "primary",
          label: "primary:http-json",
          message: "primary reserve source failed",
        },
        {
          source: "fallback",
          label: "fallback#1:http-json",
          message: "fallback reserve source failed",
        },
      ],
    });

    const runMetadata = JSON.parse(result?.metadata ?? "{}") as {
      attemptFailureSummaries?: Array<{
        stablecoinId?: string;
        adapter?: string;
        attempts?: Array<{ source?: string; label?: string; message?: string }>;
      }>;
    };
    expect(runMetadata.attemptFailureSummaries).toContainEqual({
      stablecoinId: fallbackCoin!.id,
      adapter: fallbackCoin!.liveReservesConfig!.adapter,
      attempts: [
        {
          source: "primary",
          label: "primary:http-json",
          message: "primary reserve source failed",
        },
        {
          source: "fallback",
          label: "fallback#1:http-json",
          message: "fallback reserve source failed",
        },
      ],
    });
  });

});

describe("buildSharedSourceCacheKey", () => {
  it("produces the same key regardless of key insertion order", async () => {
    const { buildSharedSourceCacheKey } = await import("../sync-live-reserves-shared");

    const adapter = {
      key: "mento",
      fetch: async () => ({ slices: [] }),
      sourceModel: "dynamic-mix",
      evidenceClass: "independent",
      sharedSourceMode: "source-invariant",
    } as unknown as Parameters<typeof buildSharedSourceCacheKey>[1];

    const configA = {
      adapter: "mento",
      version: 1,
      semantics: "bucketed-collateral-mix",
      inputs: {
        primary: { kind: "http-json", url: "https://example.com/api" },
        fallbacks: [{ kind: "http-json", url: "https://example.com/backup" }],
      },
      params: { chain: "celo", foo: "bar" },
    } as unknown as Parameters<typeof buildSharedSourceCacheKey>[0];

    const configB = {
      params: { foo: "bar", chain: "celo" },
      inputs: {
        fallbacks: [{ url: "https://example.com/backup", kind: "http-json" }],
        primary: { url: "https://example.com/api", kind: "http-json" },
      },
      semantics: "bucketed-collateral-mix",
      version: 1,
      adapter: "mento",
    } as unknown as Parameters<typeof buildSharedSourceCacheKey>[0];

    const keyA = buildSharedSourceCacheKey(configA, adapter);
    const keyB = buildSharedSourceCacheKey(configB, adapter);

    expect(keyA).toBeTypeOf("string");
    expect(keyB).toBeTypeOf("string");
    expect(keyA).toEqual(keyB);
  });

  it("keeps same-URL shared sources separate when parser params differ", async () => {
    const { buildSharedSourceCacheKey } = await import("../sync-live-reserves-shared");

    const adapter = {
      key: "circle-transparency",
      fetch: async () => ({ slices: [] }),
      sourceModel: "dynamic-mix",
      evidenceClass: "independent",
      sharedSourceMode: "source-invariant",
    } as unknown as Parameters<typeof buildSharedSourceCacheKey>[1];

    const baseConfig = {
      adapter: "circle-transparency",
      version: 1,
      semantics: "attestation-mix",
      inputs: {
        primary: { kind: "http-html", url: "https://www.circle.com/transparency" },
      },
    };
    const usdcConfig = {
      ...baseConfig,
      params: { coinType: "usdc" },
    } as unknown as Parameters<typeof buildSharedSourceCacheKey>[0];
    const eurcConfig = {
      ...baseConfig,
      params: { coinType: "eurc" },
    } as unknown as Parameters<typeof buildSharedSourceCacheKey>[0];

    expect(buildSharedSourceCacheKey(usdcConfig, adapter)).not.toEqual(
      buildSharedSourceCacheKey(eurcConfig, adapter),
    );
  });
});
