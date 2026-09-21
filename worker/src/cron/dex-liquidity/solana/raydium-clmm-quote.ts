import { fetchSolanaAccountBatch, solanaPublicKey, type SolanaAccount } from "../../reserve-adapters/solana";
import type { AdapterContext } from "../../reserve-adapters/types";
import { programAddress, publicKeyBytes } from "./program-address";

export const RAYDIUM_CLMM_PROGRAM_ID = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const Q64 = 1n << 64n;
const MAX_U128 = (1n << 128n) - 1n;
const MIN_TICK = -443636;
const MAX_TICK = 443636;
const FEE_DENOMINATOR = 1_000_000n;
const ARRAY_SIZE = 60;

interface RaydiumPool {
  slot: number;
  config: string;
  sqrtPrice: bigint;
  tickCurrentIndex: number;
  liquidity: bigint;
  tickSpacing: number;
  tokenMintA: string;
  tokenMintB: string;
  tokenVaultA: string;
  tokenVaultB: string;
  decimalsA: number;
  decimalsB: number;
  bitmap: bigint;
}
interface RaydiumTickArray {
  slot: number;
  address: string;
  startTickIndex: number;
  ticks: { initialized: boolean; liquidityNet: bigint }[];
}
export interface RaydiumSnapshot {
  slot: number;
  poolAddress: string;
  pool: RaydiumPool;
  feeRate: number;
  configSlot: number;
  bitmapSlot: number;
  initializedStarts: number[];
  tickArrays: RaydiumTickArray[];
  mints: { slot: number; address: string; account: SolanaAccount }[];
}
function unsigned(data: Uint8Array, offset: number, length: number): bigint {
  if (offset < 0 || offset + length > data.length) throw new Error("Truncated Raydium account");
  let value = 0n;
  for (let i = offset + length - 1; i >= offset; i--) value = (value << 8n) | BigInt(data[i]);
  return value;
}
function checkLayout(data: Uint8Array, length: number, discriminator: readonly number[]) {
  if (data.length !== length || discriminator.some((byte, i) => data[i] !== byte)) throw new Error("Invalid Raydium account layout");
}

/** Packed Raydium PoolState; trading fees live in the separately bound AmmConfig. */
export function decodeRaydiumPool(data: Uint8Array, slot: number): RaydiumPool {
  checkLayout(data, 1544, [247, 237, 227, 245, 215, 195, 222, 70]);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if ((data[389] & 16) !== 0) throw new Error("Raydium swaps disabled");
  if (data[390] !== 0 || data.subarray(1096, 1176).some((byte) => byte !== 0)) throw new Error("Raydium dynamic/output fees unsupported");
  const pool = {
    slot, config: solanaPublicKey(data.subarray(9, 41)),
    tokenMintA: solanaPublicKey(data.subarray(73, 105)), tokenMintB: solanaPublicKey(data.subarray(105, 137)),
    tokenVaultA: solanaPublicKey(data.subarray(137, 169)), tokenVaultB: solanaPublicKey(data.subarray(169, 201)),
    decimalsA: data[233], decimalsB: data[234], tickSpacing: view.getUint16(235, true),
    liquidity: unsigned(data, 237, 16), sqrtPrice: unsigned(data, 253, 16), tickCurrentIndex: view.getInt32(269, true),
    bitmap: unsigned(data, 904, 128),
  };
  if (!Number.isSafeInteger(slot) || slot <= 0 || pool.tickSpacing === 0 || pool.decimalsA > 18 || pool.decimalsB > 18 || pool.tokenMintA === pool.tokenMintB || pool.tickCurrentIndex < MIN_TICK || pool.tickCurrentIndex > MAX_TICK || pool.sqrtPrice < raydiumTickSqrtPrice(MIN_TICK) || pool.sqrtPrice >= raydiumTickSqrtPrice(MAX_TICK)) throw new Error("Invalid Raydium pool state");
  return pool;
}

export function decodeRaydiumTickArray(data: Uint8Array, address: string, poolAddress: string, spacing: number, slot: number): RaydiumTickArray {
  checkLayout(data, 10240, [192, 155, 85, 205, 49, 249, 129, 42]);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const startTickIndex = view.getInt32(40, true);
  if (solanaPublicKey(data.subarray(8, 40)) !== poolAddress || startTickIndex % (ARRAY_SIZE * spacing) !== 0) throw new Error("Raydium tick array binding mismatch");
  const ticks: RaydiumTickArray["ticks"] = [];
  let initializedCount = 0;
  for (let i = 0; i < ARRAY_SIZE; i++) {
    const offset = 44 + i * 168;
    // Limit-order fields replaced padding in newer program revisions. Never ignore them.
    if (data.subarray(offset + 116, offset + 168).some((byte) => byte !== 0)) throw new Error("Raydium limit orders unsupported");
    const gross = unsigned(data, offset + 20, 16);
    const liquidityNet = BigInt.asIntN(128, unsigned(data, offset + 4, 16));
    const initialized = gross > 0n;
    if ((liquidityNet < 0n ? -liquidityNet : liquidityNet) > gross || (initialized && view.getInt32(offset, true) !== startTickIndex + i * spacing)) throw new Error("Invalid Raydium tick liquidity");
    if (initialized) initializedCount++;
    ticks.push({ initialized, liquidityNet });
  }
  if (initializedCount !== data[10124]) throw new Error("Raydium initialized tick count mismatch");
  return { slot, address, startTickIndex, ticks };
}

/** Raydium's Q64 factors, not Orca's higher-precision positive-tick formula.
 * Source: raydium-io/raydium-clmm programs/amm/src/libraries/tick_math.rs (Apache-2.0).
 * Copyright Raydium; native BigInt adaptation, provided without warranties.
 */
const TICK_FACTORS = [0xfffcb933bd6fb800n, 0xfff97272373d4000n, 0xfff2e50f5f657000n, 0xffe5caca7e10f000n, 0xffcb9843d60f7000n, 0xff973b41fa98e800n, 0xff2ea16466c9b000n, 0xfe5dee046a9a3800n, 0xfcbe86c7900bb000n, 0xf987a7253ac65800n, 0xf3392b0822bb6000n, 0xe7159475a2caf000n, 0xd097f3bdfd2f2000n, 0xa9f746462d9f8000n, 0x70d869a156f31c00n, 0x31be135f97ed3200n, 0x9aa508b5b85a500n, 0x5d6af8dedc582cn, 0x2216e584f5fan];
export function raydiumTickSqrtPrice(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) throw new Error("Raydium tick out of range");
  let ratio = Q64;
  for (let i = 0; i < TICK_FACTORS.length; i++) if (Math.abs(tick) & (1 << i)) ratio = ratio * TICK_FACTORS[i] >> 64n;
  return tick > 0 ? MAX_U128 / ratio : ratio;
}
function ceilDiv(n: bigint, d: bigint): bigint { return (n + d - 1n) / d; }
function delta(a: bigint, b: bigint, liquidity: bigint, tokenA: boolean, roundUp: boolean): bigint {
  const numerator = liquidity * (a > b ? a - b : b - a) * (tokenA ? Q64 : 1n);
  const denominator = tokenA ? a * b : Q64;
  return roundUp ? ceilDiv(numerator, denominator) : numerator / denominator;
}

/** Bitmap gaps are empty liquidity space, not steps: only initialized ticks incur fee rounding. */
export function quoteRaydiumExactIn(snapshot: RaydiumSnapshot, tokenMintIn: string, amountIn: bigint): { amountOut: bigint; slot: number } {
  const { pool, slot } = snapshot;
  if (!Number.isSafeInteger(slot) || slot <= 0 || pool.slot !== slot || snapshot.configSlot !== slot || snapshot.bitmapSlot !== slot || snapshot.tickArrays.some((array) => array.slot !== slot) || snapshot.mints.some((mint) => mint.slot !== slot)) throw new Error("Mixed Raydium account slots");
  for (const [address, decimals] of [[pool.tokenMintA, pool.decimalsA], [pool.tokenMintB, pool.decimalsB]] as const) {
    const mint = snapshot.mints.find((entry) => entry.address === address)?.account;
    if (!mint || mint.owner !== TOKEN_PROGRAM || mint.data.length !== 82 || mint.data[45] !== 1 || mint.data[44] !== decimals) throw new Error("Raydium Token-2022/unsupported mint");
  }
  if (amountIn <= 0n || amountIn >= Q64 || pool.liquidity <= 0n || pool.liquidity > MAX_U128) throw new Error("Invalid Raydium amount or zero liquidity");
  if (tokenMintIn !== pool.tokenMintA && tokenMintIn !== pool.tokenMintB) throw new Error("Raydium input mint mismatch");
  if (!Number.isInteger(snapshot.feeRate) || snapshot.feeRate < 0 || snapshot.feeRate > 100_000) throw new Error("Invalid Raydium fee");
  const aToB = tokenMintIn === pool.tokenMintA;
  const currentStart = Math.floor(pool.tickCurrentIndex / (ARRAY_SIZE * pool.tickSpacing)) * ARRAY_SIZE * pool.tickSpacing;
  const starts = snapshot.initializedStarts.filter((start) => aToB ? start <= currentStart : start >= currentStart).sort((a, b) => aToB ? b - a : a - b);
  let remaining = amountIn;
  let amountOut = 0n;
  let liquidity = pool.liquidity;
  let sqrtPrice = pool.sqrtPrice;
  const fee = BigInt(snapshot.feeRate);
  for (const start of starts.slice(0, 3)) {
    const array = snapshot.tickArrays.find((entry) => entry.startTickIndex === start);
    if (!array) throw new Error("Missing required Raydium tick array");
    if (array.ticks.length !== ARRAY_SIZE) throw new Error("Invalid Raydium tick count");
    for (let position = 0; position < ARRAY_SIZE; position++) {
      const index = aToB ? ARRAY_SIZE - 1 - position : position;
      const tickIndex = start + index * pool.tickSpacing;
      if (aToB ? tickIndex > pool.tickCurrentIndex : tickIndex <= pool.tickCurrentIndex) continue;
      const tick = array.ticks[index];
      if (!tick.initialized) continue;
      const target = raydiumTickSqrtPrice(tickIndex);
      if (aToB ? target > sqrtPrice : target < sqrtPrice) throw new Error("Invalid Raydium price direction");
      const available = remaining * (FEE_DENOMINATOR - fee) / FEE_DENOMINATOR;
      const required = delta(sqrtPrice, target, liquidity, aToB, true);
      const next = required <= available ? target : available === 0n ? sqrtPrice : aToB
        ? ceilDiv(liquidity * sqrtPrice * Q64, liquidity * Q64 + available * sqrtPrice)
        : sqrtPrice + available * Q64 / liquidity;
      const consumed = next === target ? required : delta(sqrtPrice, next, liquidity, aToB, true);
      const feeAmount = next === target ? ceilDiv(consumed * fee, FEE_DENOMINATOR - fee) : remaining - consumed;
      const output = delta(sqrtPrice, next, liquidity, !aToB, false);
      if (consumed + feeAmount > remaining || output >= Q64 - amountOut) throw new Error("Raydium amount overflow");
      remaining -= consumed + feeAmount;
      amountOut += output;
      sqrtPrice = next;
      if (remaining === 0n) return { amountOut, slot };
      liquidity += aToB ? -tick.liquidityNet : tick.liquidityNet;
      if (liquidity <= 0n || liquidity > MAX_U128) throw new Error("Zero or invalid Raydium liquidity after crossing");
    }
  }
  throw new Error("Raydium quote exceeds initialized tick-array coverage");
}

/** Full bitmap census; extension positive/negative banks each contain fourteen 512-bit words. */
function initializedArrayStarts(pool: RaydiumPool, extension: Uint8Array, poolAddress: string): number[] {
  checkLayout(extension, 1832, [60, 150, 36, 219, 97, 128, 139, 153]);
  if (solanaPublicKey(extension.subarray(8, 40)) !== poolAddress) throw new Error("Raydium bitmap pool mismatch");
  const width = ARRAY_SIZE * pool.tickSpacing;
  const starts: number[] = [];
  function addBits(bitmap: bigint, base: number) {
    for (let bit = 0; bitmap !== 0n; bit++, bitmap >>= 1n) {
      const start = (base + bit) * width;
      if ((bitmap & 1n) !== 0n && start <= MAX_TICK && start + width > MIN_TICK) starts.push(start);
    }
  }
  addBits(pool.bitmap, -512);
  for (let bank = 0; bank < 14; bank++) {
    addBits(unsigned(extension, 40 + bank * 64, 64), (bank + 1) * 512);
    addBits(unsigned(extension, 936 + bank * 64, 64), -(bank + 2) * 512);
  }
  return starts;
}
export async function raydiumTickArrayAddress(poolAddress: string, start: number): Promise<string> {
  const index = new Uint8Array(4);
  new DataView(index.buffer).setInt32(0, start, false);
  return programAddress(RAYDIUM_CLMM_PROGRAM_ID, [new TextEncoder().encode("tick_array"), publicKeyBytes(poolAddress), index]);
}

/** Discovery finds addresses only; all quote inputs are re-read in one <=8-account bank snapshot. */
export async function fetchRaydiumSnapshot(poolAddress: string, discovery: RaydiumPool, tokenMintIn: string, signal: AbortSignal, ctx?: AdapterContext, minContextSlot = discovery.slot): Promise<RaydiumSnapshot> {
  const bitmapAddress = await programAddress(RAYDIUM_CLMM_PROGRAM_ID, [new TextEncoder().encode("pool_tick_array_bitmap_extension"), publicKeyBytes(poolAddress)]);
  const census = await fetchSolanaAccountBatch([poolAddress, bitmapAddress], signal, ctx, minContextSlot);
  function owned(accounts: Map<string, SolanaAccount | null>, address: string): SolanaAccount {
    const account = accounts.get(address);
    if (!account || account.owner !== RAYDIUM_CLMM_PROGRAM_ID) throw new Error("Missing or invalid Raydium account owner");
    return account;
  }
  const current = decodeRaydiumPool(owned(census.accounts, poolAddress).data, census.slot);
  if (current.config !== discovery.config || current.tokenMintA !== discovery.tokenMintA || current.tokenMintB !== discovery.tokenMintB || current.tickSpacing !== discovery.tickSpacing) throw new Error("Raydium discovery identity changed");
  const aToB = tokenMintIn === current.tokenMintA;
  if (!aToB && tokenMintIn !== current.tokenMintB) throw new Error("Raydium input mint mismatch");
  const width = ARRAY_SIZE * current.tickSpacing;
  const currentStart = Math.floor(current.tickCurrentIndex / width) * width;
  const starts = initializedArrayStarts(current, owned(census.accounts, bitmapAddress).data, poolAddress).filter((start) => aToB ? start <= currentStart : start >= currentStart).sort((a, b) => aToB ? b - a : a - b).slice(0, 3);
  const addresses: string[] = [];
  for (const start of starts) addresses.push(await raydiumTickArrayAddress(poolAddress, start));
  const batch = await fetchSolanaAccountBatch([poolAddress, current.config, bitmapAddress, current.tokenMintA, current.tokenMintB, ...addresses], signal, ctx, census.slot);
  const pool = decodeRaydiumPool(owned(batch.accounts, poolAddress).data, batch.slot);
  if (pool.config !== current.config || pool.tokenMintA !== current.tokenMintA || pool.tokenMintB !== current.tokenMintB || pool.tickSpacing !== current.tickSpacing) throw new Error("Raydium snapshot identity changed");
  const config = owned(batch.accounts, pool.config).data;
  checkLayout(config, 117, [218, 244, 33, 104, 203, 203, 43, 111]);
  const configView = new DataView(config.buffer, config.byteOffset, config.byteLength);
  if (configView.getUint16(51, true) !== pool.tickSpacing) throw new Error("Raydium config tick spacing mismatch");
  const initializedStarts = initializedArrayStarts(pool, owned(batch.accounts, bitmapAddress).data, poolAddress);
  const finalStart = Math.floor(pool.tickCurrentIndex / width) * width;
  const required = initializedStarts.filter((start) => aToB ? start <= finalStart : start >= finalStart).sort((a, b) => aToB ? b - a : a - b).slice(0, 3);
  if (required.some((start) => !starts.includes(start))) throw new Error("Raydium moved outside discovered tick arrays");
  const tickArrays = addresses.map((address, i) => {
    const array = decodeRaydiumTickArray(owned(batch.accounts, address).data, address, poolAddress, pool.tickSpacing, batch.slot);
    if (array.startTickIndex !== starts[i]) throw new Error("Raydium tick array PDA mismatch");
    return array;
  });
  const mints = [pool.tokenMintA, pool.tokenMintB].map((address) => {
    const account = batch.accounts.get(address);
    if (!account) throw new Error("Missing Raydium mint");
    return { slot: batch.slot, address, account };
  });
  return { slot: batch.slot, poolAddress, pool, configSlot: batch.slot, bitmapSlot: batch.slot, feeRate: configView.getUint32(47, true), initializedStarts, tickArrays, mints };
}
