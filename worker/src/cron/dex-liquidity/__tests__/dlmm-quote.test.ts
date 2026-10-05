import { afterEach, describe, expect, it, vi } from "vitest";
import type * as SolanaModule from "../../reserve-adapters/solana";
import { fetchSolanaAccountBatch } from "../../reserve-adapters/solana";
import { decodeDlmmPair, dlmmBinPrice, dlmmTotalFee, fetchDlmmSnapshot, quoteDlmmExactIn } from "../solana/dlmm-quote";
import { capturedDlmmAccounts, capturedDlmmSnapshot, dlmmCaptures } from "./dlmm-test-support";

vi.mock("../../reserve-adapters/solana", async (original) => ({ ...await original<typeof SolanaModule>(), fetchSolanaAccountBatch: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); });

describe("DLMM finalized pinned-account SDK equivalence", () => {
  it.each(dlmmCaptures)("matches all SDK grid points for $assetId / $tokenMintIn at slot $slot", async (capture) => {
    const snapshot = await capturedDlmmSnapshot(capture);
    for (const point of capture.quotes) {
      const expected = point.sdkReference;
      if ("reason" in expected) {
        expect(() => quoteDlmmExactIn(snapshot, capture.tokenMintIn, BigInt(point.amountIn))).toThrow(expected.reason);
      } else {
        const quote = quoteDlmmExactIn(snapshot, capture.tokenMintIn, BigInt(point.amountIn));
        expect({ ...quote, amountOut: quote.amountOut.toString(), fee: quote.fee.toString(), protocolFee: quote.protocolFee.toString() })
          .toEqual({ slot: capture.slot, ...expected });
      }
    }
  });

  it("walks 21 real bins, charges each volatility fee, and does not mutate pinned state", async () => {
    const capture = dlmmCaptures.find((row) => row.assetId === "usx-solstice")!;
    const snapshot = await capturedDlmmSnapshot(capture);
    const before = snapshot.pool.activeId;
    const quote = quoteDlmmExactIn(snapshot, capture.tokenMintIn, 10_000_000_000n);
    expect(quote).toMatchObject({ amountOut: 10_044_336_659n, binsFilled: 21, endBinId: 41, fee: 2_493_213n, protocolFee: 277_013n });
    expect(snapshot.pool.activeId).toBe(before);
    expect(quoteDlmmExactIn(snapshot, capture.tokenMintIn, 10_000_000_000n)).toEqual(quote);
  });

  it("does not turn a real empty-bin window or exhausted window into observed zero", async () => {
    const capture = dlmmCaptures.find((row) => row.assetId === "usdh-hubble")!;
    const snapshot = await capturedDlmmSnapshot(capture);
    expect(() => quoteDlmmExactIn(snapshot, capture.tokenMintIn, 1n)).toThrow("dlmm-bin-array-coverage-exhausted");
    const nopal = dlmmCaptures.find((row) => row.assetId === "nopal-nest")!;
    const nopalSnapshot = await capturedDlmmSnapshot(nopal);
    expect(quoteDlmmExactIn(nopalSnapshot, nopal.tokenMintIn, 10_000_000_000n)).toMatchObject({ binsFilled: 2, amountOut: 8_839_880_879n });
    expect(() => quoteDlmmExactIn(nopalSnapshot, nopal.tokenMintIn, 100_000_000_000n)).toThrow("dlmm-bin-array-coverage-exhausted");
  });

  it("rejects mixed slots, a stale Clock, wrong mint and wrong array binding", async () => {
    const capture = dlmmCaptures[0];
    const snapshot = await capturedDlmmSnapshot(capture);
    expect(() => quoteDlmmExactIn({ ...snapshot, slot: snapshot.slot + 1 }, capture.tokenMintIn, 100n)).toThrow("dlmm-mixed-account-slots");
    expect(() => quoteDlmmExactIn({ ...snapshot, clockSlot: BigInt(snapshot.slot - 1) }, capture.tokenMintIn, 100n)).toThrow("dlmm-mixed-account-slots");
    expect(() => quoteDlmmExactIn({ ...snapshot, timestamp: snapshot.pool.lastUpdateTimestamp - 1n }, capture.tokenMintIn, 100n)).toThrow("dlmm-stale-clock");
    expect(() => quoteDlmmExactIn(snapshot, "11111111111111111111111111111111", 100n)).toThrow("dlmm-input-mint-mismatch");
    const first = snapshot.binArrays[0];
    expect(() => quoteDlmmExactIn({ ...snapshot, binArrays: [{ ...first, array: { ...first.array!, poolAddress: "11111111111111111111111111111111" } }] }, capture.tokenMintIn, 100n)).toThrow("dlmm-bin-array-identity-mismatch");
    expect(() => quoteDlmmExactIn({ ...snapshot, binArrays: [{ ...first, array: { ...first.array!, slot: snapshot.slot - 1 } }] }, capture.tokenMintIn, 100n)).toThrow("dlmm-mixed-account-slots");
  });

  it("distinguishes an observed absent array from an unread initialized account", async () => {
    const capture = dlmmCaptures[0];
    const snapshot = await capturedDlmmSnapshot(capture);
    const index = snapshot.binArrays[0].index;
    expect(() => quoteDlmmExactIn({ ...snapshot, binArrays: [{ index, array: null }] }, capture.tokenMintIn, 100n)).toThrow("dlmm-missing-initialized-bin-array");
    expect(() => quoteDlmmExactIn({ ...snapshot, binArrays: [] }, capture.tokenMintIn, 100n)).toThrow("dlmm-bin-array-coverage-exhausted");
  });

  it("uses fixed-point price rounding, variable-fee ceil and the program fee cap", async () => {
    const snapshot = await capturedDlmmSnapshot(dlmmCaptures[0]);
    expect(dlmmBinPrice(0, 1)).toBe(1n << 64n);
    expect(dlmmBinPrice(-4, 1)).toBe(snapshot.binArrays[0].array!.bins[66].price);
    expect(dlmmTotalFee({ ...snapshot.pool, variableFeeControl: 1, baseFactor: 0 }, 1)).toBe(1n);
    expect(dlmmTotalFee({ ...snapshot.pool, variableFeeControl: 4_294_967_295 }, 4_294_967_295)).toBe(100_000_000n);
    expect(() => quoteDlmmExactIn(snapshot, dlmmCaptures[0].tokenMintIn, 1n << 64n)).toThrow("dlmm-input-outside-u64");
    expect(() => dlmmBinPrice(351640, 1)).toThrow("dlmm-price-domain-invalid");
  });

  it("charges output-only Y fees without applying the input-fee formula", async () => {
    const capture = dlmmCaptures[0];
    const snapshot = await capturedDlmmSnapshot(capture);
    const quoted = quoteDlmmExactIn({ ...snapshot, pool: { ...snapshot.pool, collectFeeMode: 1 } }, capture.tokenMintIn, 1_000_000n);
    const price = snapshot.binArrays[0].array!.bins[66].price;
    const gross = 1_000_000n * price / (1n << 64n);
    const totalFee = (gross * 100_000n + 999_999_999n) / 1_000_000_000n;
    expect(quoted).toMatchObject({ amountOut: gross - totalFee, feeOnInput: false });
    expect(quoted.fee + quoted.protocolFee).toBe(totalFee);
    expect(quoted.protocolFee).toBe(totalFee / 10n);
  });

  it("fills MM before processed and open orders and splits order fees separately", async () => {
    const capture = dlmmCaptures[0];
    const snapshot = await capturedDlmmSnapshot(capture);
    const first = snapshot.binArrays[0];
    const array = first.array!;
    const bins = array.bins.map((bin, i) => i === 66 ? { ...bin, amountY: 100n, openOrderAmount: 1_000_000n,
      processedOrderRemainingAmount: 200n, limitOrderAskSide: false } : bin);
    const quoted = quoteDlmmExactIn({ ...snapshot, pool: { ...snapshot.pool, supportLimitOrder: true },
      binArrays: [{ ...first, array: { ...array, version: 3, bins } }, ...snapshot.binArrays.slice(1)] }, capture.tokenMintIn, 1_000_000n);
    expect(quoted).toMatchObject({ binsFilled: 1, fee: 50n, protocolFee: 50n });
    expect(quoted.amountOut).toBeGreaterThan(300n);
  });

  it("honors activation and both volatility-reference decay boundaries", async () => {
    const capture = dlmmCaptures[0];
    const snapshot = await capturedDlmmSnapshot(capture);
    expect(() => quoteDlmmExactIn({ ...snapshot, pool: { ...snapshot.pool, pairType: 1, activationType: 0, activationPoint: BigInt(snapshot.slot + 1) } },
      capture.tokenMintIn, 1_000_000n)).toThrow("dlmm-pool-not-activated");
    const pool = { ...snapshot.pool, filterPeriod: 10, decayPeriod: 20, volatilityAccumulator: 10000, volatilityReference: 10000,
      indexReference: snapshot.pool.activeId, maxVolatilityAccumulator: 100000, reductionFactor: 5000, variableFeeControl: 1_000_000_000 };
    const quoteAt = (elapsed: bigint) => quoteDlmmExactIn({ ...snapshot, pool, timestamp: pool.lastUpdateTimestamp + elapsed }, capture.tokenMintIn, 1_000_000n);
    const high = quoteAt(9n);
    const reduced = quoteAt(10n);
    const decayed = quoteAt(20n);
    expect(high.fee + high.protocolFee).toBe(1100n);
    expect(reduced.fee + reduced.protocolFee).toBe(350n);
    expect(decayed.fee + decayed.protocolFee).toBe(100n);
  });

  it("fails closed on disabled pools, Token-2022 and unknown layout versions", () => {
    const capture = dlmmCaptures[0];
    const bytes = capturedDlmmAccounts(capture).get(capture.poolAddress)!.data;
    for (const [offset, value, reason] of [[82, 1, "dlmm-pool-disabled"], [880, 1, "dlmm-token-2022-unsupported"], [882, 2, "dlmm-unsupported-pair-version"]] as const) {
      const changed = bytes.slice(); changed[offset] = value;
      expect(() => decodeDlmmPair(changed, capture.slot)).toThrow(reason);
    }
  });

  it("reads eight accounts atomically and enforces the discovery slot and mint identity", async () => {
    const capture = dlmmCaptures[0];
    const accounts = capturedDlmmAccounts(capture);
    const discovery = decodeDlmmPair(accounts.get(capture.poolAddress)!.data, capture.slot);
    const batch = vi.mocked(fetchSolanaAccountBatch);
    batch.mockResolvedValue({ slot: capture.slot, accounts });
    const snapshot = await fetchDlmmSnapshot(capture.poolAddress, discovery, capture.tokenMintIn, new AbortController().signal);
    expect(quoteDlmmExactIn(snapshot, capture.tokenMintIn, 1_000_000_000n).amountOut).toBe(999_405_330n);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0][0]).toHaveLength(8);
    expect(batch.mock.calls[0][3]).toBe(capture.slot);
    batch.mockResolvedValue({ slot: capture.slot - 1, accounts });
    await expect(fetchDlmmSnapshot(capture.poolAddress, discovery, capture.tokenMintIn, new AbortController().signal)).rejects.toThrow("dlmm-stale-slot");
    const changed = accounts.get(capture.poolAddress)!.data.slice(); changed[88] ^= 1;
    batch.mockResolvedValue({ slot: capture.slot, accounts: new Map(accounts).set(capture.poolAddress, { ...accounts.get(capture.poolAddress)!, data: changed }) });
    await expect(fetchDlmmSnapshot(capture.poolAddress, discovery, capture.tokenMintIn, new AbortController().signal)).rejects.toThrow("dlmm-discovery-identity-changed");
  });
});
