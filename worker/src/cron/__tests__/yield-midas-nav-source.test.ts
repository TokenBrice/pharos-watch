import { afterEach, describe, expect, it } from "vitest";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { makeChainRpcConfig } from "../../test-helpers/chain-rpc-fixtures.test-support";
import { DECIMALS_SELECTOR, LATEST_ROUND_DATA_SELECTOR } from "../../lib/evm-selectors";
import { fetchMidasMmevNavOracleSource } from "../yield-sync/midas-mmev-nav-oracle";
import { cleanupYieldSourceTest, mockYieldSourceRoutes } from "./yield-source.test-support";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { TRACKED_OPTIONAL_SOURCE_REGISTRY_BY_ID } from "../yield-sync/tracked-optional-source-registry";
import { buildPreviewYieldRankingsArtifacts, publishYieldCoordinatorResults } from "../yield-sync/coordinator-persist";
import { materializeYieldHistoryDaily } from "../yield-sync/publication";
import { makeBenchmarkMeta, makeBenchmarkRegistry, makeEvaluatedSource, makeSafetySnapshotMeta,
  makeYieldSourceMeta } from "./yield-publication.test-support";

const sqliteFixtures = createLatestSchemaFixtureTracker();

async function publishNav(db: D1Database, startSec: number, exchangeRate: number, sourceObservedAt: number) {
  const source = makeEvaluatedSource({ id: "mmev-midas", symbol: "mMEV",
    sourceKey: "protocol-api:midas-mmev-nav-oracle", dataSource: "protocol-api",
    yieldType: "nav-appreciation", exchangeRate, sourceObservedAt });
  const benchmark = makeBenchmarkMeta({ fetchedAt: startSec,
    recordDate: new Date(startSec * 1000).toISOString().slice(0, 10) });
  const artifacts = buildPreviewYieldRankingsArtifacts({ evaluatedSources: [source],
    bestSourceKeyByCoin: new Map([[source.id, source.sourceKey]]), riskFreeRate: benchmark.rate,
    riskFreeRateMeta: benchmark, riskFreeRates: makeBenchmarkRegistry(benchmark),
    dlPoolsMeta: makeYieldSourceMeta(), safetySnapshot: makeSafetySnapshotMeta(), medianApy: 4.8, startSec });
  return publishYieldCoordinatorResults({ db, ...artifacts, evaluatedSources: artifacts.acceptedSources,
    startSec, degradationReasons: [], safetySnapshotHeld: false, resolvedCount: 1, rowsRejected: 0, divergenceFlags: 0,
    sourceSwitches: 0, previousYieldPublicationSnapshot: { status: "missing", rankings: [], malformed: false } });
}

const MIDAS_MMEV_NAV_ORACLE = "0x5f09Aff8B9b1f488B7d1bbaD4D89648579e55d61";
const NOW_SEC = 1_780_000_000;

function makeChainRpcs(): Map<string, ChainRpcConfig> {
  return new Map([[
    "ethereum",
    makeChainRpcConfig({
      chainId: "ethereum",
      chainName: "Ethereum",
      rpcUrls: ["https://rpc.ethereum.test"],
      explorerUrl: "https://etherscan.io",
    }),
  ]]);
}

function encodeWord(value: bigint | number): string {
  return BigInt(value).toString(16).padStart(64, "0");
}

function encodeLatestRoundData(answer: bigint, updatedAt: number): `0x${string}` {
  return `0x${[
    encodeWord(1n),
    encodeWord(answer),
    encodeWord(0n),
    encodeWord(updatedAt),
    encodeWord(1n),
  ].join("")}` as `0x${string}`;
}

function mockMidasRpc(params: {
  decimals?: bigint;
  answer: bigint;
  updatedAt: number;
}): ReturnType<typeof mockYieldSourceRoutes> {
  const fetchSpy = mockYieldSourceRoutes([
    {
      match: "https://rpc.ethereum.test",
      respond: async (request) => {
        const body = await request.clone().json() as {
      params?: Array<{ to?: string; data?: string }>;
        };
    const call = body.params?.[0];
    if (call?.to !== MIDAS_MMEV_NAV_ORACLE) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" }), { status: 200 });
    }
    if (call.data === DECIMALS_SELECTOR) {
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: `0x${encodeWord(params.decimals ?? 8n)}`,
      }), { status: 200 });
    }
    if (call.data === LATEST_ROUND_DATA_SELECTOR) {
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: encodeLatestRoundData(params.answer, params.updatedAt),
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" }), { status: 200 });
      },
    },
  ], { requireMatch: true });
  return fetchSpy;
}

describe("fetchMidasMmevNavOracleSource", () => {
  afterEach(() => { cleanupYieldSourceTest(); sqliteFixtures.closeAll(); });

  it("emits a deterministic NAV-appreciation candidate from a fresh mMEV oracle round", async () => {
    const updatedAt = NOW_SEC - 60 * 60;
    const fetchSpy = mockMidasRpc({ answer: 104_200_000n, updatedAt });

    const result = await fetchMidasMmevNavOracleSource({
      prevExchangeRate: 1.03,
      comparisonAnchorObservedAt: NOW_SEC - 7 * 86_400,
      chainRpcs: makeChainRpcs(),
      nowSec: NOW_SEC,
    });

    expect(result).toEqual(expect.objectContaining({
      stablecoinId: "mmev-midas",
      symbol: "mMEV",
      chain: "ethereum",
      address: "0x030b69280892c888670edcdcd8b69fd8026a0bf3",
    }));
    expect(result?.yield).toEqual(expect.objectContaining({
      dataSource: "protocol-api",
      exchangeRate: expect.closeTo(1.042, 6),
      sourceKey: "protocol-api:midas-mmev-nav-oracle",
      sourcePool: MIDAS_MMEV_NAV_ORACLE,
      yieldSource: "Midas mMEV/USD Oracle",
      yieldType: "nav-appreciation",
      sourceObservedAt: updatedAt,
      comparisonAnchorObservedAt: NOW_SEC - 7 * 86_400,
    }));
    expect(result?.yield.currentApy).toBeGreaterThan(0);
    expect(result?.yield.apyBase).toBe(result?.yield.currentApy);

    const requestDatas = fetchSpy.mock.calls.map(([, init]) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { params?: Array<{ data?: string }> };
      return body.params?.[0]?.data;
    });
    expect(requestDatas).toEqual(expect.arrayContaining([DECIMALS_SELECTOR, LATEST_ROUND_DATA_SELECTOR]));
  });

  it("retains a finite negative NAV return and its next history anchor", async () => {
    const updatedAt = NOW_SEC - 60;
    const anchor = NOW_SEC - 7 * 86_400;
    mockMidasRpc({ answer: 99_000_000n, updatedAt });
    const result = await fetchMidasMmevNavOracleSource({
      prevExchangeRate: 1, comparisonAnchorObservedAt: anchor,
      chainRpcs: makeChainRpcs(), nowSec: NOW_SEC,
    });
    expect(result?.yield.currentApy).toBeCloseTo((Math.pow(0.99, 365.25 / ((updatedAt - anchor) / 86_400)) - 1) * 100);
    expect(result?.yield).toMatchObject({
      exchangeRate: 0.99, sourceObservedAt: updatedAt, comparisonAnchorObservedAt: anchor,
    });
    expect(result?.yield.apyBase).toBe(result?.yield.currentApy);
  });

  it.each([3600, 2 * 86400])("annualizes two persisted oracle rounds independently of %s-second publication delays", async (delaySec) => {
    const { sqlite, db } = sqliteFixtures.open();
    const currentObservedAt = NOW_SEC;
    const priorObservedAt = currentObservedAt - 7 * 86400;
    expect((await publishNav(db, priorObservedAt + delaySec, 1, priorObservedAt)).ok).toBe(true);
    expect(sqlite.prepare("SELECT recorded_at, source_observed_at FROM yield_history").get())
      .toEqual({ recorded_at: priorObservedAt + delaySec, source_observed_at: priorObservedAt });
    mockMidasRpc({ answer: 100_200_000n, updatedAt: currentObservedAt });
    const result = await TRACKED_OPTIONAL_SOURCE_REGISTRY_BY_ID.get("mmev-midas")![0].run({
      db, startSec: currentObservedAt + delaySec, chainRpcs: makeChainRpcs(),
    });
    expect(result?.currentApy).toBeCloseTo((Math.pow(1.002, 365.25 / 7) - 1) * 100);
    expect(result).toMatchObject({ sourceObservedAt: currentObservedAt, comparisonAnchorObservedAt: priorObservedAt });
  });

  it("preserves a daily oracle anchor clock and refuses legacy publication-clock inference", async () => {
    const { sqlite, db } = sqliteFixtures.open();
    const priorObservedAt = NOW_SEC - 35 * 86400;
    expect((await publishNav(db, priorObservedAt + 2 * 86400, 1, priorObservedAt)).ok).toBe(true);
    await materializeYieldHistoryDaily(db, NOW_SEC);
    expect(sqlite.prepare("SELECT source_observed_at FROM yield_history_daily").get())
      .toEqual({ source_observed_at: priorObservedAt });
    sqlite.exec("DELETE FROM yield_history");
    mockMidasRpc({ answer: 100_200_000n, updatedAt: NOW_SEC });
    const entry = TRACKED_OPTIONAL_SOURCE_REGISTRY_BY_ID.get("mmev-midas")![0];
    const daily = await entry.run({ db, startSec: NOW_SEC, chainRpcs: makeChainRpcs() });
    expect(daily?.currentApy).toBeCloseTo((Math.pow(1.002, 365.25 / 35) - 1) * 100);
    expect(daily?.comparisonAnchorObservedAt).toBe(priorObservedAt);
    sqlite.exec("UPDATE yield_history_daily SET source_observed_at = NULL");
    const legacy = await entry.run({ db, startSec: NOW_SEC, chainRpcs: makeChainRpcs() });
    expect(legacy).toMatchObject({ currentApy: 0, apyBase: null, comparisonAnchorObservedAt: null });
  });

  it("rejects repeated rounds rather than annualizing a zero observation interval", async () => {
    mockMidasRpc({ answer: 100_200_000n, updatedAt: NOW_SEC });
    await expect(fetchMidasMmevNavOracleSource({ prevExchangeRate: 1.002,
      comparisonAnchorObservedAt: NOW_SEC, nowSec: NOW_SEC, chainRpcs: makeChainRpcs() })).resolves.toBeNull();
  });

  it("returns a seed candidate when no prior NAV anchor is available", async () => {
    mockMidasRpc({ answer: 104_200_000n, updatedAt: NOW_SEC - 60 });

    const result = await fetchMidasMmevNavOracleSource({
      chainRpcs: makeChainRpcs(),
      nowSec: NOW_SEC,
    });

    expect(result?.yield).toEqual(expect.objectContaining({
      currentApy: 0,
      apyBase: null,
      exchangeRate: expect.closeTo(1.042, 6),
      comparisonAnchorObservedAt: null,
    }));
  });

  it("returns null when the oracle round is stale", async () => {
    mockMidasRpc({ answer: 104_200_000n, updatedAt: NOW_SEC - 3 * 86_400 - 1 });

    await expect(fetchMidasMmevNavOracleSource({
      chainRpcs: makeChainRpcs(),
      nowSec: NOW_SEC,
    })).resolves.toBeNull();
  });

  it("returns null when the latest answer is not positive", async () => {
    mockMidasRpc({ answer: 0n, updatedAt: NOW_SEC - 60 });

    await expect(fetchMidasMmevNavOracleSource({
      chainRpcs: makeChainRpcs(),
      nowSec: NOW_SEC,
    })).resolves.toBeNull();
  });
});
