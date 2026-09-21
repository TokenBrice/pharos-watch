import { describe, expect, it, vi, afterEach } from "vitest";
import fixture from "./fixtures/whirlpool-slot-449058549.json";
import {
  decodeWhirlpool, decodeWhirlpoolTickArray, fetchWhirlpoolSnapshot,
  quoteWhirlpoolExactIn, tickArrayStarts, tickSqrtPrice, whirlpoolTickArrayAddress,
  type WhirlpoolSnapshot,
} from "../solana/whirlpool-quote";

function replay(): WhirlpoolSnapshot {
  const entries = Object.entries(fixture.accounts);
  const poolBytes = Uint8Array.from(Buffer.from(fixture.accounts[fixture.poolAddress as keyof typeof fixture.accounts].data[0], "base64"));
  const pool = decodeWhirlpool(poolBytes, fixture.slot);
  return {
    slot: fixture.slot, poolAddress: fixture.poolAddress, pool,
    tickArrays: entries.filter(([address]) => address !== fixture.poolAddress).map(([address, account]) =>
      decodeWhirlpoolTickArray(Uint8Array.from(Buffer.from(account.data[0], "base64")), address, fixture.poolAddress, pool.tickSpacing, fixture.slot)),
  };
}
afterEach(() => vi.unstubAllGlobals());

describe("native Whirlpool exact-in quotes", () => {
  it("replays the atomic slot 449058549 capture exactly against SDK/Jupiter", () => {
    const result = quoteWhirlpoolExactIn(replay(), fixture.tokenMintIn, BigInt(fixture.amountIn));
    expect(result).toEqual({ amountOut: 999660000n, slot: 449058549 });
  });

  it("derives the recorded dynamic tick-array PDAs including negative indices", async () => {
    const snapshot = replay();
    expect(tickArrayStarts(snapshot.pool.tickCurrentIndex, snapshot.pool.tickSpacing, true)).toEqual([-88, -176, -264]);
    for (const array of snapshot.tickArrays) expect(await whirlpoolTickArrayAddress(fixture.poolAddress, array.startTickIndex)).toBe(array.address);
  });

  it("quotes the same captured liquidity after fixed-layout tick-array encoding", () => {
    const snapshot = replay();
    snapshot.tickArrays = snapshot.tickArrays.map((array) => {
      const dynamic = Buffer.from(fixture.accounts[array.address as keyof typeof fixture.accounts].data[0], "base64");
      const fixed = Buffer.alloc(9988);
      fixed.set([69, 97, 189, 190, 110, 7, 66, 187]);
      dynamic.copy(fixed, 8, 8, 12);
      dynamic.copy(fixed, 9956, 12, 44);
      let offset = 60;
      for (let i = 0; i < 88; i++) {
        const size = dynamic[offset] === 1 ? 113 : 1;
        dynamic.copy(fixed, 12 + i * 113, offset, offset + size);
        offset += size;
      }
      return decodeWhirlpoolTickArray(fixed, array.address, fixture.poolAddress, 1, fixture.slot);
    });
    expect(quoteWhirlpoolExactIn(snapshot, fixture.tokenMintIn, BigInt(fixture.amountIn)).amountOut).toBe(999660000n);
  });

  it("crosses initialized liquidity ticks with exact fee rounding", () => {
    const snapshot = replay();
    snapshot.pool = { ...snapshot.pool, sqrtPrice: tickSqrtPrice(0), tickCurrentIndex: 0, liquidity: 1000000000n, feeRate: 3000 };
    const ticks = Array.from({ length: 88 }, () => ({ initialized: false, liquidityNet: 0n }));
    ticks[87] = { initialized: true, liquidityNet: 500000000n };
    snapshot.tickArrays = [
      { slot: fixture.slot, address: "current", startTickIndex: 0, ticks: Array.from({ length: 88 }, () => ({ initialized: false, liquidityNet: 0n })) },
      { slot: fixture.slot, address: "previous", startTickIndex: -88, ticks },
      { slot: fixture.slot, address: "earlier", startTickIndex: -176, ticks: Array.from({ length: 88 }, () => ({ initialized: false, liquidityNet: 0n })) },
    ];
    // Independently computed by Orca SDK computeSwapStep at tick -1, then -88.
    expect(quoteWhirlpoolExactIn(snapshot, snapshot.pool.tokenMintA, 100000n).amountOut).toBe(99686n);
  });

  it.each([true, false])("does not charge extra rounding at empty array boundaries (aToB=%s)", (aToB) => {
    const snapshot = replay();
    snapshot.pool = { ...snapshot.pool, sqrtPrice: tickSqrtPrice(0), tickCurrentIndex: 0, liquidity: 1000000000n, feeRate: 3000 };
    snapshot.tickArrays = tickArrayStarts(0, 1, aToB).map((startTickIndex) => ({
      slot: fixture.slot, address: String(startTickIndex), startTickIndex,
      ticks: Array.from({ length: 88 }, () => ({ initialized: false, liquidityNet: 0n })),
    }));
    // SDK computeSwapStep against the final covered tick, with no initialized ticks.
    expect(quoteWhirlpoolExactIn(snapshot, aToB ? snapshot.pool.tokenMintA : snapshot.pool.tokenMintB, 5000000n).amountOut).toBe(4960273n);
  });

  it("rejects a missing required array rather than extrapolating current liquidity", () => {
    const snapshot = replay();
    snapshot.tickArrays = snapshot.tickArrays.slice(1);
    expect(() => quoteWhirlpoolExactIn(snapshot, fixture.tokenMintIn, 1000000000n)).toThrow();
  });

  it("rejects zero liquidity", () => {
    const snapshot = replay();
    snapshot.pool.liquidity = 0n;
    expect(() => quoteWhirlpoolExactIn(snapshot, fixture.tokenMintIn, 1000000000n)).toThrow();
  });

  it("rejects mixed account slots", () => {
    const snapshot = replay();
    snapshot.tickArrays[0].slot++;
    expect(() => quoteWhirlpoolExactIn(snapshot, fixture.tokenMintIn, 1000000000n)).toThrow();
  });

  it("rejects amounts beyond the bounded window without returning a partial fill", () => {
    expect(() => quoteWhirlpoolExactIn(replay(), fixture.tokenMintIn, (1n << 64n) - 1n)).toThrow();
  });

  it("rejects adaptive-fee pools instead of applying the static fee formula", () => {
    const bytes = Uint8Array.from(Buffer.from(fixture.accounts[fixture.poolAddress as keyof typeof fixture.accounts].data[0], "base64"));
    bytes[43] = 2;
    expect(() => decodeWhirlpool(bytes, fixture.slot)).toThrow();
  });

  it("fetches one coherent bounded quote batch and carries its returned slot", async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.method).toBe("getMultipleAccounts");
      expect(body.params[0].length).toBeLessThanOrEqual(7);
      return new Response(JSON.stringify({ result: { context: { slot: fixture.slot }, value: body.params[0].map((address: string) => fixture.accounts[address as keyof typeof fixture.accounts] ?? null) } }));
    });
    vi.stubGlobal("fetch", fetch);
    const discovery = replay().pool;
    const snapshot = await fetchWhirlpoolSnapshot(fixture.poolAddress, discovery, new AbortController().signal);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(quoteWhirlpoolExactIn(snapshot, fixture.tokenMintIn, BigInt(fixture.amountIn))).toEqual({ amountOut: 999660000n, slot: fixture.slot });
  });
});
