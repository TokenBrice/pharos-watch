import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/raydium-slot-449058549.json";
import { decodeRaydiumPool, decodeRaydiumTickArray, fetchRaydiumSnapshot, quoteRaydiumExactIn, raydiumTickArrayAddress, raydiumTickSqrtPrice, type RaydiumSnapshot } from "../solana/raydium-clmm-quote";

const accounts: Record<string, { owner: string; data: string[]; executable: boolean }> = fixture.accounts;
const bytes = (address: string) => Uint8Array.from(Buffer.from(accounts[address].data[0], "base64"));
function replay(): RaydiumSnapshot {
  const pool = decodeRaydiumPool(bytes(fixture.poolAddress), fixture.slot);
  return {
    pool, poolAddress: fixture.poolAddress, slot: fixture.slot, configSlot: fixture.slot, bitmapSlot: fixture.slot,
    feeRate: new DataView(bytes(pool.config).buffer).getUint32(47, true), initializedStarts: [-60, 0],
    tickArrays: Object.keys(accounts).filter((address) => bytes(address).length === 10240).map((address) => decodeRaydiumTickArray(bytes(address), address, fixture.poolAddress, pool.tickSpacing, fixture.slot)),
    mints: [pool.tokenMintA, pool.tokenMintB].map((address) => ({ slot: fixture.slot, address, account: { owner: accounts[address].owner, data: bytes(address) } })),
  };
}
afterEach(() => vi.unstubAllGlobals());

describe("native Raydium CLMM exact-in", () => {
  it("reproduces the same-slot JUPUSD/Jupiter reference byte-for-byte", () => {
    expect(quoteRaydiumExactIn(replay(), fixture.tokenMintIn, BigInt(fixture.amountIn))).toEqual({ amountOut: 999152114n, slot: 449058549 });
  });
  it("derives captured negative and positive tick-array PDAs with BE seeds", async () => {
    for (const array of replay().tickArrays) expect(await raydiumTickArrayAddress(fixture.poolAddress, array.startTickIndex)).toBe(array.address);
  });
  it("crosses signed liquidity with exact input and fee rounding", () => {
    const snapshot = replay();
    snapshot.pool = { ...snapshot.pool, tickCurrentIndex: 0, sqrtPrice: raydiumTickSqrtPrice(0), liquidity: 1000000000n };
    snapshot.feeRate = 3000;
    snapshot.initializedStarts = [-60, 0];
    snapshot.tickArrays = [-60, 0].map((startTickIndex) => ({ slot: fixture.slot, address: String(startTickIndex), startTickIndex, ticks: Array.from({ length: 60 }, () => ({ initialized: false, liquidityNet: 0n })) }));
    snapshot.tickArrays[0].ticks[59] = { initialized: true, liquidityNet: 500000000n };
    snapshot.tickArrays[0].ticks[0] = { initialized: true, liquidityNet: 500000000n };
    // Raydium Q64 step to -1, subtract 500m liquidity, then partial step toward -60.
    expect(quoteRaydiumExactIn(snapshot, snapshot.pool.tokenMintA, 100000n).amountOut).toBe(99686n);
    snapshot.tickArrays[0].ticks[59].liquidityNet = -500000000n;
    expect(quoteRaydiumExactIn(snapshot, snapshot.pool.tokenMintA, 100000n).amountOut).toBe(99689n);
  });
  it("rejects missing initialized arrays rather than assuming constant liquidity", () => {
    const snapshot = replay(); snapshot.tickArrays = [];
    expect(() => quoteRaydiumExactIn(snapshot, fixture.tokenMintIn, 1000000000n)).toThrow("Missing required");
  });
  it("rejects mixed config, mint, bitmap and tick slots", () => {
    for (const corrupt of [
      (s: RaydiumSnapshot) => { s.configSlot++; },
      (s: RaydiumSnapshot) => { s.bitmapSlot++; },
      (s: RaydiumSnapshot) => { s.mints[0].slot++; },
      (s: RaydiumSnapshot) => { s.tickArrays[0].slot++; },
    ]) {
      const snapshot = replay(); corrupt(snapshot);
      expect(() => quoteRaydiumExactIn(snapshot, fixture.tokenMintIn, 1000000000n)).toThrow("Mixed Raydium");
    }
  });
  it("fails closed on zero liquidity, partial coverage and transfer-fee capable mints", () => {
    const empty = replay(); empty.pool.liquidity = 0n;
    expect(() => quoteRaydiumExactIn(empty, fixture.tokenMintIn, 1000000000n)).toThrow("zero liquidity");
    expect(() => quoteRaydiumExactIn(replay(), fixture.tokenMintIn, (1n << 64n) - 1n)).toThrow();
    const transferFee = replay(); transferFee.mints[0].account.owner = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
    expect(() => quoteRaydiumExactIn(transferFee, fixture.tokenMintIn, 1000000000n)).toThrow("Token-2022");
  });
  it("rejects unsupported dynamic fees and limit-order state", () => {
    const pool = bytes(fixture.poolAddress); pool[1096] = 1;
    expect(() => decodeRaydiumPool(pool, fixture.slot)).toThrow("dynamic");
    const array = replay().tickArrays[0]; const data = bytes(array.address); data[44 + 124] = 1;
    expect(() => decodeRaydiumTickArray(data, array.address, fixture.poolAddress, 1, fixture.slot)).toThrow("limit orders");
  });
  it("quotes only the final coherent bank snapshot through bounded sequential RPC", async () => {
    let active = 0; let peak = 0;
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      active++; peak = Math.max(peak, active);
      const body = JSON.parse(String(init.body));
      expect(body.params[0].length).toBeLessThanOrEqual(8);
      await Promise.resolve(); active--;
      return new Response(JSON.stringify({ result: { context: { slot: fixture.slot }, value: body.params[0].map((address: string) => accounts[address] ?? null) } }));
    });
    vi.stubGlobal("fetch", fetch);
    const snapshot = await fetchRaydiumSnapshot(fixture.poolAddress, replay().pool, fixture.tokenMintIn, new AbortController().signal);
    expect(quoteRaydiumExactIn(snapshot, fixture.tokenMintIn, BigInt(fixture.amountIn))).toEqual({ amountOut: 999152114n, slot: fixture.slot });
    expect(peak).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([30720, -30780])("discovers and quotes an initialized extension-bitmap array at %s", async (start) => {
    const source = replay();
    const poolData = bytes(fixture.poolAddress);
    const sqrt = raydiumTickSqrtPrice(start);
    const liquidity = 1000000000000n;
    const put = (data: Uint8Array, offset: number, value: bigint, length: number) => {
      for (let i = 0; i < length; i++, value >>= 8n) data[offset + i] = Number(value & 255n);
    };
    put(poolData, 237, liquidity, 16); put(poolData, 253, sqrt, 16);
    new DataView(poolData.buffer).setInt32(269, start, true);
    poolData.fill(0, 904, 1032);
    const bitmapAddress = Object.keys(accounts).find((address) => bytes(address).length === 1832)!;
    const bitmap = bytes(bitmapAddress); bitmap.fill(0, 40);
    if (start > 0) bitmap[40] = 1;
    else bitmap[936 + 63] = 128;
    const arrayAddress = await raydiumTickArrayAddress(fixture.poolAddress, start);
    const arrayData = bytes(source.tickArrays[0].address); arrayData.fill(0, 44);
    new DataView(arrayData.buffer).setInt32(40, start, true);
    new DataView(arrayData.buffer).setInt32(44 + 168, start + 1, true);
    put(arrayData, 44 + 168 + 20, liquidity, 16); arrayData[10124] = 1;
    const changed = new Map([[fixture.poolAddress, poolData], [bitmapAddress, bitmap], [arrayAddress, arrayData]]);
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ result: { context: { slot: fixture.slot }, value: body.params[0].map((address: string) =>
        changed.has(address) ? { owner: accounts[fixture.poolAddress].owner, executable: false, data: [Buffer.from(changed.get(address)!).toString("base64"), "base64"] } : accounts[address] ?? null) } }));
    }));
    const snapshot = await fetchRaydiumSnapshot(fixture.poolAddress, decodeRaydiumPool(poolData, fixture.slot), source.pool.tokenMintB, new AbortController().signal);
    const amount = 100000n;
    const next = sqrt + (amount * BigInt(1000000 - source.feeRate) / 1000000n) * (1n << 64n) / liquidity;
    const expected = liquidity * (next - sqrt) * (1n << 64n) / (sqrt * next);
    expect(quoteRaydiumExactIn(snapshot, source.pool.tokenMintB, amount).amountOut).toBe(expected);
  });
});
