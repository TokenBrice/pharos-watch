import { buildAmmCapacityCurve } from "@shared/lib/p4-exit-route-amm-simulation";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import {
  CURVE_NAV_SPOT_QUOTE_POLICY_ID,
  admitCurveStableswapNgNavCandidates,
  enrichCurveStableswapRateInputExecutionModels,
  quoteCurveStableswapNgSpotUsd,
  refreshCurveStableswapNgNavPrices,
  simulateCurveStableswapNgGetDy,
} from "../curve-stableswap-rates";
import {
  hasIndependentNavMarkLineage,
  validateClockedCurveNavObservation,
} from "../scoring-helpers";
import { initSourcePoolGraph } from "../pool-helpers";
import { computeStablecoinScores } from "../scoring";
import { computeDexPrices } from "../dex-price-publisher";
import type { DexPriceObs, PoolEntry } from "../types";
import { seedGeneration } from "../../measured-execution/__tests__/persistence.test-support";
import { readPublicPriceRows, seedPublishedDexGeneration } from "./scoring-test-support";
import {
  CURVE_BLOCK_HASH,
  CURVE_BLOCK_NUMBER,
  CURVE_BLOCK_TIMESTAMP,
  CURVE_CANDIDATE,
  CURVE_CORR_POOL,
  CURVE_FRXUSD,
  CURVE_GEN,
  CURVE_MIXED_DEC_COINS,
  CURVE_NG_8COIN_OVERFLOW_VECTOR,
  CURVE_NG_CORROBORATION_SPECS,
  CURVE_NG_GATE_CASES,
  CURVE_NG_PARITY_VECTORS,
  CURVE_NG_REJECTION_SPECS,
  CURVE_NG_STUSDS_BAL,
  CURVE_NG_STUSDS_RATES,
  CURVE_PINNED_RATES,
  CURVE_POOL,
  CURVE_SFRXUSD,
  CURVE_STUSDS,
  CURVE_STUSDS_CANDIDATE,
  CURVE_STUSDS_POOL,
  CURVE_USDS,
  encodeCurveNgMulticallResults,
  makeClockedCurveNavPool,
  makeCurveNgCapState,
  makeCurveNgNavPool,
  makeCurveNgPoolEntry,
  makeDexValuationPrices,
  makeStusdsMeasuredCorroboratorPacket,
  type CurveNgMulticallInput,
} from "./fixtures/curve-stableswap-ng-fixtures";

function makeCurveNgDeps(
  input: CurveNgMulticallInput & {
    header?: { timestamp: number; hash: `0x${string}` };
    confirmedHeader?: { timestamp: number; hash: `0x${string}` };
    multicallFails?: boolean;
    onConfirmedHeader?: () => void;
  } = {},
) {
  const header = {
    number: CURVE_BLOCK_NUMBER,
    timestamp: input.header?.timestamp ?? CURVE_BLOCK_TIMESTAMP,
    hash: input.header?.hash ?? CURVE_BLOCK_HASH,
  };
  const confirmed = {
    number: CURVE_BLOCK_NUMBER,
    timestamp: input.confirmedHeader?.timestamp ?? header.timestamp,
    hash: input.confirmedHeader?.hash ?? header.hash,
  };
  let headerCalls = 0;
  return {
    fetchBlockNumber: vi.fn().mockResolvedValue(CURVE_BLOCK_NUMBER),
    fetchBlockHeader: vi.fn(async () => {
      if (headerCalls++ === 0) return header;
      input.onConfirmedHeader?.();
      return confirmed;
    }),
    fetchMulticall: vi.fn(async (_chain: string, calls: readonly { label: string }[]) =>
      input.multicallFails ? null : encodeCurveNgMulticallResults(calls, input),
    ),
  };
}

function makeCurveNgMetrics(pool = makeCurveNgPoolEntry(), id = "frxusd-frax", symbol = "frxUSD") {
  const metric = initSourcePoolGraph(id, symbol);
  metric.pools.push(pool);
  return new Map([[metric.stablecoinId, metric]]);
}

function runCurveNgCapture(
  pool: PoolEntry,
  state = makeCurveNgDeps(),
  nowSec: number | (() => number) = CURVE_BLOCK_TIMESTAMP + 60,
  chainAddressToId = new Map([[`ethereum:${CURVE_FRXUSD}`, "frxusd-frax"]]),
) {
  return enrichCurveStableswapRateInputExecutionModels({
    sourceGenerationId: CURVE_GEN,
    metrics: makeCurveNgMetrics(pool),
    chainAddressToId,
    chainRpcs: new Map([["ethereum", {} as never]]),
    ...(typeof nowSec === "function" ? { getNowSec: nowSec } : { nowSec }),
    dependencies: state as never,
  });
}

const openDatabases: DatabaseSync[] = [];
afterEach(() => {
  for (const sqlite of openDatabases.splice(0)) {
    sqlite.close();
  }
});

describe("Curve StableSwap-NG rate-input state capture", () => {
  it("builds scaled (untracked-leg) and base-only models with full invariants", async () => {
    const state = makeCurveNgDeps();
    const pool = makeCurveNgPoolEntry();
    await runCurveNgCapture(pool, state);
    expect(state.fetchMulticall).toHaveBeenCalledWith(
      "ethereum",
      expect.arrayContaining(
        ["balances", "rates", "A", "fee", "offpeg-fee-multiplier", "coin-0", "coin-1"]
          .map((suffix) => expect.objectContaining({ label: `curve-rate-0-${suffix}`, target: CURVE_POOL })),
      ),
      CURVE_BLOCK_NUMBER,
      expect.any(Object),
    );
    expect(state.fetchBlockHeader).toHaveBeenCalledTimes(2);
    expect(pool.extra?.curveStableswapRateInputExecutionCandidate).toBeUndefined();
    expect(pool.extra?.curveStableswapPlainAdmissionDiagnostic).toBeUndefined();
    expect(pool.extra?.executionCapabilityGate).toBeUndefined();
    expect(pool.extra?.measurement).toMatchObject({ balanceMeasured: true });
    const scaled = pool.extra?.ammExecutionModel;
    expect(scaled).toMatchObject({
      source: "curve",
      invariant: "stableswap",
      trackedTokenIndex: 1,
      amplification: 5_000,
      feeRate: 0.0001,
      capture: {
        blockNumber: CURVE_BLOCK_NUMBER,
        blockHash: CURVE_BLOCK_HASH,
        blockTimestamp: CURVE_BLOCK_TIMESTAMP,
        sourceGenerationId: CURVE_GEN,
      },
      tokens: [
        { address: CURVE_SFRXUSD, symbol: "sfrxUSD" },
        { address: CURVE_FRXUSD, symbol: "frxUSD", trackedAssetId: "frxusd-frax" },
      ],
    });
    expect(scaled?.tokens[0]?.balance).toBeCloseTo(7_494_946.662615514, 6);
    expect(scaled?.tokens[0]?.referencePriceUsd).toBeCloseTo(1.0001571973088703, 12);
    expect(scaled?.tokens[1]?.balance).toBeCloseTo(4_346_120.891108167, 6);
    expect(scaled?.tokens[1]?.referencePriceUsd).toBeCloseTo(1.000155068994295, 12);

    const plain = makeCurveNgPoolEntry();
    await runCurveNgCapture(plain, makeCurveNgDeps({ rates: [10n ** 18n, 10n ** 18n] }));
    expect(plain.extra?.executionCapabilityGate).toBeUndefined();
    expect(plain.extra?.curveStableswapRateInputExecutionCandidate).toBeUndefined();
    expect(plain.extra?.measurement).toMatchObject({ balanceMeasured: true });
    expect(plain.extra?.ammExecutionModel).toMatchObject({
      source: "curve",
      invariant: "stableswap",
      trackedTokenIndex: 1,
      amplification: 5_000,
      feeRate: 0.0001,
      tokens: [
        { address: CURVE_SFRXUSD, symbol: "sfrxUSD", referencePriceUsd: 1.2038465312792253 },
        { address: CURVE_FRXUSD, symbol: "frxUSD", trackedAssetId: "frxusd-frax" },
      ],
    });
    expect(plain.extra?.ammExecutionModel?.tokens[0]?.balance).toBeCloseTo(6_226_811.020583753, 6);
    expect(plain.extra?.ammExecutionModel?.tokens[1]?.balance).toBeCloseTo(4_346_120.891108167, 6);
    expect(plain.extra?.ammExecutionModel?.tokens[1]?.referencePriceUsd).toBeCloseTo(1.000155068994295, 12);
    expect(plain.extra?.curveStableswapPlainAdmissionDiagnostic).toMatchObject({
      stablecoinId: "frxusd-frax",
      chain: "ethereum",
      poolId: `ethereum:${CURVE_POOL}`,
      poolAddress: CURVE_POOL,
    });
    expect(plain.extra?.curveStableswapPlainAdmissionDiagnostic?.sourcePriceSpreadRatio)
      .toBeCloseTo(1.2036598809520127, 12);
  });

  it("admits mixed-decimal base-only pool (6/2/6) and dynamic/static off-peg fee bounds", async () => {
    const [eurc, eurs, eurq] = CURVE_MIXED_DEC_COINS;
    const mixed = makeCurveNgPoolEntry({
      curveStableswapRateInputExecutionCandidate: {
        poolAddress: CURVE_POOL,
        coins: [...CURVE_MIXED_DEC_COINS],
      },
    });
    await enrichCurveStableswapRateInputExecutionModels({
      sourceGenerationId: CURVE_GEN,
      metrics: makeCurveNgMetrics(mixed, "eurs-stasis", "EURS"),
      chainAddressToId: new Map([[`ethereum:${eurs.address}`, "eurs-stasis"]]),
      chainRpcs: new Map([["ethereum", {} as never]]),
      nowSec: CURVE_BLOCK_TIMESTAMP + 60,
      dependencies: makeCurveNgDeps({
        balances: [4_000_000_000_000n, 300_000_000n, 5_000_000_000_000n],
        rates: [10n ** 30n, 10n ** 34n, 10n ** 30n],
        coinAddresses: [eurc.address, eurs.address, eurq.address],
      }) as never,
    });
    expect(mixed.extra?.executionCapabilityGate).toBeUndefined();
    expect(mixed.extra?.ammExecutionModel?.trackedTokenIndex).toBe(1);
    expect(mixed.extra?.ammExecutionModel?.tokens.map((t) => t.balance)).toEqual([4_000_000, 3_000_000, 5_000_000]);
    expect(mixed.extra?.ammExecutionModel?.tokens.map((t) => t.referencePriceUsd)).toEqual([1.1166, 1.1488, 1.0775]);
    expect(mixed.extra?.curveStableswapPlainAdmissionDiagnostic).toMatchObject({
      stablecoinId: "eurs-stasis",
      poolAddress: CURVE_POOL,
    });
    expect(mixed.extra?.curveStableswapPlainAdmissionDiagnostic?.sourcePriceSpreadRatio)
      .toBeCloseTo(1.1488 / 1.0775, 12);

    const dyn = makeCurveNgPoolEntry({
      curveStableswapRateInputExecutionCandidate: {
        ...CURVE_CANDIDATE,
        coins: CURVE_CANDIDATE.coins.map((c) => ({ ...c, referencePriceUsd: 1 })),
      },
    });
    await runCurveNgCapture(dyn, makeCurveNgDeps({ offpegFeeMultiplier: 20_000_000_000n }));
    expect(dyn.extra?.executionCapabilityGate).toBeUndefined();
    expect(dyn.extra?.ammExecutionModel?.feeRate).toBeCloseTo(0.0002, 12);
    expect(dyn.extra?.ammExecutionModel?.tokens[0]?.referencePriceUsd)
      .toBeCloseTo(1 / (Number(CURVE_PINNED_RATES[0]!) / 1e18), 12);

    const stat = makeCurveNgPoolEntry();
    await runCurveNgCapture(stat, makeCurveNgDeps({ offpegFeeMultiplier: 0n }));
    expect(stat.extra?.executionCapabilityGate).toBeUndefined();
    expect(stat.extra?.ammExecutionModel?.feeRate).toBeCloseTo(0.0001, 12);
  });

  it("stamps captureEvaluatedAtSec post-confirmed-header per chain and enforces zero future skew", async () => {
    let clock = CURVE_BLOCK_TIMESTAMP - 5;
    const postHeader = CURVE_BLOCK_TIMESTAMP + 2;
    const pool = makeCurveNgPoolEntry();
    const captured = await runCurveNgCapture(
      pool,
      makeCurveNgDeps({
        onConfirmedHeader: () => {
          clock = postHeader;
        },
      }),
      () => clock,
    );
    expect(captured.get(pool)?.captureEvaluatedAtSec).toBe(postHeader);

    const futurePool = makeCurveNgPoolEntry();
    const withheld = await runCurveNgCapture(
      futurePool,
      makeCurveNgDeps({ header: { timestamp: postHeader + 1, hash: CURVE_BLOCK_HASH } }),
      () => postHeader,
    );
    expect(withheld.has(futurePool)).toBe(false);
  });

  it.each(CURVE_NG_GATE_CASES)(
    "gates %s as %s with zero captured quote state",
    async (_label, depInput, reason, nowSec, multicalls, headerCalls) => {
      const state = makeCurveNgDeps(depInput);
      const pool = makeCurveNgPoolEntry();
      expect((await runCurveNgCapture(pool, state, nowSec)).size).toBe(0);
      expect(state.fetchMulticall).toHaveBeenCalledTimes(multicalls);
      expect(state.fetchBlockHeader).toHaveBeenCalledTimes(headerCalls);
      expect(pool.extra?.ammExecutionModel).toBeUndefined();
      expect(pool.extra?.curveStableswapPlainAdmissionDiagnostic).toBeUndefined();
      expect(pool.extra?.curveStableswapRateInputExecutionCandidate).toBeUndefined();
      expect(pool.extra?.executionCapabilityGate).toEqual({ family: "curve-stableswap", reason });
    },
  );

  it("checks Monad Lite factory membership, layout and independent marks at the pinned reserve block", async () => {
    const poolAddress = "0xd665caad68acb093aff27ec6c71ccc4f29c28147";
    const ausd = "0x00000000efe302beaa2b3e6e1b18d08d69a9012a";
    const trusd = "0x770a579ea200784723b31b8668b0773ba80393c9";
    const implementation = "0xfc687efafed297b765edecf8179c32195597c2df";
    const addresses = new Map([[`monad:${ausd}`, "ausd-agora"], [`monad:${trusd}`, "trusd-tori"]]);
    const coins = [
      { address: ausd, symbol: "AUSD", decimals: 6, referencePriceUsd: 0.99 },
      { address: trusd, symbol: "trUSD", decimals: 18, referencePriceUsd: 0.98 },
    ] as const;
    // Monad block 126118536, 2026-11-28 10:03:41 UTC.
    const pinned = {
      balances: [68_217_382_817n, 269_746_505_891_626_352_315_676n],
      rates: [10n ** 30n, 10n ** 18n], amplification: 1000n, fee: 1_000_000n, offpegFeeMultiplier: 100_000_000_000n,
    };
    for (const failure of [null, "rest-unpriced", "pool", "factory", "order", "decimals", "unpriced", "same-pool"] as const) {
      const pool = makeCurveNgPoolEntry({
        measurement: { balanceMeasured: failure !== "rest-unpriced" },
        ...(failure === "rest-unpriced" ? {} : { balanceRatio: 0.26 }),
        curveStableswapRateInputExecutionCandidate: { poolAddress, coins: failure === "rest-unpriced"
          ? coins.map(({ address, symbol, decimals }) => ({ address, symbol, decimals })) : [...coins] },
      }, { chain: "Monad", poolId: `monad:${failure === "pool" ? CURVE_POOL : poolAddress}` });
      const state = makeCurveNgDeps({
        ...pinned,
        coinAddresses: failure === "order" ? [trusd, ausd] : [ausd, trusd],
        liteFactory: { implementation: failure === "factory" ? CURVE_POOL : implementation, decimals: failure === "decimals" ? [18n, 6n] : [6n, 18n] },
      });
      const marks = makeDexValuationPrices([
        ["trusd-tori", { priceUsd: 0.9970049453539112, observedAtSec: CURVE_BLOCK_TIMESTAMP, source: "coingecko" }],
        ["ausd-agora", { priceUsd: 0.9993937256952568, observedAtSec: CURVE_BLOCK_TIMESTAMP, source: "coingecko",
          ...(failure === "same-pool" ? { pricePoolKeys: [pool.poolId] } : {}) }],
      ]);
      await enrichCurveStableswapRateInputExecutionModels({
        metrics: makeCurveNgMetrics(pool, "trusd-tori", "trUSD"), chainAddressToId: addresses,
        stablecoinPriceById: failure === "unpriced" ? undefined : marks,
        sourceGenerationId: CURVE_GEN, nowSec: CURVE_BLOCK_TIMESTAMP,
        chainRpcs: new Map([["monad", {} as never]]), dependencies: state as never,
      });
      expect(pool.extra?.measurement?.balanceMeasured).toBe(failure !== "rest-unpriced");
      if (failure && failure !== "rest-unpriced") {
        const reasons = {
          pool: "exact-pool-join-unresolved", factory: "deployment-code-mismatch",
          order: "ambiguous-token-identity", decimals: "ambiguous-token-identity",
          unpriced: "reference-price-unavailable", "same-pool": "reference-price-unavailable",
        };
        expect(pool.extra?.executionCapabilityGate?.reason).toBe(reasons[failure]);
        expect(pool.extra?.ammExecutionModel).toBeUndefined();
      } else {
        const model = pool.extra!.ammExecutionModel!;
        expect(model.tokens.map((t) => t.referencePriceSource)).toEqual(["tracked-market", "tracked-market"]);
        expect(simulateCurveStableswapNgGetDy({ ...pinned, i: 1, j: 0, dx: 10_000n * 10n ** 18n })?.dy).toBe(9_964_602_793n);
        if (model.source !== "curve") throw new Error("expected a pinned Curve reserve model");
        const curve = buildAmmCapacityCurve(model, 0);
        const capacity = curve[curve.length - 1]!.executableUsd;
        expect(capacity).toBeGreaterThan(59_000);
        // At the frozen marks, contract get_dy accepts 60,424 trUSD and exceeds 2% at 60,425.
        expect(capacity).toBeLessThanOrEqual(60_424 * model.tokens[1]!.referencePriceUsd);
      }
    }
  });

  it("does not replace an existing score-facing measured route", async () => {
    const state = makeCurveNgDeps();
    const pool = makeCurveNgPoolEntry({ measuredExecution: {} as never });
    expect((await runCurveNgCapture(pool, state)).size).toBe(0);
    expect(state.fetchBlockNumber).not.toHaveBeenCalled();
    expect(pool.extra?.curveStableswapRateInputExecutionCandidate).toBeUndefined();
    expect(pool.extra?.executionCapabilityGate).toEqual({
      family: "curve-stableswap",
      reason: "incomplete-exact-capture",
    });
  });
});

describe("StableSwap-NG exact get_dy parity (live Ethereum pinned blocks)", () => {
  it.each(CURVE_NG_PARITY_VECTORS)(
    "0-wei on-chain parity (%s)",
    (_label, balances, rates, amplification, fee, offpegFeeMultiplier, i, j, dx, expected) => {
      expect(
        simulateCurveStableswapNgGetDy({
          balances,
          rates,
          amplification,
          fee,
          offpegFeeMultiplier,
          i,
          j,
          dx,
        })?.dy,
      ).toBe(expected);
    },
  );

  it("fails closed on invalid inputs and Vyper checked uint256 overflow", () => {
    const base = {
      balances: CURVE_NG_STUSDS_BAL,
      rates: CURVE_NG_STUSDS_RATES,
      amplification: 100n,
      fee: 1_000_000n,
      offpegFeeMultiplier: 10n ** 10n,
      i: 0,
      j: 1,
      dx: 10n ** 18n,
    };
    expect(simulateCurveStableswapNgGetDy({ ...base, j: 0 })).toBeNull();
    expect(simulateCurveStableswapNgGetDy({ ...base, fee: 10n ** 10n })).toBeNull();
    expect(simulateCurveStableswapNgGetDy({ ...base, balances: [0n, 10n ** 18n] })).toBeNull();
    expect(simulateCurveStableswapNgGetDy(CURVE_NG_8COIN_OVERFLOW_VECTOR)).toBeNull();
  });
});

describe("refreshCurveStableswapNgNavPrices and scoring-stage corroboration", () => {
  const NOW = CURVE_BLOCK_TIMESTAMP + 120;
  const CORR_ID = `ethereum:${CURVE_CORR_POOL}`;

  it("emits clocked sole-venue quote with zero extra RPCs, untouched priceMeasured, and isolated siblings", async () => {
    const dep = makeCurveNgDeps({
      balances: CURVE_NG_STUSDS_BAL,
      rates: CURVE_NG_STUSDS_RATES,
      amplification: 500n,
      fee: 10_000_000n,
      offpegFeeMultiplier: 50_000_000_000n,
      coinAddresses: [CURVE_USDS, CURVE_STUSDS],
    });
    const candExtra = {
      executionCapabilityGate: { family: "curve-stableswap" as const, reason: "incomplete-exact-capture" as const },
      curveStableswapRateInputExecutionCandidate: CURVE_STUSDS_CANDIDATE,
      measurement: { balanceMeasured: true, priceMeasured: false },
    };
    const navPool = makeCurveNgNavPool(NOW, { extra: { ...candExtra } });
    const siblingPool = makeCurveNgNavPool(NOW, { extra: { ...candExtra } });
    const uncapturedPool = makeCurveNgNavPool(NOW, {
      poolId: "ethereum:0x9999999999999999999999999999999999999999",
      price: 1.02,
      priceObservedAt: null,
    });
    const graph = new Map([
      ["stusds-sky", { stablecoinId: "stusds-sky", symbol: "stUSDS", pools: [navPool] }],
      ["usds-sky", { stablecoinId: "usds-sky", symbol: "USDS", pools: [siblingPool] }],
      ["susdat-saturn", { stablecoinId: "susdat-saturn", symbol: "sUSDat", pools: [uncapturedPool] }],
    ]);
    const captured = await enrichCurveStableswapRateInputExecutionModels({
      sourceGenerationId: CURVE_GEN,
      metrics: graph,
      chainAddressToId: new Map([
        [`ethereum:${CURVE_USDS}`, "usds-sky"],
        [`ethereum:${CURVE_STUSDS}`, "stusds-sky"],
      ]),
      chainRpcs: new Map([["ethereum", {} as never]]),
      nowSec: CURVE_BLOCK_TIMESTAMP + 60,
      dependencies: dep as never,
    });
    expect([
      dep.fetchBlockNumber.mock.calls.length,
      dep.fetchBlockHeader.mock.calls.length,
      dep.fetchMulticall.mock.calls.length,
    ]).toEqual([1, 2, 1]);

    for (const [markTs, clock] of [
      [CURVE_BLOCK_TIMESTAMP - 400, CURVE_BLOCK_TIMESTAMP - 400],
      [CURVE_BLOCK_TIMESTAMP + 30, CURVE_BLOCK_TIMESTAMP],
    ] as const) {
      const prices = makeDexValuationPrices([
        ["usds-sky", { priceUsd: 0.9998, observedAtSec: markTs, observedAtMode: "upstream", source: "kraken" }],
      ]);
      expect(refreshCurveStableswapNgNavPrices({
        metrics: graph,
        capturedPools: captured,
        sourceGenerationId: CURVE_GEN,
        stablecoinPriceById: prices,
        registryEvaluatedAtSec: NOW,
        nowSec: NOW,
      })).toMatchObject({
        policyId: CURVE_NAV_SPOT_QUOTE_POLICY_ID,
        evaluatedPools: 1,
        admittedPools: 1,
        admittedSoleVenue: 1,
        admittedCorroborated: 0,
      });
      expect(navPool).toMatchObject({
        priceObservedAt: clock,
        priceSource: "direct_api",
        priceCounterparty: {
          stablecoinId: "usds-sky",
          priceUsd: 0.9998,
          observedAtSec: markTs,
          observedAtMode: "upstream",
          source: "kraken",
        },
        curveNavSpotQuote: {
          policyId: CURVE_NAV_SPOT_QUOTE_POLICY_ID,
          poolId: navPool.poolId,
          blockNumber: CURVE_BLOCK_NUMBER,
          blockHash: CURVE_BLOCK_HASH,
          poolRatioObservedAt: CURVE_BLOCK_TIMESTAMP,
          quoteMarkObservedAt: markTs,
          sourceGenerationId: CURVE_GEN,
          admissionMode: "sole-venue",
        },
      });
    }
    const quoted = quoteCurveStableswapNgSpotUsd({
      state: captured.get(navPool)!,
      counterTokenIndex: 0,
      counterMarkPriceUsd: 0.9998,
    });
    expect(quoted.ok && navPool.price).toBe(quoted.ok ? quoted.priceUsd : -1);
    expect(navPool.extra?.measurement?.priceMeasured).toBe(false);
    expect([dep.fetchBlockNumber.mock.calls.length, dep.fetchMulticall.mock.calls.length]).toEqual([1, 1]);
    expect(siblingPool.priceObservedAt).toBeNull();
    expect(siblingPool.curveNavSpotQuote).toBeUndefined();
    expect(uncapturedPool.priceObservedAt).toBeNull();
  });

  it("corroborates staged $300K/$40K Curve candidate in scoring and preserves provider-specific measured pool binding", async () => {
    const h = seedPublishedDexGeneration({ nowSec: NOW });
    openDatabases.push(h.sqlite);
    const { target, profile } = makeStusdsMeasuredCorroboratorPacket({
      poolId: CORR_ID,
      quotedAt: NOW - 300,
      capturedAt: NOW - 300,
      priceUsd: 1.07,
      retainedTvlUsd: 250_000,
    });
    seedGeneration(h.sqlite, {
      generationId: "quote-gen-1",
      targetGenerationId: "target-gen-1",
      publishedAt: NOW - 60,
      state: "published",
      rows: [{ target, profile, status: "measured" }],
    });

    const primary = makeCurveNgNavPool(NOW, {
      tvlUsd: 300_000,
      volumeUsd1d: 40_000,
      volumeReading: { volume24hUsd: 40_000, volume7dUsd: 200_000, observedAtSec: NOW - 60 },
    });
    const providerPoolId = "ethereum:defillama:stusds-univ3-provider-id";
    const corr = makeCurveNgNavPool(NOW, {
      poolId: providerPoolId,
      project: "uniswap-v3",
      poolType: "uniswap-v3-5bp",
      source: "direct_api",
      priceSource: "direct_api",
      tvlUsd: 250_000,
      volumeUsd1d: 25_000,
      price: 1.07,
      priceObservedAt: NOW - 120,
      volumeReading: { volume24hUsd: 25_000, volume7dUsd: 100_000, observedAtSec: NOW - 60 },
      priceCounterparty: {
        stablecoinId: "usds-sky",
        priceUsd: 1,
        observedAtSec: NOW - 60,
        observedAtMode: "upstream",
        source: "binance",
      },
      extra: {
        measuredExecutionTarget: target,
        measuredExecutionPhysicalPoolId: CORR_ID,
      },
    });
    const metrics = new Map([["stusds-sky", { stablecoinId: "stusds-sky", symbol: "stUSDS", pools: [primary, corr] }]]);
    const staged = refreshCurveStableswapNgNavPrices({
      metrics,
      capturedPools: new Map([[primary, makeCurveNgCapState({ balances: [150_000n * 10n ** 18n, 150_000n * 10n ** 18n] })]]),
      sourceGenerationId: CURVE_GEN,
      stablecoinPriceById: makeDexValuationPrices([
        ["usds-sky", { priceUsd: 1, observedAtSec: NOW - 60, observedAtMode: "upstream", source: "kraken" }],
      ]),
      registryEvaluatedAtSec: NOW,
      nowSec: NOW,
      stageOnly: true,
    });
    expect(staged).toMatchObject({ stagedCandidates: 1, admittedPools: 0 });
    expect(primary.extra?.curveNavSpotQuoteCandidate).toBeDefined();

    const scored = await computeStablecoinScores(
      h.db, metrics, new Map(), undefined, NOW, new Map(), undefined, new Map(), "none", NOW,
    );
    expect(scored.diagnostics.measuredExecution.join.failuresByReason).toEqual({});
    expect(scored.diagnostics.curveNavRejectionsByStablecoin).toBeUndefined();
    const retained = scored.retainedPoolsByStablecoin.get("stusds-sky")!;
    const admittedCurve = retained.find((p) => p.poolId === `ethereum:${CURVE_STUSDS_POOL}`);
    const admittedCorr = retained.find((p) => p.poolId === providerPoolId);
    expect(admittedCurve?.extra?.curveNavSpotQuoteCandidate).toBeUndefined();
    expect(admittedCurve?.curveNavSpotQuote).toMatchObject({
      admissionMode: "corroborated",
      corroboratorPoolIds: [providerPoolId],
    });
    expect(admittedCorr?.extra?.measuredExecutionPhysicalPoolId).toBeUndefined();
    expect(admittedCorr?.verifiedMeasuredPhysicalPoolId).toBe(CORR_ID);

    await computeDexPrices({
      db: h.db,
      retainedPoolsByStablecoin: scored.retainedPoolsByStablecoin,
      nowSec: NOW,
      generationId: h.generationId,
      primaryPrices: new Map([["stusds-sky", 1.09]]),
      curveNavRejectionsByStablecoin: scored.diagnostics.curveNavRejectionsByStablecoin,
    });
    const [row] = readPublicPriceRows(h.sqlite);
    expect(row).toMatchObject({ stablecoin_id: "stusds-sky", source_pool_count: 2, source_total_tvl: 550_000 });
    expect(JSON.parse(row!.price_sources_json!)).toMatchObject({
      quotePolicy: CURVE_NAV_SPOT_QUOTE_POLICY_ID,
      quoteCaptures: [expect.objectContaining({
        poolId: `ethereum:${CURVE_STUSDS_POOL}`,
        admissionMode: "corroborated",
        corroboratorPoolIds: [providerPoolId],
      })],
    });
  });

  it("captures Curve NAV rejections BEFORE filterRetainedPools so DL duplicates are quarantined", async () => {
    const h = seedPublishedDexGeneration({ nowSec: NOW });
    openDatabases.push(h.sqlite);
    const rejectedCurve = makeCurveNgNavPool(NOW, {
      tvlUsd: 500,
      volumeUsd1d: 0,
      price: 1.05,
      priceObservedAt: null,
      extra: {
        measurement: { balanceMeasured: true, priceMeasured: false },
        curveNavSpotQuoteRejectedReason: "insufficient-support",
      },
    });
    const dlDuplicate = makeCurveNgNavPool(NOW, {
      poolId: `ethereum:${CURVE_STUSDS_POOL}`,
      tvlUsd: 2_500_000,
      volumeUsd1d: 500_000,
      price: 0.99,
      priceObservedAt: NOW - 30,
      source: "dl",
      extra: {},
    });
    const metrics = new Map([
      ["stusds-sky", { stablecoinId: "stusds-sky", symbol: "stUSDS", pools: [rejectedCurve, dlDuplicate] }],
    ]);
    const scored = await computeStablecoinScores(
      h.db, metrics, new Map(), undefined, NOW, new Map(), undefined, new Map(), "none", NOW,
    );
    expect(scored.diagnostics.curveNavRejectionsByStablecoin?.get("stusds-sky")).toEqual(
      expect.arrayContaining([expect.objectContaining({
        poolKey: `ethereum:${CURVE_STUSDS_POOL}`,
        reason: "insufficient-support",
      })]),
    );
    await computeDexPrices({
      db: h.db,
      retainedPoolsByStablecoin: scored.retainedPoolsByStablecoin,
      nowSec: NOW,
      generationId: h.generationId,
      primaryPrices: new Map([["stusds-sky", 1.09]]),
      curveNavRejectionsByStablecoin: scored.diagnostics.curveNavRejectionsByStablecoin,
    });
    expect(readPublicPriceRows(h.sqlite)).toEqual([]);
  });

  it("rejects counter USD marks lacking upstream clock provenance across capture, staging, and validation", () => {
    const pool = makeCurveNgNavPool(NOW);
    const localMark = { priceUsd: 1, observedAtSec: NOW - 60, source: "coingecko+kraken" };
    const summary = refreshCurveStableswapNgNavPrices({
      metrics: new Map([["stusds-sky", { stablecoinId: "stusds-sky", symbol: "stUSDS", pools: [pool] }]]),
      capturedPools: new Map([[pool, makeCurveNgCapState()]]),
      sourceGenerationId: CURVE_GEN,
      stablecoinPriceById: makeDexValuationPrices([["usds-sky", localMark]]),
      registryEvaluatedAtSec: NOW,
      nowSec: NOW,
    });
    expect(summary.admittedPools).toBe(0);
    expect(summary.rejectedByReason["quote-mark-unavailable"]).toBe(1);
    expect(pool.priceObservedAt).toBeNull();

    const stagedPool = makeCurveNgNavPool(NOW, {
      extra: {
        curveNavSpotQuoteCandidate: {
          quote: {
            policyId: CURVE_NAV_SPOT_QUOTE_POLICY_ID,
            poolId: `ethereum:${CURVE_STUSDS_POOL}`,
            blockNumber: CURVE_BLOCK_NUMBER,
            blockHash: CURVE_BLOCK_HASH,
            poolRatioObservedAt: NOW - 120,
            quoteMarkObservedAt: NOW - 60,
            captureEvaluatedAtSec: NOW - 60,
            sourceGenerationId: CURVE_GEN,
            admissionMode: "sole-venue",
          },
          priceUsd: 1.07,
          priceObservedAt: NOW - 120,
          counterpartyPrice: {
            stablecoinId: "usds-sky",
            priceUsd: 1,
            observedAtSec: NOW - 60,
            source: "coingecko+kraken",
          },
          requiredSupportTvlUsd: 500_000,
        } as never,
      },
    });
    const admittedResult = admitCurveStableswapNgNavCandidates({
      poolsByStablecoin: new Map([["stusds-sky", [stagedPool]]]),
      nowSec: NOW,
      volumeClock: { asOfSec: NOW, maxObservationAgeSec: 72 * 3600 },
    });
    expect(admittedResult.rejectionsByStablecoin.get("stusds-sky")).toEqual([
      { poolKey: stagedPool.poolId, chain: "ethereum", reason: "invalid-clock" },
    ]);
    expect(stagedPool.curveNavSpotQuote).toBeUndefined();

    const clocked = makeClockedCurveNavPool(NOW, {
      priceCounterparty: {
        stablecoinId: "usds-sky",
        priceUsd: 1,
        observedAtSec: NOW - 60,
        source: "coingecko+kraken",
      },
    });
    const obs: DexPriceObs = {
      price: clocked.price!,
      tvl: clocked.tvlUsd,
      chain: clocked.chain,
      protocol: clocked.project,
      sourceFamily: "direct_api",
      identityConfidence: "exact",
      poolKey: clocked.poolId,
      observedAt: clocked.priceObservedAt!,
      counterpartyPrice: clocked.priceCounterparty,
      curveNavSpotQuote: clocked.curveNavSpotQuote,
    };
    expect(validateClockedCurveNavObservation(obs, NOW)).toBe("invalid-clock");
  });

  it("enforces uniform lineage intersection for venue:kraken vs kraken and fails closed on empty dependencies", () => {
    const primaryObs: DexPriceObs = {
      price: 1.07,
      tvl: 300_000,
      chain: "ethereum",
      protocol: "curve",
      poolKey: `ethereum:${CURVE_STUSDS_POOL}`,
      observedAt: NOW - 60,
      counterpartyPrice: {
        stablecoinId: "usds-sky",
        priceUsd: 1,
        observedAtSec: NOW - 60,
        observedAtMode: "upstream",
        source: "curve-onchain",
        upstreamKeys: ["venue:kraken"],
      },
    };
    const collidingCorr: DexPriceObs = {
      price: 1.07,
      tvl: 250_000,
      chain: "ethereum",
      protocol: "uniswap-v3",
      poolKey: "ethereum:defillama:provider-specific-pool-id",
      observedAt: NOW - 60,
      counterpartyPrice: {
        stablecoinId: "usds-sky",
        priceUsd: 1,
        observedAtSec: NOW - 60,
        observedAtMode: "upstream",
        source: "kraken",
      },
    };
    const disjointCorr: DexPriceObs = {
      ...collidingCorr,
      counterpartyPrice: {
        stablecoinId: "usds-sky",
        priceUsd: 1,
        observedAtSec: NOW - 60,
        observedAtMode: "upstream",
        source: "binance",
      },
    };
    const emptyCorr: DexPriceObs = {
      ...collidingCorr,
      counterpartyPrice: undefined,
    };
    expect(hasIndependentNavMarkLineage(primaryObs, collidingCorr)).toBe(false);
    expect(hasIndependentNavMarkLineage(primaryObs, disjointCorr)).toBe(true);
    expect(hasIndependentNavMarkLineage(primaryObs, emptyCorr)).toBe(false);
  });

  it.each(CURVE_NG_CORROBORATION_SPECS)("corroboration: %s -> %s", (_label, spec, admitted) => {
    const primary = makeCurveNgNavPool(NOW, {
      tvlUsd: 300_000,
      volumeUsd1d: 40_000,
      volumeReading: { volume24hUsd: 40_000, volume7dUsd: 200_000, observedAtSec: NOW - 60 },
    });
    const pools: PoolEntry[] = [primary];
    if (spec) {
      const s = spec as {
        project?: string;
        source?: PoolEntry["source"];
        priceSource?: PoolEntry["priceSource"];
        priceObservedAt?: null;
        priceObservedAtOffset?: number;
        tvlUsd?: number;
        vol?: number;
        price?: number;
        markSource?: string;
        measured?: "valid" | "divergent";
        ammSource?: "solidly-v2" | "balancer";
      };
      const vol24h = s.vol ?? 25_000;
      const extra: PoolEntry["extra"] = s.measured
        ? {
            measuredExecution: makeStusdsMeasuredCorroboratorPacket({
              poolId: CORR_ID,
              quotedAt: NOW - 180,
              priceUsd: 1.07,
              marginalOutputRatio: s.measured === "divergent" ? 0.9 : 1,
            }).profile,
          }
        : s.ammSource
          ? { ammExecutionModel: { source: s.ammSource, capture: { blockTimestamp: NOW - 30, sourceGenerationId: CURVE_GEN } } as never }
          : {};
      pools.push(makeCurveNgNavPool(NOW, {
        poolId: CORR_ID,
        project: s.project ?? "uniswap-v3",
        source: s.source ?? "direct_api",
        priceSource: s.priceSource ?? (s.source ? undefined : "direct_api"),
        priceObservedAt: s.priceObservedAt === null ? null : NOW + (s.priceObservedAtOffset ?? -120),
        tvlUsd: s.tvlUsd ?? 250_000,
        volumeReading: { volume24hUsd: vol24h, volume7dUsd: vol24h * 4, observedAtSec: NOW - 60 },
        price: s.price ?? 1.07,
        priceCounterparty: s.markSource
          ? { stablecoinId: "usds-sky", priceUsd: 1, observedAtSec: NOW - 60, observedAtMode: "upstream", source: s.markSource }
          : undefined,
        extra,
      }));
    }
    const summary = refreshCurveStableswapNgNavPrices({
      metrics: new Map([["stusds-sky", { stablecoinId: "stusds-sky", symbol: "stUSDS", pools }]]),
      capturedPools: new Map([[primary, makeCurveNgCapState({ balances: [150_000n * 10n ** 18n, 150_000n * 10n ** 18n] })]]),
      sourceGenerationId: CURVE_GEN,
      stablecoinPriceById: makeDexValuationPrices([
        ["usds-sky", { priceUsd: 1, observedAtSec: NOW - 60, observedAtMode: "upstream", source: "kraken" }],
      ]),
      registryEvaluatedAtSec: NOW,
      nowSec: NOW,
    });
    expect(summary.admittedPools).toBe(admitted ? 1 : 0);
    if (admitted) {
      expect(primary.curveNavSpotQuote).toMatchObject({ admissionMode: "corroborated", corroboratorPoolIds: [CORR_ID] });
    } else {
      expect(summary.rejectedByReason.uncorroborated).toBe(1);
      expect(primary.priceObservedAt).toBeNull();
    }
  });

  it.each(CURVE_NG_REJECTION_SPECS)("rejects %s as %s", (_label, pSpec, sSpec, markOffsetSec, reason) => {
    const p = pSpec as { tvlUsd?: number; volume24h?: number };
    const s = sSpec as { lowCounterDepth?: boolean; captureOffsetSec?: number; evalOffsetSec?: number; sourceGenerationId?: string };
    const pool = makeCurveNgNavPool(NOW, {
      ...(p.tvlUsd !== undefined ? { tvlUsd: p.tvlUsd } : {}),
      ...(p.volume24h !== undefined ? { volumeReading: { volume24hUsd: p.volume24h, volume7dUsd: 100_000, observedAtSec: NOW - 60 } } : {}),
    });
    const capState = makeCurveNgCapState({
      ...(s.lowCounterDepth ? { balances: [9_000n * 10n ** 18n, 2_500_000n * 10n ** 18n] } : {}),
      ...(s.captureOffsetSec !== undefined || s.sourceGenerationId !== undefined
        ? {
            capture: {
              blockNumber: CURVE_BLOCK_NUMBER,
              blockHash: CURVE_BLOCK_HASH,
              blockTimestamp: s.captureOffsetSec !== undefined ? NOW + s.captureOffsetSec : CURVE_BLOCK_TIMESTAMP,
              sourceGenerationId: s.sourceGenerationId ?? CURVE_GEN,
            },
          }
        : {}),
      ...(s.evalOffsetSec !== undefined ? { captureEvaluatedAtSec: NOW + s.evalOffsetSec } : {}),
    });
    const summary = refreshCurveStableswapNgNavPrices({
      metrics: new Map([["stusds-sky", { stablecoinId: "stusds-sky", symbol: "stUSDS", pools: [pool] }]]),
      capturedPools: new Map([[pool, capState]]),
      sourceGenerationId: CURVE_GEN,
      stablecoinPriceById: makeDexValuationPrices([
        ["usds-sky", { priceUsd: 1, observedAtSec: NOW + markOffsetSec, observedAtMode: "upstream", source: "kraken" }],
      ]),
      registryEvaluatedAtSec: NOW,
      nowSec: NOW,
    });
    expect(summary.admittedPools).toBe(0);
    expect(summary.rejectedByReason[reason]).toBe(1);
    expect(pool.priceObservedAt).toBeNull();
    expect(pool.curveNavSpotQuote).toBeUndefined();
  });
});
