import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import type { PeggedAsset } from "../enrich-prices";
import type * as StablecoinRegistry from "@shared/lib/stablecoins/registry";
import type * as OnchainSupply from "../supplemental-assets/onchain-supply";
import type * as FetchRetry from "../../../lib/fetch-retry";
import type * as StructuredLog from "../../../lib/structured-log";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import { canonicalizeChainCirculating } from "@shared/lib/chains/circulating";

const fetchTextWithRetryMock = vi.hoisted(() => vi.fn());
const logWorkerEventMock = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/fetch-retry", async (importOriginal) => ({
  ...(await importOriginal<typeof FetchRetry>()),
  fetchTextWithRetry: fetchTextWithRetryMock,
}));

vi.mock("../../../lib/structured-log", async (importOriginal) => ({
  ...(await importOriginal<typeof StructuredLog>()),
  logWorkerEvent: logWorkerEventMock,
}));

vi.mock("@shared/lib/stablecoins/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof StablecoinRegistry>();
  const ACTIVE_META_BY_ID = new Map(actual.ACTIVE_META_BY_ID);
  const zarm = ACTIVE_META_BY_ID.get("zarm-mento");
  if (!zarm) throw new Error("missing ZARm test metadata");
  ACTIVE_META_BY_ID.set("zarm-mento", { ...zarm, detailProvider: "defillama" });
  const eurcv = ACTIVE_META_BY_ID.get("eurcv-societe-generale-forge")!;
  for (let index = 0; index < 16; index++) {
    const id = `gap-cap-fixture-${index}`;
    ACTIVE_META_BY_ID.set(id, { ...eurcv, id });
  }
  return { ...actual, ACTIVE_META_BY_ID };
});

vi.mock("../supplemental-assets/onchain-supply", async (importOriginal) => ({
  ...(await importOriginal<typeof OnchainSupply>()),
  fetchCuratedAggregateOnChainMcap: vi.fn(),
}));

import {
  COINGECKO_GAP_FILL_POLICY,
  carryForwardSupplyGapFill,
  prioritizeSupplyGapCandidateOrder,
  reconcileTrackedSupplyGaps,
} from "../supply-gap-reconciliation";
import { fetchCuratedAggregateOnChainMcap } from "../supplemental-assets/onchain-supply";
import { fillMissingSupplyHistory } from "../phase-helpers";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => { fixtures.closeAll(); });

const DAY_MS = 24 * 60 * 60 * 1000;

interface ChainCirculatingRowFixture extends Record<string, unknown> {
  current: number | null;
}

type SupplyGapAssetFixture = PeggedAsset & {
  chainCirculating: Record<string, ChainCirculatingRowFixture>;
};

function makeAsset(): SupplyGapAssetFixture {
  return {
    id: "eurcv-societe-generale-forge",
    name: "EUR CoinVertible",
    symbol: "EURCV",
    supplySource: "defillama",
    circulating: { peggedEUR: 100 },
    circulatingPrevDay: { peggedEUR: 90 },
    circulatingPrevWeek: { peggedEUR: 80 },
    circulatingPrevMonth: { peggedEUR: 70 },
    chainCirculating: {
      Ethereum: { current: 60, circulatingPrevDay: 54, circulatingPrevWeek: 48, circulatingPrevMonth: 42 },
      Solana: { current: 30, circulatingPrevDay: 27, circulatingPrevWeek: 24, circulatingPrevMonth: 21 },
      Stellar: { current: 10, circulatingPrevDay: 9, circulatingPrevWeek: 8, circulatingPrevMonth: 7 },
    },
    chains: ["Ethereum", "Solana", "Stellar"],
  };
}

function mockCoinGeckoHistory(
  points: [number, number][],
  marketCap = 130,
  lastUpdatedAt = Math.floor(Date.now() / 1000),
): void {
  fetchTextWithRetryMock.mockImplementation((url: string) => ({
    response: { ok: true },
    body: JSON.stringify(url.includes("/simple/price")
      ? { "societe-generale-forge-eurcv": { usd_market_cap: marketCap, last_updated_at: lastUpdatedAt } }
      : { market_caps: points }),
  }));
}

/** CoinGecko series whose current point equals `current` and whose history keeps CG/DL inside the band. */
function mockCoinGeckoAt(current: number): void {
  const nowMs = Date.now();
  mockCoinGeckoHistory([
    [nowMs - (30 * DAY_MS), 70],
    [nowMs - (7 * DAY_MS), 80],
    [nowMs - DAY_MS, 90],
    [nowMs, current],
  ], current);
}

function previousGapFilled(): Map<string, PeggedAsset> {
  return new Map([["eurcv-societe-generale-forge", { ...makeAsset(), supplySource: "coingecko-gap-fill" }]]);
}

beforeEach(() => {
  fetchTextWithRetryMock.mockReset();
  logWorkerEventMock.mockReset();
  vi.mocked(fetchCuratedAggregateOnChainMcap).mockReset();
});

describe("supply-gap reconciliation ordering", () => {
  it("admits blocking zero-supply collapses before the bounded missing-chain tail", () => {
    const candidates = [
      ...Array.from({ length: 15 }, (_, index) => ({
        kind: "missing-chain" as const,
        id: `chain-gap-${index}`,
      })),
      { kind: "zero-supply-collapse" as const, id: "xofm-mento" },
    ];

    const ordered = prioritizeSupplyGapCandidateOrder(candidates);

    expect(ordered[0]).toEqual({ kind: "zero-supply-collapse", id: "xofm-mento" });
    expect(ordered.slice(0, 15).some(({ id }) => id === "xofm-mento")).toBe(true);
  });
});

describe("CoinGecko missing-chain remainder reconciliation", () => {
  it.each([null, [], 42, "unavailable", false])("treats non-object simple-price root %j as no-decision", async (root) => {
    const asset = makeAsset();
    const before = structuredClone(asset);
    const healthy = makeAsset();
    healthy.chainCirculating["XRP Ledger"] = { chainId: "xrpl", current: 0 };
    const healthyBefore = structuredClone(healthy);
    fetchTextWithRetryMock.mockResolvedValue({ response: { ok: true }, body: JSON.stringify(root) });

    const result = await reconcileTrackedSupplyGaps([asset, healthy]);

    expect(result.totalReconciled).toBe(0);
    expect(result.reconciledIds).toEqual([]);
    expect(result.gapFillRejections).toEqual([]);
    expect(asset).toEqual(before);
    expect(healthy).toEqual(healthyBefore);
    expect(fetchTextWithRetryMock).toHaveBeenCalledTimes(1);
    expect(fetchTextWithRetryMock.mock.calls[0][0]).toContain("/simple/price");
    expect(logWorkerEventMock).toHaveBeenCalledWith(expect.objectContaining({
      event: "sync-stablecoins.coingecko-current-market-cap-unavailable",
      level: "warn",
      metadata: { reason: "non-object-root" },
    }));
  });

  it("uses the existing bounded carry when simple-price returns a null root", async () => {
    const previous = makeAsset();
    mockCoinGeckoAt(130);
    await reconcileTrackedSupplyGaps([previous]);
    const current = makeAsset();
    fetchTextWithRetryMock.mockResolvedValue({ response: { ok: true }, body: "null" });

    const result = await reconcileTrackedSupplyGaps([current], undefined, null, undefined, undefined, new Map([[previous.id, previous]]));

    expect(result.totalReconciled).toBe(0);
    expect(current.circulating).toEqual(previous.circulating);
    expect(current.chainCirculating).toEqual(previous.chainCirculating);
    expect(current.supplyGapFill).toEqual({ ...previous.supplyGapFill, carryForwardRuns: 1 });
    expect(current.supplyRestored).toBe(true);
  });

  it.each([undefined, null])("admits an undated prior gap-fill (%s) within the publication carry limit", async (observedAt) => {
    const original = makeAsset();
    mockCoinGeckoAt(130);
    await reconcileTrackedSupplyGaps([original]);
    original.supplyObservedAt = observedAt;
    const current = makeAsset();
    expect(carryForwardSupplyGapFill(current, original)).toBe(true);
    expect(current.circulating).toEqual(original.circulating);
    expect(current.chainCirculating).toEqual(original.chainCirculating);
    expect(current.supplyObservedAt).toBe(observedAt);
    expect(current.supplyRestored).toBe(true);
    expect(current.supplyGapFill).toEqual({ ...original.supplyGapFill, carryForwardRuns: 1 });
  });

  it("carries previously filled candidates deferred by the per-run request cap", async () => {
    const first = makeAsset();
    mockCoinGeckoAt(130);
    await reconcileTrackedSupplyGaps([first]);
    const assets = Array.from({ length: 16 }, (_, index) => ({ ...makeAsset(), id: `gap-cap-fixture-${index}` }));
    const deferred = assets[15]!;
    const previous = new Map([[deferred.id, { ...first, id: deferred.id }]]);
    const result = await reconcileTrackedSupplyGaps(assets, undefined, null, undefined, undefined, previous);
    expect(result.totalReconciled).toBe(15);
    expect(deferred.circulating).toEqual({ peggedEUR: 130 });
    expect(deferred.supplyGapFill).toEqual({ ...first.supplyGapFill, carryForwardRuns: 1 });
    expect(deferred.supplyRestored).toBe(true);
  });

  it.each(["simple-price", "market-chart"] as const)("carries a coherent gap-fill across %s failure, then expires", async (failure) => {
    const original = makeAsset();
    mockCoinGeckoAt(106);
    await reconcileTrackedSupplyGaps([original]);
    const provenance = original.supplyGapFill;
    expect(provenance?.admission).toBe("entered");
    let previous: PeggedAsset = original;
    for (let run = 1; run <= 3; run++) {
      mockCoinGeckoAt(104);
      const successfulFetch = fetchTextWithRetryMock.getMockImplementation()!;
      fetchTextWithRetryMock.mockImplementation((url: string) =>
        url.includes(failure === "simple-price" ? "/simple/price" : "/market_chart")
          ? { response: { ok: false, status: 429 }, body: "" }
          : successfulFetch(url));
      const current = makeAsset();
      await reconcileTrackedSupplyGaps([current], undefined, null, undefined, undefined, new Map([[previous.id, previous]]));
      if (run <= 2) {
        expect(current.circulating).toEqual(original.circulating);
        expect(current.chainCirculating).toEqual(original.chainCirculating);
        expect(current.supplyGapFill).toEqual({ ...provenance, carryForwardRuns: run });
        expect(current.supplyRestored).toBe(true);
      } else {
        expect(current.circulating).toEqual({ peggedEUR: 100 });
        expect(current.supplyGapFill).toBeUndefined();
      }
      previous = current;
    }
  });

  it.each(["simple-price", "market-chart", "candidate-cap"] as const)(
    "keeps fresh DefiLlama supply when %s would carry expired or future evidence",
    async (failure) => {
      const original = makeAsset();
      mockCoinGeckoAt(130);
      await reconcileTrackedSupplyGaps([original]);
      for (const observedAt of [Math.floor(Date.now() / 1000) - 8 * 86400, Math.floor(Date.now() / 1000) + 3600]) {
        const assets = failure === "candidate-cap"
          ? Array.from({ length: 16 }, (_, index) => ({ ...makeAsset(), id: `gap-cap-fixture-${index}` }))
          : [makeAsset()];
        const current = assets[assets.length - 1]!;
        const before = structuredClone(current);
        const previous = { ...original, id: current.id, supplyObservedAt: observedAt,
          supplyGapFill: { ...original.supplyGapFill!, observedAt } };
        mockCoinGeckoAt(130);
        const successfulFetch = fetchTextWithRetryMock.getMockImplementation()!;
        if (failure !== "candidate-cap") {
          fetchTextWithRetryMock.mockImplementation((url: string) =>
            url.includes(failure === "simple-price" ? "/simple/price" : "/market_chart")
              ? { response: { ok: false, status: 429 }, body: "" } : successfulFetch(url));
        }
        await reconcileTrackedSupplyGaps(assets, undefined, null, undefined, undefined, new Map([[current.id, previous]]));
        expect(current).toEqual(before);
      }
    },
  );

  it.each(["missing-chain", "zero-supply"] as const)("rejects future current chart evidence for %s without masking its age", async (kind) => {
    const nowMs = Date.now();
    const asset = kind === "missing-chain" ? makeAsset() : {
      ...makeAsset(), id: "tryb-bilira", symbol: "TRYB", pegType: "peggedTRY",
      circulating: { peggedTRY: 0 }, chainCirculating: {},
    };
    const before = structuredClone(asset);
    const points: [number, number][] = [
      [nowMs - 30 * DAY_MS, 70], [nowMs - 7 * DAY_MS, 80], [nowMs - DAY_MS, 90], [nowMs + 3600_000, 130],
    ];
    if (kind === "missing-chain") mockCoinGeckoHistory(points);
    else fetchTextWithRetryMock.mockResolvedValue({
      response: { ok: true },
      body: JSON.stringify(points.map(([date, cap]) => ({ date, totalCirculatingUSD: { peggedTRY: cap * 100_000 } }))),
    });
    const result = await reconcileTrackedSupplyGaps([asset]);
    expect(result.totalReconciled).toBe(0);
    expect(result.assets).toEqual([]);
    expect(result.gapFillRejections).toEqual([{ id: asset.id, reason: "current-observation-future", ratio: null }]);
    expect(asset).toEqual(before);
    expect(fetchCuratedAggregateOnChainMcap).not.toHaveBeenCalled();
  });

  it.each([60, 61])("admits only approved current chart future skew at %s seconds", async (skew) => {
    const nowMs = Math.floor(Date.now() / 1000) * 1000;
    const asset = makeAsset();
    mockCoinGeckoHistory([
      [nowMs - 30 * DAY_MS, 70], [nowMs - 7 * DAY_MS, 80], [nowMs - DAY_MS, 90], [nowMs + skew * 1000, 130],
    ]);
    const result = await reconcileTrackedSupplyGaps([asset]);
    expect(result.totalReconciled).toBe(skew === 60 ? 1 : 0);
    if (skew === 60) expect(result.assets[0]?.observedAgeSec).toBe(-60);
  });

  it("retains the hysteresis band on recovery after a failed run", async () => {
    const first = makeAsset();
    mockCoinGeckoAt(106);
    await reconcileTrackedSupplyGaps([first]);
    fetchTextWithRetryMock.mockResolvedValue(null);
    const carried = makeAsset();
    await reconcileTrackedSupplyGaps([carried], undefined, null, undefined, undefined, new Map([[first.id, first]]));
    mockCoinGeckoAt(104);
    const recovered = makeAsset();
    await reconcileTrackedSupplyGaps([recovered], undefined, null, undefined, undefined, new Map([[carried.id, carried]]));
    expect(recovered.circulating).toEqual({ peggedEUR: 104 });
    expect(recovered.supplyGapFill?.admission).toBe("retained");
    expect(recovered.supplyGapFill?.carryForwardRuns).toBeUndefined();
    expect(recovered.supplyRestored).toBeUndefined();
  });

  it("publishes every aggregate bucket from the single CoinGecko series and attributes only the nonnegative remainder", async () => {
    const nowMs = Date.now();
    const asset = makeAsset();
    mockCoinGeckoHistory([
      [nowMs - (30 * DAY_MS), 75],
      [nowMs - (7 * DAY_MS), 110],
      [nowMs - DAY_MS, 95],
      [nowMs, 130],
    ]);

    const result = await reconcileTrackedSupplyGaps([asset]);

    expect(result.totalReconciled).toBe(1);
    expect(asset.supplySource).toBe("coingecko-gap-fill");
    // Every aggregate bucket comes from the admitted CoinGecko series.
    expect(asset.circulating).toEqual({ peggedEUR: 130 });
    expect(asset.circulatingPrevDay).toEqual({ peggedEUR: 95 });
    expect(asset.circulatingPrevWeek).toEqual({ peggedEUR: 110 });
    expect(asset.circulatingPrevMonth).toEqual({ peggedEUR: 75 });
    // Every history remainder conserves the observed DefiLlama baseline.
    expect(asset.chainCirculating?.["XRP Ledger"]).toEqual({ chainId: "xrpl", current: 30, circulatingPrevDay: 5, circulatingPrevWeek: 30, circulatingPrevMonth: 5 });
    for (const field of ["circulatingPrevDay", "circulatingPrevWeek", "circulatingPrevMonth"] as const) {
      const chainSum = Object.values(asset.chainCirculating).reduce((sum, row) => sum + (row[field] as number), 0);
      expect(chainSum).toBe(asset[field]?.peggedEUR);
    }
    const chainCurrent = [...canonicalizeChainCirculating(asset.chainCirculating).values()]
      .reduce((sum, row) => sum + (row.current ?? 0), 0);
    expect(chainCurrent).toBe(getCirculatingRawOrNull(asset));
    expect(asset.supplyGapFill).toEqual({
      method: "coingecko-single-missing-chain",
      admission: "entered",
      missingChainId: "xrpl",
      canonicalSource: "defillama",
      canonicalCurrentUsd: 100,
      supplementalSource: "coingecko",
      supplementalCurrentUsd: 130,
      ratio: 1.3,
      maxRatio: COINGECKO_GAP_FILL_POLICY.maxRatio,
      observedAt: Math.floor(nowMs / 1000),
    });
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]).toMatchObject({
      id: asset.id,
      reason: "coingecko-gap-fill",
      fromSource: "defillama",
      toValue: 130,
      observedAt: Math.floor(nowMs / 1000),
    });
    expect(result.assets[0].observedAgeSec).toBeLessThanOrEqual(2);
    expect(asset.supplyObservedAt).toBe(Math.floor(nowMs / 1000));
    expect(result.gapFillRejections).toEqual([]);
  });

  it("withholds the AstraA non-conserving previous-day remainder without changing the admitted aggregate", async () => {
    const nowMs = Date.now();
    const asset = makeAsset();
    asset.chainCirculating.Ethereum.circulatingPrevDay = 44;
    const observedChains = structuredClone(asset.chainCirculating);
    mockCoinGeckoHistory([
      [nowMs - (30 * DAY_MS), 75],
      [nowMs - (7 * DAY_MS), 110],
      [nowMs - DAY_MS, 95],
      [nowMs, 130],
    ]);

    const result = await reconcileTrackedSupplyGaps([asset]);

    expect(result.totalReconciled).toBe(1);
    expect(result.gapFillRejections).toEqual([]);
    expect(asset.circulating).toEqual({ peggedEUR: 130 });
    expect(asset.circulatingPrevDay).toEqual({ peggedEUR: 95 });
    expect(asset.circulatingPrevWeek).toEqual({ peggedEUR: 110 });
    expect(asset.circulatingPrevMonth).toEqual({ peggedEUR: 75 });
    expect(asset.chainCirculating["XRP Ledger"]).toEqual({
      chainId: "xrpl", current: 30, circulatingPrevDay: null, circulatingPrevWeek: 30, circulatingPrevMonth: 5,
    });
    expect(asset.supplyGapFill?.withheldHistoricalBuckets).toEqual(["day"]);
    expect(asset.supplyGapFill?.withheldHistoricalBucketReasons).toEqual({ day: "nonconserving" });
    for (const [label, row] of Object.entries(observedChains)) {
      expect(asset.chainCirculating[label]).toEqual(row);
    }
  });

  it.each([
    { key: "day", field: "circulatingPrevDay" },
    { key: "week", field: "circulatingPrevWeek" },
    { key: "month", field: "circulatingPrevMonth" },
  ] as const)("withholds $key when an existing chain's historical observation is null or absent", async ({ key, field }) => {
    for (const value of [null, undefined]) {
      const asset = makeAsset();
      asset.chainCirculating.Ethereum[field] = value;
      const observedChains = structuredClone(asset.chainCirculating);
      mockCoinGeckoAt(130);

      const result = await reconcileTrackedSupplyGaps([asset]);

      expect(result.totalReconciled).toBe(1);
      expect(asset.circulating).toEqual({ peggedEUR: 130 });
      expect(asset[field]).toEqual({ peggedEUR: key === "day" ? 90 : key === "week" ? 80 : 70 });
      expect(asset.chainCirculating["XRP Ledger"][field]).toBeNull();
      expect(asset.supplyGapFill?.withheldHistoricalBuckets).toEqual([key]);
      expect(asset.supplyGapFill?.withheldHistoricalBucketReasons).toEqual({ [key]: "history-unobserved" });
      expect(canonicalizeChainCirculating(asset.chainCirculating).get("xrpl")?.[field]).toBeUndefined();
      for (const [label, row] of Object.entries(observedChains)) {
        expect(asset.chainCirculating[label]).toEqual(row);
      }
    }
  });

  it("names every withheld historical window in bucket order", async () => {
    const asset = makeAsset();
    asset.chainCirculating.Ethereum.circulatingPrevDay = 44;
    asset.chainCirculating.Solana.circulatingPrevWeek = null;
    asset.chainCirculating.Stellar.circulatingPrevMonth = null;
    mockCoinGeckoAt(130);

    const result = await reconcileTrackedSupplyGaps([asset]);

    expect(result.totalReconciled).toBe(1);
    expect(asset.chainCirculating["XRP Ledger"]).toEqual({
      chainId: "xrpl", current: 30, circulatingPrevDay: null, circulatingPrevWeek: null, circulatingPrevMonth: null,
    });
    expect(asset.supplyGapFill?.withheldHistoricalBuckets).toEqual(["day", "week", "month"]);
    expect(asset.supplyGapFill?.withheldHistoricalBucketReasons).toEqual({
      day: "nonconserving", week: "history-unobserved", month: "history-unobserved",
    });
  });

  it.each([
    { scale: 1, discrepancy: 0.005, withheld: false },
    { scale: 1, discrepancy: 0.02, withheld: true },
    { scale: 1_000_000, discrepancy: 45, withheld: false },
    { scale: 1_000_000, discrepancy: 100, withheld: true },
  ])("uses the current conservation tolerance for historical scale $scale discrepancy $discrepancy", async ({ scale, discrepancy, withheld }) => {
    const nowMs = Date.now();
    const asset = makeAsset();
    for (const field of ["circulating", "circulatingPrevDay", "circulatingPrevWeek", "circulatingPrevMonth"] as const) {
      asset[field] = { peggedEUR: asset[field]!.peggedEUR * scale };
    }
    for (const row of Object.values(asset.chainCirculating)) {
      for (const field of ["current", "circulatingPrevDay", "circulatingPrevWeek", "circulatingPrevMonth"] as const) {
        row[field] = (row[field] as number) * scale;
      }
    }
    asset.chainCirculating.Ethereum.circulatingPrevDay = 54 * scale - discrepancy;
    mockCoinGeckoHistory([
      [nowMs - (30 * DAY_MS), 75 * scale],
      [nowMs - (7 * DAY_MS), 110 * scale],
      [nowMs - DAY_MS, 95 * scale],
      [nowMs, 130 * scale],
    ], 130 * scale);

    const result = await reconcileTrackedSupplyGaps([asset]);

    expect(result.totalReconciled).toBe(1);
    expect(asset.circulatingPrevDay).toEqual({ peggedEUR: 95 * scale });
    expect(asset.chainCirculating["XRP Ledger"].circulatingPrevDay).toBe(withheld ? null : 5 * scale);
    expect(asset.supplyGapFill?.withheldHistoricalBuckets).toEqual(withheld ? ["day"] : undefined);
    expect(asset.supplyGapFill?.withheldHistoricalBucketReasons).toEqual(withheld ? { day: "nonconserving" } : undefined);
  });

  it.each([
    { label: "below the entry ratio", current: 105, previous: false, filled: false, rejection: null },
    { label: "inside the entry band", current: 106, previous: false, filled: true, rejection: null },
    { label: "at the entry ceiling", current: 145, previous: false, filled: true, rejection: null },
    { label: "above the entry ceiling", current: 146, previous: false, filled: false, rejection: "ratio-out-of-band" },
    { label: "retained at the hard ceiling", current: 150, previous: true, filled: true, rejection: null },
    { label: "above the hard ceiling even when retained", current: 151, previous: true, filled: false, rejection: "ratio-out-of-band" },
    { label: "retained below entry by hysteresis", current: 104, previous: true, filled: true, rejection: null },
    { label: "released at the retain floor", current: 102, previous: true, filled: false, rejection: null },
  ] as const)("applies the DEC-01 band $label (CG $current vs DL 100)", async ({ current, previous, filled, rejection }) => {
    const asset = makeAsset();
    const before = structuredClone(asset);
    mockCoinGeckoAt(current);

    const result = await reconcileTrackedSupplyGaps([asset], undefined, null, undefined, undefined, previous ? previousGapFilled() : undefined);

    expect(result.totalReconciled).toBe(filled ? 1 : 0);
    if (filled) {
      expect(asset.circulating).toEqual({ peggedEUR: current });
      expect(asset.supplyGapFill).toMatchObject({ admission: previous ? "retained" : "entered", canonicalCurrentUsd: 100 });
    } else {
      // Out-of-bound or unproven contribution never enters; canonical DL facts remain untouched.
      expect(asset).toEqual(before);
    }
    expect(result.gapFillRejections).toEqual(rejection ? [{ id: asset.id, reason: rejection, ratio: current / 100 }] : []);
  });

  it("does not flap when the ratio oscillates around the entry threshold", async () => {
    let previous: Map<string, PeggedAsset> | undefined;
    const published: (number | null)[] = [];
    for (const current of [106, 104, 103, 104, 102, 104, 106]) {
      const asset = makeAsset();
      mockCoinGeckoAt(current);
      await reconcileTrackedSupplyGaps([asset], undefined, null, undefined, undefined, previous);
      published.push(getCirculatingRawOrNull(asset));
      previous = new Map([[asset.id, asset]]);
    }
    // Enter at 1.06, hold through 1.03-1.04, release at 1.02, stay DL at 1.04, re-enter only above 1.05.
    expect(published).toEqual([106, 104, 103, 104, 100, 100, 106]);
  });

  it("fails closed when a compared CoinGecko history bucket is missing or out of bound", async () => {
    const nowMs = Date.now();
    const missingMonth = makeAsset();
    const beforeMissing = structuredClone(missingMonth);
    mockCoinGeckoHistory([[nowMs - (7 * DAY_MS), 80], [nowMs - DAY_MS, 90], [nowMs, 130]]);
    const incomplete = await reconcileTrackedSupplyGaps([missingMonth]);
    expect(incomplete.totalReconciled).toBe(0);
    expect(missingMonth).toEqual(beforeMissing);
    expect(incomplete.gapFillRejections).toEqual([{ id: missingMonth.id, reason: "history-incomplete", ratio: 1.3 }]);

    const spikedWeek = makeAsset();
    const beforeSpiked = structuredClone(spikedWeek);
    mockCoinGeckoHistory([[nowMs - (30 * DAY_MS), 70], [nowMs - (7 * DAY_MS), 200], [nowMs - DAY_MS, 90], [nowMs, 130]]);
    const spiked = await reconcileTrackedSupplyGaps([spikedWeek]);
    expect(spiked.totalReconciled).toBe(0);
    expect(spikedWeek).toEqual(beforeSpiked);
    expect(spiked.gapFillRejections).toEqual([{ id: spikedWeek.id, reason: "history-ratio-above-bound", ratio: 1.3 }]);
  });

  it.each(["day", "week", "month"] as const)("rejects a %s history below the observed baseline before changing supply", async (bucket) => {
    const nowMs = Date.now();
    const asset = makeAsset();
    if (bucket === "week") asset.circulatingPrevWeek = { peggedEUR: 200 };
    const before = structuredClone(asset);
    mockCoinGeckoHistory([
      [nowMs - (30 * DAY_MS), bucket === "month" ? 1 : 70],
      [nowMs - (7 * DAY_MS), bucket === "week" ? 1 : 80],
      [nowMs - DAY_MS, bucket === "day" ? 1 : 90],
      [nowMs, 130],
    ]);

    const result = await reconcileTrackedSupplyGaps([asset]);

    expect(result.totalReconciled).toBe(0);
    expect(result.gapFillRejections).toEqual([{ id: asset.id, reason: "history-below-baseline", ratio: 1.3 }]);
    expect(asset).toEqual(before);
  });

  it("keeps a bucket DefiLlama did not observe absent instead of admitting an unbounded contribution", async () => {
    const asset = makeAsset();
    asset.circulatingPrevDay = {};
    mockCoinGeckoAt(130);

    const result = await reconcileTrackedSupplyGaps([asset]);

    expect(result.totalReconciled).toBe(1);
    expect(asset.circulatingPrevDay).toBeNull();
    expect(asset.circulatingPrevWeek).toEqual({ peggedEUR: 80 });
    expect(asset.chainCirculating?.["XRP Ledger"]).toEqual({ chainId: "xrpl", current: 30, circulatingPrevDay: null, circulatingPrevWeek: 0, circulatingPrevMonth: 0 });
    expect(asset.supplyGapFill?.withheldHistoricalBuckets).toEqual(["day"]);
    expect(asset.supplyGapFill?.withheldHistoricalBucketReasons).toEqual({ day: "history-unobserved" });
  });

  it("hydrates ordinary supplemental history but preserves every source-owned packet and provenance", async () => {
    const { db, sqlite } = fixtures.open();
    const original = makeAsset();
    original.circulatingPrevDay = null;
    mockCoinGeckoAt(130);
    await reconcileTrackedSupplyGaps([original]);
    const owned = [
      "coingecko-gap-fill", "defillama-history-gap-fill", "onchain-total-supply", "onchain-circulating-supply",
    ].map((supplySource) => ({
      ...makeAsset(), id: supplySource, supplySource,
      circulatingPrevDay: null, circulatingPrevWeek: null, circulatingPrevMonth: null,
    }));
    const provenanceOnly = {
      ...makeAsset(), id: "provenance-only", supplySource: undefined, supplyGapFill: original.supplyGapFill,
      circulatingPrevDay: null, circulatingPrevWeek: null, circulatingPrevMonth: null,
    };
    const ordinary = {
      ...makeAsset(), id: "ordinary", supplySource: "coingecko",
      circulatingPrevDay: null, circulatingPrevWeek: null, circulatingPrevMonth: { peggedEUR: 0 },
    };
    const assets = [...owned, provenanceOnly, ordinary];
    const now = new Date();
    for (const asset of assets) {
      for (const days of [1, 7, 30]) {
        const date = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days) / 1000;
        sqlite.prepare("INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd) VALUES (?, ?, ?)")
          .run(asset.id, date, 95);
      }
    }

    expect(await fillMissingSupplyHistory(db, assets)).toBe(2);
    for (const asset of [...owned, provenanceOnly]) {
      expect([asset.circulatingPrevDay, asset.circulatingPrevWeek, asset.circulatingPrevMonth]).toEqual([null, null, null]);
    }
    expect(ordinary).toMatchObject({
      circulatingPrevDay: { peggedEUR: 95 }, circulatingPrevWeek: { peggedEUR: 95 }, circulatingPrevMonth: { peggedEUR: 0 },
    });
    expect(provenanceOnly.supplyGapFill).toEqual(original.supplyGapFill);
    expect(provenanceOnly.supplyGapFill?.withheldHistoricalBuckets).toEqual(["day"]);
  });

  it("rejects conflicting chain attribution: an unavailable attributed chain or several missing chains", async () => {
    const unavailable = makeAsset();
    unavailable.chainCirculating.Stellar = { current: null, circulatingPrevDay: 9 };
    const beforeUnavailable = structuredClone(unavailable);
    mockCoinGeckoAt(130);
    const unavailableResult = await reconcileTrackedSupplyGaps([unavailable]);
    expect(unavailableResult.totalReconciled).toBe(0);
    expect(unavailable).toEqual(beforeUnavailable);
    expect(unavailableResult.gapFillRejections).toEqual([{ id: unavailable.id, reason: "baseline-mismatch", ratio: 1.3 }]);

    const twoMissing = makeAsset();
    delete twoMissing.chainCirculating.Stellar;
    twoMissing.circulating = { peggedEUR: 90 };
    const beforeTwoMissing = structuredClone(twoMissing);
    mockCoinGeckoAt(117);
    const twoMissingResult = await reconcileTrackedSupplyGaps([twoMissing]);
    expect(twoMissingResult.totalReconciled).toBe(0);
    expect(twoMissing).toEqual(beforeTwoMissing);
    expect(twoMissingResult.gapFillRejections).toEqual([{ id: twoMissing.id, reason: "multiple-missing-chains", ratio: 1.3 }]);
  });

  it.each([0, null, -1, "invalid"])("does not resurrect older positive supply past the latest dated value %s", async (latest) => {
    const nowMs = Date.now();
    const asset: PeggedAsset = {
      id: "tryb-bilira", name: "BiLira", symbol: "TRYB", supplySource: "defillama",
      circulating: { peggedTRY: 0 }, chainCirculating: {}, chains: [],
    };
    const before = structuredClone(asset);
    fetchTextWithRetryMock.mockResolvedValue({
      response: { ok: true },
      body: JSON.stringify([
        { date: nowMs - 30 * DAY_MS, totalCirculatingUSD: { peggedTRY: 14_800_000 } },
        { date: nowMs, totalCirculatingUSD: latest == null ? {} : { peggedTRY: latest } },
        { date: nowMs - 3600_000, totalCirculatingUSD: { peggedTRY: 15_260_000 } },
        { date: nowMs - 7 * DAY_MS, totalCirculatingUSD: { peggedTRY: 15_100_000 } },
        { date: nowMs - DAY_MS, totalCirculatingUSD: { peggedTRY: 15_220_000 } },
      ]),
    });

    const result = await reconcileTrackedSupplyGaps([asset]);

    expect(result.totalReconciled).toBe(0);
    expect(result.byReason["defillama-history-gap-fill"]).toBe(0);
    expect(asset).toEqual(before);
  });

  it("keeps curated on-chain fallback reachable when the latest chart point is explicit zero", async () => {
    const nowMs = Date.now();
    const asset: PeggedAsset = {
      id: "cadd-cad-digital", name: "CAD Digital", symbol: "CADD", supplySource: "defillama",
      circulating: { peggedCAD: 0 }, chainCirculating: {}, chains: [],
    };
    fetchTextWithRetryMock.mockResolvedValue({
      response: { ok: true },
      body: JSON.stringify([
        { date: nowMs, totalCirculatingUSD: { peggedCAD: 0 } },
        { date: nowMs - 3600_000, totalCirculatingUSD: { peggedCAD: 2_000_000 } },
        ...[1, 7, 30].map((days) => ({ date: nowMs - days * DAY_MS, totalCirculatingUSD: { peggedCAD: 2_000_000 } })),
      ]),
    });
    vi.mocked(fetchCuratedAggregateOnChainMcap).mockResolvedValue({
      mcap: 387_447.5, supplySource: "onchain-total-supply", observedAt: Math.floor(nowMs / 1000),
    });

    const result = await reconcileTrackedSupplyGaps([asset], undefined, null, undefined, { peggedCAD: 0.72 });

    expect(result.byReason).toMatchObject({ "defillama-history-gap-fill": 0, "onchain-total-supply": 1 });
    expect(asset).toMatchObject({
      circulating: { peggedCAD: 387_447.5 }, supplySource: "onchain-total-supply",
      circulatingPrevDay: null, circulatingPrevWeek: null, circulatingPrevMonth: null,
    });
  });

  it("restores zero-supply DefiLlama rows from complete chart history", async () => {
    const nowMs = Date.now();
    const asset: PeggedAsset = {
      id: "tryb-bilira",
      name: "BiLira",
      symbol: "TRYB",
      pegType: "peggedTRY",
      pegMechanism: "fiat-backed",
      supplySource: "defillama",
      circulating: { peggedTRY: 0 },
      circulatingPrevDay: { peggedTRY: 0 },
      circulatingPrevWeek: { peggedTRY: 0 },
      circulatingPrevMonth: { peggedTRY: 0 },
      chainCirculating: {},
      chains: ["BSC", "Ethereum"],
    };
    fetchTextWithRetryMock.mockResolvedValue({
      response: { ok: true },
      body: JSON.stringify([
        { date: Math.floor((nowMs - (30 * DAY_MS)) / 1000), totalCirculatingUSD: { peggedTRY: 14_800_000 } },
        { date: Math.floor((nowMs - (7 * DAY_MS)) / 1000), totalCirculatingUSD: { peggedTRY: 15_100_000 } },
        { date: Math.floor((nowMs - DAY_MS) / 1000), totalCirculatingUSD: { peggedTRY: 15_220_000 } },
        { date: Math.floor(nowMs / 1000), totalCirculatingUSD: { peggedTRY: 15_260_000 } },
      ]),
    });

    const result = await reconcileTrackedSupplyGaps([asset]);

    expect(result.totalReconciled).toBe(1);
    expect(asset).toMatchObject({
      supplySource: "defillama-history-gap-fill",
      circulating: { peggedTRY: 15_260_000 },
      circulatingPrevDay: { peggedTRY: 15_220_000 },
      circulatingPrevWeek: { peggedTRY: 15_100_000 },
      circulatingPrevMonth: { peggedTRY: 14_800_000 },
    });
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]).toMatchObject({
      id: "tryb-bilira",
      reason: "defillama-history-gap-fill",
      fromSource: "defillama",
      toValue: 15_260_000,
    });
    expect(result.assets[0].observedAt).toBeGreaterThanOrEqual(Math.floor(nowMs / 1000) - 1);
    expect(result.assets[0].observedAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    expect(result.assets[0].observedAgeSec).toBeLessThanOrEqual(2);
    expect(asset.supplyObservedAt).toBe(result.assets[0].observedAt);
  });

  it("repairs curated zero-supply Mento rows from on-chain aggregate probes", async () => {
    const makeZeroAsset = (
      id: string,
      name: string,
      symbol: string,
      pegType: string,
      chains: string[],
    ): PeggedAsset => ({
      id,
      name,
      symbol,
      pegType,
      pegMechanism: "crypto-backed",
      supplySource: "defillama",
      circulating: { [pegType]: 0 },
      circulatingPrevDay: { [pegType]: 0 },
      circulatingPrevWeek: { [pegType]: 0 },
      circulatingPrevMonth: { [pegType]: 0 },
      chainCirculating: {},
      chains,
    });
    const assets = [
      makeZeroAsset("cadd-cad-digital", "CAD Digital", "CADD", "peggedCAD", ["Ethereum", "Base"]),
      makeZeroAsset("jpym-mento", "Mento Japanese Yen", "JPYm", "peggedCHF", ["Celo"]),
      makeZeroAsset("zarm-mento", "Mento South African Rand", "ZARm", "peggedZAR", ["Celo"]),
      makeZeroAsset("xofm-mento", "Mento West African CFA Franc", "XOFm", "peggedXOF", ["Celo"]),
    ];
    const onchainById: Record<string, {
      mcap: number;
      supplySource: "onchain-total-supply";
      observedAt?: number | null;
      chainCirculating?: Record<string, { current: number; chainId?: string }>;
    }> = {
      "cadd-cad-digital": {
        mcap: 387_447.5,
        supplySource: "onchain-total-supply",
        observedAt: 1_789_968_296,
        chainCirculating: {
          Ethereum: { current: 197_574.5, chainId: "ethereum" },
          Base: { current: 189_873, chainId: "base" },
        },
      },
      "jpym-mento": {
        mcap: 103_627.12712522845,
        supplySource: "onchain-total-supply",
        chainCirculating: { Celo: { current: 103_627.12712522845, chainId: "celo" } },
      },
      "zarm-mento": {
        mcap: 8_598.7022994136,
        supplySource: "onchain-total-supply",
        chainCirculating: { Celo: { current: 8_598.7022994136, chainId: "celo" } },
      },
      "xofm-mento": {
        mcap: 33_000.819008033395,
        supplySource: "onchain-total-supply",
        chainCirculating: { Celo: { current: 33_000.819008033395, chainId: "celo" } },
      },
    };
    vi.mocked(fetchCuratedAggregateOnChainMcap).mockImplementation(async (meta) =>
      onchainById[String(meta.id)] ?? null,
    );
    fetchTextWithRetryMock.mockResolvedValue({
      response: { ok: true },
      body: JSON.stringify([]),
    });

    const result = await reconcileTrackedSupplyGaps(
      assets,
      undefined,
      undefined,
      undefined,
      {
        peggedCAD: 0.73,
        peggedJPY: 0.00628,
        peggedZAR: 0.0608,
        peggedXOF: 0.00172,
      },
    );

    expect(result.totalReconciled).toBe(4);
    expect(
      vi.mocked(fetchCuratedAggregateOnChainMcap).mock.calls.map(([meta, priceUsd]) => [
        String(meta.id),
        priceUsd,
      ]),
    ).toEqual([
      ["cadd-cad-digital", 0.73],
      ["jpym-mento", 0.00628],
      ["zarm-mento", 0.0608],
      ["xofm-mento", 0.00172],
    ]);
    expect(result.assets).toEqual([
      {
        id: "cadd-cad-digital",
        reason: "onchain-total-supply",
        fromSource: "defillama",
        toValue: 387_447.5,
        observedAt: 1_789_968_296,
        observedAgeSec: expect.any(Number),
      },
      { id: "jpym-mento", reason: "onchain-total-supply", fromSource: "defillama", toValue: 103_627.12712522845, observedAt: null, observedAgeSec: null },
      { id: "zarm-mento", reason: "onchain-total-supply", fromSource: "defillama", toValue: 8_598.7022994136, observedAt: null, observedAgeSec: null },
      { id: "xofm-mento", reason: "onchain-total-supply", fromSource: "defillama", toValue: 33_000.819008033395, observedAt: null, observedAgeSec: null },
    ]);
    const byId = new Map(assets.map((asset) => [asset.id, asset]));
    expect(byId.get("cadd-cad-digital")).toMatchObject({
      supplySource: "onchain-total-supply",
      supplyObservedAt: 1_789_968_296,
      circulating: { peggedCAD: 387_447.5 },
      chainCirculating: {
        Ethereum: { current: 197_574.5, chainId: "ethereum" },
        Base: { current: 189_873, chainId: "base" },
      },
    });
    expect(byId.get("jpym-mento")).toMatchObject({
      supplySource: "onchain-total-supply",
      circulating: { peggedJPY: 103_627.12712522845 },
    });
    const jpymCirculating = byId.get("jpym-mento")?.circulating;
    expect(jpymCirculating?.peggedCHF).toBeUndefined();
    expect(byId.get("zarm-mento")).toMatchObject({
      supplySource: "onchain-total-supply",
      circulating: { peggedZAR: 8_598.7022994136 },
    });
    expect(byId.get("xofm-mento")).toMatchObject({
      supplySource: "onchain-total-supply",
      circulating: { peggedXOF: 33_000.819008033395 },
      chainCirculating: { Celo: { current: 33_000.819008033395, chainId: "celo" } },
    });
  });

  it("does not par-value a NAV token when chart history is unavailable", async () => {
    const asset: PeggedAsset = {
      id: "fpi-frax",
      name: "Frax Price Index",
      symbol: "FPI",
      pegType: "peggedVAR",
      supplySource: "defillama",
      circulating: { peggedVAR: 0 },
      circulatingPrevDay: { peggedVAR: 0 },
      circulatingPrevWeek: { peggedVAR: 0 },
      circulatingPrevMonth: { peggedVAR: 0 },
      chainCirculating: {},
      chains: ["Ethereum"],
    };
    const before = structuredClone(asset);
    fetchTextWithRetryMock.mockResolvedValue({
      response: { ok: true },
      body: JSON.stringify([]),
    });

    const result = await reconcileTrackedSupplyGaps([asset]);

    expect(result.totalReconciled).toBe(0);
    expect(fetchCuratedAggregateOnChainMcap).not.toHaveBeenCalled();
    expect(asset).toEqual(before);
  });

  it("does not select a stale CoinGecko gate observation as a candidate", async () => {
    const nowMs = Date.now();
    const asset = makeAsset();
    const before = structuredClone(asset);
    mockCoinGeckoHistory(
      [
        [nowMs - (30 * DAY_MS), 65],
        [nowMs - (7 * DAY_MS), 110],
        [nowMs - DAY_MS, 85],
        [nowMs, 130],
      ],
      130,
      Math.floor((nowMs - (3 * DAY_MS)) / 1000),
    );

    const result = await reconcileTrackedSupplyGaps([asset]);

    expect(result.totalReconciled).toBe(0);
    expect(fetchTextWithRetryMock).toHaveBeenCalledTimes(1);
    expect(asset).toEqual(before);
  });

  it("stamps a bounded but aged chart point instead of publishing it as current", async () => {
    const nowMs = Date.now();
    const asset = makeAsset();
    const pointMs = nowMs - (47 * 60 * 60 * 1000);
    mockCoinGeckoHistory([
      [pointMs - (23 * 60 * 60 * 1000), 140],
      [pointMs - (5 * DAY_MS), 120],
      [pointMs - (28 * DAY_MS), 80],
      [pointMs, 130],
    ]);

    const result = await reconcileTrackedSupplyGaps([asset]);

    expect(result.totalReconciled).toBe(1);
    expect(result.assets[0].observedAt).toBe(Math.floor(pointMs / 1000));
    expect(result.assets[0].observedAgeSec).toBeGreaterThanOrEqual(47 * 60 * 60);
    expect(asset.supplyObservedAt).toBe(Math.floor(pointMs / 1000));
  });

  it("withholds publication when the only current chart point exceeds the age bound", async () => {
    const nowMs = Date.now();
    const asset = makeAsset();
    const before = structuredClone(asset);
    mockCoinGeckoHistory([
      [nowMs - (49 * 60 * 60 * 1000), 130],
      [nowMs - (3 * DAY_MS), 140],
      [nowMs - (9 * DAY_MS), 120],
      [nowMs - (30 * DAY_MS), 80],
    ]);

    const result = await reconcileTrackedSupplyGaps([asset]);

    expect(result.totalReconciled).toBe(0);
    expect(asset).toEqual(before);
  });

  it("quarantines malformed chart points without aborting the candidate", async () => {
    const nowMs = Date.now();
    const asset = makeAsset();

    fetchTextWithRetryMock.mockImplementation((url: string) => ({
      response: { ok: true },
      body: JSON.stringify(url.includes("/simple/price")
        ? { "societe-generale-forge-eurcv": { usd_market_cap: 130, last_updated_at: Math.floor(nowMs / 1000) } }
        : {
          market_caps: [
            null,
            {},
            [nowMs - (30 * DAY_MS)],
            [nowMs - (30 * DAY_MS), 75],
            [nowMs - (7 * DAY_MS), 110],
            [nowMs - DAY_MS, 95],
            [nowMs, 130],
            [nowMs, "not-a-number"],
          ],
        }),
    }));

    const result = await reconcileTrackedSupplyGaps([asset]);

    expect(result.totalReconciled).toBe(1);
    expect(asset.supplySource).toBe("coingecko-gap-fill");
    expect(asset.circulating).toEqual({ peggedEUR: 130 });
  });

  it("surfaces a gap-fill baseline mismatch with both totals instead of dropping it silently", async () => {
    const nowMs = Date.now();
    const asset = makeAsset();
    asset.chainCirculating = {
      Ethereum: { current: 60, circulatingPrevDay: 54, circulatingPrevWeek: 48, circulatingPrevMonth: 42 },
      Solana: { current: 30, circulatingPrevDay: 27, circulatingPrevWeek: 24, circulatingPrevMonth: 21 },
      Stellar: { current: 10, circulatingPrevDay: 9, circulatingPrevWeek: 8, circulatingPrevMonth: 7 },
      Notaland: { current: 1, circulatingPrevDay: 1, circulatingPrevWeek: 1, circulatingPrevMonth: 1 },
    };
    const before = structuredClone(asset);
    mockCoinGeckoHistory([
      [nowMs - (30 * DAY_MS), 65],
      [nowMs - (7 * DAY_MS), 110],
      [nowMs - DAY_MS, 85],
      [nowMs, 130],
    ]);

    const result = await reconcileTrackedSupplyGaps([asset]);

    expect(result.totalReconciled).toBe(0);
    expect(result.baselineMismatches).toEqual([{
      id: asset.id,
      expectedCurrent: 100,
      attributedCurrent: 100,
      tolerance: Math.max(0.01, 100 * 1e-6),
      droppedRows: 1,
      droppedChainIds: ["Notaland"],
    }]);
    expect(asset).toEqual(before);
  });
});
