import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "../../../test-helpers/__shared/mock-d1";
import {
  buildFallbackAssetsFromCoinGecko,
  buildInsufficientFallbackResult,
  overlayFallbackCuratedAggregateSupply,
} from "../fallback-intake";
import { restoreFallbackCacheState, runFallbackStalenessGate } from "../fallback-cache";
import { runFallbackDepegFollowThrough } from "../fallback-publish";
import { loadPreviousStablecoinsById } from "../shared";
import type { PeggedAsset } from "../enrich-prices";
import { makePeggedAsset } from "./_fixtures";

const fallbackMocks = vi.hoisted(() => ({
  runDepegPipeline: vi.fn(async (..._args: unknown[]) => ({
    depegErrorCount: 0,
    depegErrors: [],
    providerDiagnostics: [],
  })),
  queueTrackedAdditionsNotice: vi.fn(async (..._args: unknown[]) => undefined),
}));

const onchainSupplyMocks = vi.hoisted(() => ({
  fetchCuratedAggregateOnChainMcap: vi.fn(),
}));

vi.mock("../post-enrichment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../post-enrichment")>()),
  runDepegPipeline: fallbackMocks.runDepegPipeline,
}));

vi.mock("../telegram-tracked-additions", () => ({
  queueTrackedAdditionsNotice: fallbackMocks.queueTrackedAdditionsNotice,
}));

vi.mock("../supplemental-assets/onchain-supply", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../supplemental-assets/onchain-supply")>()),
  fetchCuratedAggregateOnChainMcap: onchainSupplyMocks.fetchCuratedAggregateOnChainMcap,
}));

const NOW_SEC = 1_700_000_000;

function makeAsset(overrides: Partial<PeggedAsset> = {}): PeggedAsset {
  return makePeggedAsset({
    id: "fixture-usd",
    name: "Fixture USD",
    symbol: "FUSD",
    geckoId: "fixture-usd",
    pegMechanism: "fiat-backed",
    price: 1,
    priceSource: "coingecko",
    priceConfidence: "single-source",
    priceUpdatedAt: NOW_SEC,
    circulating: { peggedUSD: 1_000_000 },
    chainCirculating: {},
    chains: [],
    ...overrides,
  });
}

describe("CoinGecko fallback phases", () => {
  beforeEach(() => {
    fallbackMocks.runDepegPipeline.mockClear();
    fallbackMocks.queueTrackedAdditionsNotice.mockClear();
  });

  it("builds fallback intake assets from positive CoinGecko market caps", () => {
    const assets = buildFallbackAssetsFromCoinGecko({
      syncStartSec: NOW_SEC,
      cgData: {
        "fixture-usd": { usd: 0.999, usd_market_cap: 12_000_000 },
        "fixture-zero": { usd: 1, usd_market_cap: 0 },
      },
      stablecoins: [
        {
          id: "fixture-usd",
          name: "Fixture USD",
          symbol: "FUSD",
          geckoId: "fixture-usd",
          flags: { pegCurrency: "USD", backing: "fiat-backed" },
        },
        {
          id: "fixture-zero",
          name: "Fixture Zero",
          symbol: "FZERO",
          geckoId: "fixture-zero",
          flags: { pegCurrency: "USD", backing: "fiat-backed" },
        },
      ],
    });

    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      id: "fixture-usd",
      price: 0.999,
      priceSource: "coingecko",
      priceConfidence: "single-source",
      priceObservedAt: NOW_SEC,
      priceObservedAtMode: "local_fetch",
      priceSyncedAt: NOW_SEC,
      supplySource: "coingecko-fallback",
      circulating: { peggedUSD: 12_000_000 },
      circulatingPrevDay: null,
      circulatingPrevWeek: null,
      circulatingPrevMonth: null,
      chains: [],
      chainCirculating: {},
    });
  });

  it("uses the canonical peggedREAL type for BRL fallback assets", () => {
    const assets = buildFallbackAssetsFromCoinGecko({
      syncStartSec: NOW_SEC,
      cgData: {
        "fixture-brl": { usd: 0.18, usd_market_cap: 5_000_000 },
      },
      stablecoins: [{
        id: "fixture-brl",
        name: "Fixture BRL",
        symbol: "FBRL",
        geckoId: "fixture-brl",
        flags: { pegCurrency: "BRL", backing: "fiat-backed" },
      }],
    });

    expect(assets[0]).toMatchObject({
      pegType: "peggedREAL",
      circulating: { peggedREAL: 5_000_000 },
    });
  });

  it("keeps insufficient fallback metadata in no-write degraded mode", () => {
    const result = buildInsufficientFallbackResult(2);
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;

    expect(result.itemCount).toBeUndefined();
    expect(metadata).toMatchObject({
      rowsRead: 2,
      rowsWritten: 0,
      fallbackMode: "coingecko-supply-fallback",
      validationFailures: 1,
      cacheWriteMode: "no-write",
      downstreamSafe: false,
      capabilities: {
        stablecoinsCache: false,
        depegPipeline: false,
      },
    });
  });

  it("restores chain and supply-history fields from the previous stablecoins cache", async () => {
    const current = makeAsset({
      circulatingPrevDay: null,
      circulatingPrevWeek: null,
      circulatingPrevMonth: null,
      chainCirculating: {},
      chains: [],
    });
    const previous = makeAsset({
      chainCirculating: { Ethereum: { current: 1_000_000 } },
      chains: ["Ethereum"],
      circulatingPrevDay: { peggedUSD: 990_000 },
      circulatingPrevWeek: { peggedUSD: 980_000 },
      circulatingPrevMonth: { peggedUSD: 970_000 },
    });
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["stablecoins"],
        rows: [],
        first: {
          value: JSON.stringify({ peggedAssets: [previous] }),
          updated_at: NOW_SEC - 60,
        },
      },
    ]);

    const result = await restoreFallbackCacheState({ db, assets: [current] });

    expect(result.previousAssetsById.get("fixture-usd")).toMatchObject({
      id: "fixture-usd",
      chains: ["Ethereum"],
    });
    expect(current.chainCirculating).toEqual({ Ethereum: { current: 1_000_000 } });
    expect(current.chains).toEqual(["Ethereum"]);
    expect(current.circulatingPrevDay).toEqual({ peggedUSD: 990_000 });
    expect(current.circulatingPrevWeek).toEqual({ peggedUSD: 980_000 });
    expect(current.circulatingPrevMonth).toEqual({ peggedUSD: 970_000 });
  });

  it("returns the fallback stale-blocked result before cache publication", async () => {
    const assets = Array.from({ length: 50 }, (_, index) =>
      makeAsset({
        id: `fixture-${index}`,
        geckoId: `fixture-${index}`,
        price: 1,
      }),
    );
    const previousPayload = {
      peggedAssets: assets.map((asset) => ({
        id: asset.id,
        price: asset.price,
        priceSource: asset.priceSource,
        priceConfidence: asset.priceConfidence,
        priceUpdatedAt: asset.priceUpdatedAt,
        priceObservedAt: asset.priceObservedAt ?? asset.priceUpdatedAt,
        priceSyncedAt: asset.priceSyncedAt,
      })),
    };
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["stablecoins"],
        rows: [],
        first: {
          value: JSON.stringify(previousPayload),
          updated_at: NOW_SEC - 8 * 3600,
        },
      },
    ]);

    const { previousAssetsById, cacheState: previousCacheState } = await loadPreviousStablecoinsById(db);
    const result = await runFallbackStalenessGate({
      db,
      assets,
      previousAssetsById,
      previousCacheState,
      syncStartSec: NOW_SEC,
    });

    expect("metadata" in result).toBe(true);
    const metadata = JSON.parse(("metadata" in result ? result.metadata : null) ?? "{}") as Record<string, unknown>;
    expect(result).toMatchObject({
      status: "degraded",
      itemCount: 50,
    });
    expect(metadata).toMatchObject({
      rowsRead: 50,
      rowsWritten: 0,
      fallbackMode: "coingecko-supply-fallback-stale-blocked",
      stalenessWarning: true,
      staleWriteBlocked: true,
      cacheWriteMode: "no-write",
      cacheWriteSucceeded: false,
      depegPipelineSucceeded: false,
    });
  });

  it("marks malformed previous cache as check-failed in the fallback staleness gate", async () => {
    const assets = [makeAsset()];
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["stablecoins"],
        rows: [],
        first: {
          value: "{not-json",
          updated_at: NOW_SEC - 60,
        },
      },
    ]);

    const { previousAssetsById, cacheState: previousCacheState } = await loadPreviousStablecoinsById(db);
    const result = await runFallbackStalenessGate({
      db,
      assets,
      previousAssetsById,
      previousCacheState,
      syncStartSec: NOW_SEC,
    });

    expect("metadata" in result).toBe(false);
    expect(result).toMatchObject({
      stalenessWarning: false,
      stalenessSummary: null,
      stalenessCheckFailed: true,
      stalenessCheckFailureReason: "malformed-previous-cache",
    });
  });

  it("marks D1 read failures as check-failed in the fallback staleness gate", async () => {
    const assets = [makeAsset()];
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["stablecoins"],
        rows: [],
        throwError: new Error("cache read failed"),
      },
    ]);

    const { previousAssetsById, cacheState: previousCacheState } = await loadPreviousStablecoinsById(db);
    const result = await runFallbackStalenessGate({
      db,
      assets,
      previousAssetsById,
      previousCacheState,
      syncStartSec: NOW_SEC,
    });

    expect("metadata" in result).toBe(false);
    expect(result).toMatchObject({
      stalenessWarning: false,
      stalenessSummary: null,
      stalenessCheckFailed: true,
      stalenessCheckFailureReason: "cache read failed",
    });
  });

  it("keeps fallback staleness abort handling unchanged", async () => {
    const controller = new AbortController();
    controller.abort("fallback abort");

    const result = await runFallbackStalenessGate({
      db: mockD1([]),
      assets: [makeAsset()],
      previousAssetsById: new Map(),
      previousCacheState: { state: "missing" },
      syncStartSec: NOW_SEC,
      signal: controller.signal,
    });

    expect("metadata" in result).toBe(true);
    expect(result).toMatchObject({
      aborted: true,
      status: "degraded",
      itemCount: 0,
    });
    const metadata = JSON.parse(("metadata" in result ? result.metadata : null) ?? "{}") as Record<string, unknown>;
    expect(metadata).toMatchObject({
      reason: "aborted",
      stage: "fallback-detect-price-staleness",
      detail: "fallback abort",
      cacheWriteMode: "no-write",
      downstreamSafe: false,
      capabilities: {
        stablecoinsCache: false,
        depegPipeline: false,
      },
    });
  });

  it("queues tracked-additions notice before fallback depeg follow-through", async () => {
    const db = mockD1([]);
    const assets = [
      makeAsset({ id: "fixture-new", geckoId: "fixture-new" }),
    ];
    const previousAssetsById = new Map<string, PeggedAsset>([
      ["fixture-old", makeAsset({ id: "fixture-old", geckoId: "fixture-old" })],
    ]);

    const result = await runFallbackDepegFollowThrough({
      db,
      assets,
      previousAssetsById,
      syncStartSec: NOW_SEC,
      returnIfAborted: () => null,
      abortResult: () => ({ metadata: "{}" }),
    });

    expect(result).toMatchObject({
      depegErrorCount: 0,
      depegErrors: [],
      providerDiagnostics: [],
    });
    const noticeOrder = fallbackMocks.queueTrackedAdditionsNotice.mock.invocationCallOrder[0];
    const depegOrder = fallbackMocks.runDepegPipeline.mock.invocationCallOrder[0];
    expect(noticeOrder).toBeDefined();
    expect(depegOrder).toBeDefined();
    expect(noticeOrder!).toBeLessThan(depegOrder!);
    expect(fallbackMocks.queueTrackedAdditionsNotice).toHaveBeenCalledTimes(1);
    const noticeCall = fallbackMocks.queueTrackedAdditionsNotice.mock.calls[0];
    expect(noticeCall).toBeDefined();
    const [noticeDb, previousIds, noticeAssets] = noticeCall!;
    expect(noticeDb).toBe(db);
    expect(Array.from(previousIds as Iterable<string>)).toEqual(["fixture-old"]);
    expect(noticeAssets).toBe(assets);
    expect(fallbackMocks.runDepegPipeline).toHaveBeenCalledWith(
      db,
      assets,
      undefined,
      undefined,
      undefined,
      expect.any(Function),
      expect.any(Function),
      "fallback-",
      " (CG fallback)",
    );
  });
});

describe("overlayFallbackCuratedAggregateSupply", () => {
  beforeEach(() => {
    onchainSupplyMocks.fetchCuratedAggregateOnChainMcap.mockReset();
  });

  it("attaches the full per-chain map for a curated NAV wrapper and probes only curated assets", async () => {
    onchainSupplyMocks.fetchCuratedAggregateOnChainMcap.mockResolvedValue({
      mcap: 4_884_400_000,
      supplySource: "onchain-total-supply",
      chainCirculating: {
        Ethereum: 4_517_720_000,
        Base: 11_478_000,
        Optimism: 4_876_000,
        Arbitrum: 346_620_000,
      },
    });
    const susds = makeAsset({
      id: "susds-sky",
      symbol: "sUSDS",
      geckoId: "susds",
      price: 1.06,
      supplySource: "coingecko-fallback",
      circulating: { peggedUSD: 4_600_000_000 },
      chainCirculating: {},
      chains: [],
    });
    // Not a curated aggregate id: it must be skipped without an on-chain probe.
    const other = makeAsset({ id: "fixture-usd", chainCirculating: { Ethereum: { current: 1 } } });

    await overlayFallbackCuratedAggregateSupply([other, susds]);

    expect(onchainSupplyMocks.fetchCuratedAggregateOnChainMcap).toHaveBeenCalledTimes(1);
    const [meta, priceUsd] = onchainSupplyMocks.fetchCuratedAggregateOnChainMcap.mock.calls[0]!;
    expect((meta as { id: string }).id).toBe("susds-sky");
    // Single basis: the CG NAV price is passed straight through to the probe.
    expect(priceUsd).toBe(1.06);

    expect(susds.supplySource).toBe("onchain-total-supply");
    expect(susds.circulating).toEqual({ peggedUSD: 4_884_400_000 });
    expect(susds.chains).toEqual(["Ethereum", "Base", "Optimism", "Arbitrum"]);
    expect(susds.chainCirculating).toEqual({
      Ethereum: { current: 4_517_720_000, circulatingPrevDay: 0, circulatingPrevWeek: 0, circulatingPrevMonth: 0 },
      Base: { current: 11_478_000, circulatingPrevDay: 0, circulatingPrevWeek: 0, circulatingPrevMonth: 0 },
      Optimism: { current: 4_876_000, circulatingPrevDay: 0, circulatingPrevWeek: 0, circulatingPrevMonth: 0 },
      Arbitrum: { current: 346_620_000, circulatingPrevDay: 0, circulatingPrevWeek: 0, circulatingPrevMonth: 0 },
    });
    expect(other.chainCirculating).toEqual({ Ethereum: { current: 1 } });
  });

  it("fails closed to the restored previous-row carry when a configured chain read fails", async () => {
    onchainSupplyMocks.fetchCuratedAggregateOnChainMcap.mockResolvedValue(null);
    const restoredCarry = { Ethereum: { current: 4_000_000_000 } };
    const susds = makeAsset({
      id: "susds-sky",
      symbol: "sUSDS",
      geckoId: "susds",
      price: 1.06,
      supplySource: "coingecko-fallback",
      circulating: { peggedUSD: 4_600_000_000 },
      chainCirculating: restoredCarry,
      chains: ["Ethereum"],
    });

    await overlayFallbackCuratedAggregateSupply([susds]);

    expect(onchainSupplyMocks.fetchCuratedAggregateOnChainMcap).toHaveBeenCalledTimes(1);
    // No partial map: the restored carry, its chains, and supply source are all preserved.
    expect(susds.chainCirculating).toBe(restoredCarry);
    expect(susds.chainCirculating).toEqual({ Ethereum: { current: 4_000_000_000 } });
    expect(susds.chains).toEqual(["Ethereum"]);
    expect(susds.circulating).toEqual({ peggedUSD: 4_600_000_000 });
    expect(susds.supplySource).toBe("coingecko-fallback");
  });

  it("does not par-value a missing NAV price for the curated aggregate overlay", async () => {
    const susds = makeAsset({
      id: "susds-sky",
      symbol: "sUSDS",
      geckoId: "susds",
      price: null,
      supplySource: "coingecko-fallback",
      circulating: { peggedUSD: 4_600_000_000 },
      chainCirculating: {},
      chains: [],
    });

    await overlayFallbackCuratedAggregateSupply([susds]);

    expect(onchainSupplyMocks.fetchCuratedAggregateOnChainMcap).not.toHaveBeenCalled();
    expect(susds.circulating).toEqual({ peggedUSD: 4_600_000_000 });
    expect(susds.chainCirculating).toEqual({});
  });
});
