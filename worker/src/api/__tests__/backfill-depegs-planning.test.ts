import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { StablecoinData } from "@shared/types";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { buildBackfillPlan } from "../backfill-depegs/planning";
import { executeBackfillForCoin, type ApplyBackfillEventsFn } from "../backfill-depegs/execution";
import { backfillCoin } from "../backfill-depegs-replay";
import { parseSupplyData } from "../backfill-depegs-extraction";
import {
  acquireDefiLlamaDetailMaterialization,
  DEFILLAMA_DETAIL_MAX_RESPONSE_BYTES,
  resetDefiLlamaDetailStateForTests,
} from "../stablecoin-detail/defillama";
import { DEFAULT_FETCH_RETRY_MAX_RESPONSE_BYTES } from "../../lib/fetch-retry";
import type * as AbortModule from "../../lib/abort";

vi.mock("../backfill-depegs-replay", () => ({ backfillCoin: vi.fn() }));
vi.mock("../../lib/abort", async (importOriginal) => ({
  ...(await importOriginal<typeof AbortModule>()),
  sleepWithSignal: vi.fn(async () => undefined),
}));

const meta = ACTIVE_STABLECOINS.find((coin) => coin.id === "usdt-tether")!;
const tokens = [{ date: "1000", totalCirculatingUSD: { peggedUSD: 2_000_000_000 } }];

function preparePlan() {
  return buildBackfillPlan({
    db: mockD1([{ match: "cache", rows: [] }]), coins: [meta], replayWindow: null, coingeckoApiKey: null,
  });
}

afterEach(() => {
  vi.useRealTimers();
  resetDefiLlamaDetailStateForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("backfill-depegs planning detail intake", () => {
  it.each<StablecoinData["circulating"]>([{}, { peggedUSD: 0 }])("retains current replay-input supply availability (%j)", async (circulating) => {
    mockFetch([{ match: "/stablecoin/", body: { tokens } }]);
    const plan = await buildBackfillPlan({
      db: mockD1([{ match: "cache", rows: [{
        value: JSON.stringify({ peggedAssets: [makeStablecoin({ id: meta.id, symbol: meta.symbol, circulating, price: 1 })] }),
        updated_at: Math.floor(Date.now() / 1000),
      }] }]),
      coins: [meta], replayWindow: null, coingeckoApiKey: null,
    });
    expect(plan.preparedCoins[0]!.currentSupplyUsd).toBe("peggedUSD" in circulating ? 0 : null);
  });

  it("keeps historical supply and defillama-history provenance for healthy bodies above the shared cap", async () => {
    const body = JSON.stringify({
      gecko_id: "tether", tokens,
      chainBalances: { unused: "x".repeat(DEFAULT_FETCH_RETRY_MAX_RESPONSE_BYTES) },
    });
    expect(body.length).toBeGreaterThan(DEFAULT_FETCH_RETRY_MAX_RESPONSE_BYTES);
    expect(body.length).toBeLessThan(DEFILLAMA_DETAIL_MAX_RESPONSE_BYTES);
    mockFetch([{ match: "/stablecoin/", respond: () => new Response(body) }]);
    const plan = await preparePlan();
    const prepared = plan.preparedCoins[0]!;
    expect(prepared.supplyTokens).toEqual(tokens);
    expect(parseSupplyData(prepared.supplyTokens)).toEqual([{ ts: 1000, supply: 2_000_000_000 }]);
    expect(prepared).not.toHaveProperty("chainBalances");
    vi.mocked(backfillCoin).mockResolvedValue({
      sourceKind: "market", authoritativeSource: null, marketDiagnostics: null,
      events: [{
        pegType: "peggedUSD", direction: "below", peakDeviationBps: -200,
        startedAt: 1000, endedAt: 2000, startPrice: 0.98, peakPrice: 0.98, recoveryPrice: 1, pegRef: 1,
      }],
    });
    const applyBackfillEvents = vi.fn<ApplyBackfillEventsFn>(async () => undefined);
    const outcome = await executeBackfillForCoin({
      db: mockD1([{ match: "FROM depeg_events", rows: [] }]), prepared,
      pegRates: plan.pegRates, fxRates: plan.fxRates, fxSeries: plan.fxSeries,
      commoditySeries: plan.commoditySeries, replayWindow: null, coingeckoApiKey: null,
      dryRun: false, applyBackfillEvents,
    });
    expect(outcome.status).toBe("applied");
    expect(vi.mocked(backfillCoin).mock.calls[0]![0].supplyByDate).toEqual([{ ts: 1000, supply: 2_000_000_000 }]);
    expect(applyBackfillEvents.mock.calls[0]![1]).toEqual([
      expect.objectContaining({ provenance: expect.objectContaining({ supplySource: "defillama-history" }) }),
    ]);
  });

  it("rejects detail above the provider cap without consuming or truncating its body", async () => {
    const cancelled = vi.fn();
    const fetch = mockFetch([{
      match: "/stablecoin/",
      respond: () => new Response(new ReadableStream<Uint8Array>({ cancel: cancelled }), {
        headers: { "content-length": String(DEFILLAMA_DETAIL_MAX_RESPONSE_BYTES + 1) },
      }),
    }]);
    const plan = await preparePlan();
    expect(plan.preparedCoins[0]!.supplyTokens).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(cancelled).toHaveBeenCalledTimes(2);
  });

  it("shares detail materialization admission before starting a planning fetch", async () => {
    vi.useFakeTimers();
    const release = await acquireDefiLlamaDetailMaterialization();
    const fetch = mockFetch([{ match: "/stablecoin/", body: { tokens } }]);
    const pending = preparePlan();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      release();
      await pending;
    }
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await pending).preparedCoins[0]!.supplyTokens).toEqual(tokens);
  });
});
