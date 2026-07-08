import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "../../../test-helpers/__shared/mock-d1";
import {
  buildFallbackAssetsFromCoinGecko,
  buildInsufficientFallbackResult,
} from "../fallback-intake";
import { restoreFallbackCacheState, runFallbackStalenessGate } from "../fallback-cache";
import { runFallbackDepegFollowThrough } from "../fallback-publish";
import type { PeggedAsset } from "../enrich-prices";

const fallbackMocks = vi.hoisted(() => ({
  runDepegPipeline: vi.fn(async (..._args: unknown[]) => ({
    depegErrorCount: 0,
    depegErrors: [],
    providerDiagnostics: [],
  })),
  queueTrackedAdditionsNotice: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock("../post-enrichment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../post-enrichment")>()),
  runDepegPipeline: fallbackMocks.runDepegPipeline,
}));

vi.mock("../telegram-tracked-additions", () => ({
  queueTrackedAdditionsNotice: fallbackMocks.queueTrackedAdditionsNotice,
}));

const NOW_SEC = 1_700_000_000;

function makeAsset(overrides: Partial<PeggedAsset> = {}): PeggedAsset {
  return {
    id: "fixture-usd",
    name: "Fixture USD",
    symbol: "FUSD",
    geckoId: "fixture-usd",
    pegType: "peggedUSD",
    pegMechanism: "fiat-backed",
    price: 1,
    priceSource: "coingecko",
    priceConfidence: "single-source",
    priceUpdatedAt: NOW_SEC,
    circulating: { peggedUSD: 1_000_000 },
    chainCirculating: {},
    chains: [],
    ...overrides,
  };
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

    const result = await runFallbackStalenessGate({
      db,
      assets,
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

    const result = await runFallbackStalenessGate({
      db,
      assets,
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

    const result = await runFallbackStalenessGate({
      db,
      assets,
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
