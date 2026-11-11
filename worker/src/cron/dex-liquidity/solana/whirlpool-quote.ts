import { ceilDiv, q64TokenDelta as delta, tickSqrtPrice } from "../amm-math";
import { fetchSolanaAccountBatch, solanaPublicKey, type SolanaAccount } from "../../reserve-adapters/solana";
import type { AdapterContext } from "../../reserve-adapters/types";
import { programAddress, publicKeyBytes } from "./program-address";
import type { SolanaDexBankCaptureSink } from "@shared/types/solana-dex-bank";
import { captureSolanaDexBank } from "./bank-capture";

export const ORCA_WHIRLPOOL_PROGRAM_ID = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
const Q64 = 1n << 64n;
const MAX_U64 = Q64 - 1n;
const MAX_U128 = (1n << 128n) - 1n;
const MIN_TICK = -443636;
const MAX_TICK = 443636;
const FEE_DENOMINATOR = 1_000_000n;
const ARRAY_SIZE = 88;
const WHIRLPOOL_DISCRIMINATOR = [63, 149, 209, 12, 225, 128, 99, 9];
const FIXED_ARRAY_DISCRIMINATOR = [69, 97, 189, 190, 110, 7, 66, 187];
const DYNAMIC_ARRAY_DISCRIMINATOR = [17, 216, 246, 142, 225, 199, 218, 56];

export interface WhirlpoolState {
  slot: number;
  sqrtPrice: bigint;
  tickCurrentIndex: number;
  liquidity: bigint;
  tickSpacing: number;
  feeRate: number;
  tokenMintA: string;
  tokenMintB: string;
}
export interface WhirlpoolTickArray {
  slot: number;
  address: string;
  startTickIndex: number;
  ticks: readonly { initialized: boolean; liquidityNet: bigint }[];
}
export interface WhirlpoolSnapshot {
  slot: number;
  poolAddress: string;
  pool: WhirlpoolState;
  tickArrays: readonly WhirlpoolTickArray[];
}

function unsigned(data: Uint8Array, offset: number, length: number): bigint {
  if (offset < 0 || offset + length > data.length) throw new Error("Truncated Whirlpool account");
  let value = 0n;
  for (let i = offset + length - 1; i >= offset; i--) value = (value << 8n) | BigInt(data[i]);
  return value;
}
function matches(data: Uint8Array, discriminator: readonly number[]): boolean {
  return discriminator.every((byte, i) => data[i] === byte);
}

export function decodeWhirlpool(data: Uint8Array, slot: number): WhirlpoolState {
  if (data.length !== 653 || !matches(data, WHIRLPOOL_DISCRIMINATOR)) throw new Error("Invalid Whirlpool account");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tickSpacing = view.getUint16(41, true);
  // Static fee tiers encode tick spacing here; adaptive tiers require oracle/clock math.
  if (view.getUint16(43, true) !== tickSpacing) throw new Error("Adaptive Whirlpool fees unsupported");
  const state = {
    slot, tickSpacing, feeRate: view.getUint16(45, true), liquidity: unsigned(data, 49, 16),
    sqrtPrice: unsigned(data, 65, 16), tickCurrentIndex: view.getInt32(81, true),
    tokenMintA: solanaPublicKey(data.subarray(101, 133)), tokenMintB: solanaPublicKey(data.subarray(181, 213)),
  };
  if (!Number.isSafeInteger(slot) || slot <= 0 || tickSpacing === 0 || state.tickCurrentIndex < MIN_TICK || state.tickCurrentIndex > MAX_TICK || state.sqrtPrice < tickSqrtPrice(MIN_TICK) || state.sqrtPrice > tickSqrtPrice(MAX_TICK) || state.tokenMintA === state.tokenMintB) throw new Error("Invalid Whirlpool state");
  return state;
}

export function decodeWhirlpoolTickArray(data: Uint8Array, address: string, poolAddress: string, tickSpacing: number, slot: number): WhirlpoolTickArray {
  const dynamic = matches(data, DYNAMIC_ARRAY_DISCRIMINATOR);
  if ((!dynamic && (!matches(data, FIXED_ARRAY_DISCRIMINATOR) || data.length !== 9988)) || (dynamic && (data.length < 148 || data.length > 10004))) throw new Error("Invalid Whirlpool tick array");
  const startTickIndex = new DataView(data.buffer, data.byteOffset, data.byteLength).getInt32(8, true);
  if (startTickIndex % (ARRAY_SIZE * tickSpacing) !== 0 || solanaPublicKey(data.subarray(dynamic ? 12 : 9956, dynamic ? 44 : 9988)) !== poolAddress) throw new Error("Whirlpool tick array binding mismatch");
  const bitmap = dynamic ? unsigned(data, 44, 16) : 0n;
  if (bitmap >> 88n) throw new Error("Invalid Whirlpool tick bitmap");
  const ticks: { initialized: boolean; liquidityNet: bigint }[] = [];
  let offset = dynamic ? 60 : 12;
  for (let i = 0; i < ARRAY_SIZE; i++) {
    const tag = data[offset];
    if (tag !== 0 && tag !== 1) throw new Error("Invalid Whirlpool tick tag");
    const initialized = tag === 1;
    if (dynamic && initialized !== ((bitmap & (1n << BigInt(i))) !== 0n)) throw new Error("Whirlpool tick bitmap mismatch");
    let liquidityNet = 0n;
    if (initialized) {
      liquidityNet = BigInt.asIntN(128, unsigned(data, offset + 1, 16));
      const gross = unsigned(data, offset + 17, 16);
      if (gross === 0n || (liquidityNet < 0n ? -liquidityNet : liquidityNet) > gross) throw new Error("Invalid Whirlpool tick liquidity");
    }
    ticks.push({ initialized, liquidityNet });
    offset += dynamic && !initialized ? 1 : 113;
  }
  if (dynamic && offset > data.length) throw new Error("Truncated Whirlpool tick array");
  return { slot, address, startTickIndex, ticks };
}

/**
 * PriceMath constants/formulas from Orca's Apache-2.0 revision
 * 964f84d88e9cc5a72a254f4d4e20c95b61789445 (legacy-sdk/whirlpool/src/utils/public/price-math.ts).
 * Copyright 2022 Orca Foundation. Licensed under the Apache License, Version 2.0:
 * https://www.apache.org/licenses/LICENSE-2.0
 * Distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND,
 * either express or implied. See the License for permissions and limitations.
 * Modified here to use native BigInt, without SDK runtime dependencies.
 * Positive ticks use Q96 intermediates; negative ticks use Q64.
 */

/** Exact-in only: never emits a partial-fill quote beyond the three-array window. */
export function quoteWhirlpoolExactIn(snapshot: WhirlpoolSnapshot, tokenMintIn: string, amountIn: bigint): { amountOut: bigint; slot: number } {
  const { pool, slot } = snapshot;
  if (!Number.isSafeInteger(slot) || slot <= 0 || pool.slot !== slot || snapshot.tickArrays.some((array) => array.slot !== slot)) throw new Error("Mixed Whirlpool account slots");
  if (pool.liquidity <= 0n || pool.liquidity > MAX_U128) throw new Error("Zero or invalid Whirlpool liquidity");
  if (amountIn <= 0n || amountIn > MAX_U64) throw new Error("Whirlpool input outside u64");
  if (tokenMintIn !== pool.tokenMintA && tokenMintIn !== pool.tokenMintB) throw new Error("Whirlpool input mint mismatch");
  if (!Number.isInteger(pool.feeRate) || pool.feeRate < 0 || pool.feeRate >= Number(FEE_DENOMINATOR)) throw new Error("Invalid Whirlpool fee");
  const aToB = tokenMintIn === pool.tokenMintA;
  const starts = tickArrayStarts(pool.tickCurrentIndex, pool.tickSpacing, aToB);
  const arrays = starts.map((start) => snapshot.tickArrays.find((array) => array.startTickIndex === start));
  let remaining = amountIn;
  let amountOut = 0n;
  let liquidity = pool.liquidity;
  let sqrtPrice = pool.sqrtPrice;
  const fee = BigInt(pool.feeRate);
  for (let arrayIndex = 0; arrayIndex < arrays.length; arrayIndex++) {
    const array = arrays[arrayIndex];
    if (!array) throw new Error("Missing required Whirlpool tick array");
    if (array.ticks.length !== ARRAY_SIZE) throw new Error("Invalid Whirlpool tick count");
    for (let position = 0; position < ARRAY_SIZE; position++) {
      const index = aToB ? ARRAY_SIZE - 1 - position : position;
      const tickIndex = array.startTickIndex + index * pool.tickSpacing;
      if (aToB ? tickIndex > pool.tickCurrentIndex : tickIndex <= pool.tickCurrentIndex) continue;
      const tick = array.ticks[index];
      if (!tick.initialized) continue;
      if (tickIndex < MIN_TICK || tickIndex > MAX_TICK) throw new Error("Initialized Whirlpool tick out of range");
      swapTo(tickSqrtPrice(tickIndex));
      if (remaining === 0n) return { amountOut, slot };
      liquidity += aToB ? -tick.liquidityNet : tick.liquidityNet;
      if (liquidity <= 0n || liquidity > MAX_U128) throw new Error("Zero or invalid Whirlpool liquidity after crossing");
    }
    // Array boundaries are not liquidity ticks: splitting a swap step there
    // would round both input and fee again. Only stop at the coverage edge.
    if (arrayIndex + 1 === arrays.length || !arrays[arrayIndex + 1]) {
      const boundary = aToB ? array.startTickIndex : array.startTickIndex + ARRAY_SIZE * pool.tickSpacing - 1;
      swapTo(tickSqrtPrice(Math.max(MIN_TICK, Math.min(MAX_TICK, boundary))));
      if (remaining === 0n) return { amountOut, slot };
    }
  }
  throw new Error("Whirlpool quote exceeds three tick arrays");

  function swapTo(target: bigint): void {
    if (aToB ? target > sqrtPrice : target < sqrtPrice) throw new Error("Invalid Whirlpool price direction");
    const available = remaining * (FEE_DENOMINATOR - fee) / FEE_DENOMINATOR;
    const required = delta(sqrtPrice, target, liquidity, aToB, true);
    let next = target;
    if (required > available) {
      if (available === 0n) {
        next = sqrtPrice;
      } else if (aToB) {
        const numerator = liquidity * sqrtPrice * Q64;
        if (numerator >= 1n << 256n) throw new Error("Whirlpool sqrt-price numerator overflow");
        next = ceilDiv(numerator, liquidity * Q64 + available * sqrtPrice);
      } else {
        next = sqrtPrice + available * Q64 / liquidity;
      }
    }
    const consumed = delta(sqrtPrice, next, liquidity, aToB, true);
    const feeAmount = next === target ? ceilDiv(consumed * fee, FEE_DENOMINATOR - fee) : remaining - consumed;
    const output = delta(sqrtPrice, next, liquidity, !aToB, false);
    if (consumed + feeAmount > remaining || output > MAX_U64 - amountOut) throw new Error("Whirlpool amount overflow");
    remaining -= consumed + feeAmount;
    amountOut += output;
    sqrtPrice = next;
  }
}

export function tickArrayStarts(tick: number, spacing: number, aToB: boolean): number[] {
  if (!Number.isInteger(spacing) || spacing <= 0 || spacing > 65535 || !Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) throw new Error("Invalid Whirlpool tick spacing");
  const width = ARRAY_SIZE * spacing;
  const first = Math.floor((tick + (aToB ? 0 : spacing)) / width) * width;
  return [0, 1, 2].map((i) => first + (aToB ? -i : i) * width).filter((start) => start <= MAX_TICK && start + width > MIN_TICK);
}


export async function whirlpoolTickArrayAddress(poolAddress: string, startTickIndex: number): Promise<string> {
  const encoder = new TextEncoder();
  const seeds = [encoder.encode("tick_array"), publicKeyBytes(poolAddress), encoder.encode(String(startTickIndex))];
  return programAddress(ORCA_WHIRLPOOL_PROGRAM_ID, seeds);
}

export async function fetchWhirlpoolSnapshot(poolAddress: string, discovery: Pick<WhirlpoolState, "tickCurrentIndex" | "tickSpacing" | "slot" | "tokenMintA" | "tokenMintB">, signal: AbortSignal, ctx?: AdapterContext, minContextSlot = discovery.slot, onBankCapture?: SolanaDexBankCaptureSink): Promise<WhirlpoolSnapshot & { mints: { slot: number; address: string; account: SolanaAccount }[] }> {
  const starts = [...new Set([...tickArrayStarts(discovery.tickCurrentIndex, discovery.tickSpacing, true), ...tickArrayStarts(discovery.tickCurrentIndex, discovery.tickSpacing, false)])];
  const addresses: string[] = [];
  for (const start of starts) addresses.push(await whirlpoolTickArrayAddress(poolAddress, start));
  const bankAddresses = [poolAddress, discovery.tokenMintA, discovery.tokenMintB, ...addresses];
  const batch = await fetchSolanaAccountBatch(bankAddresses, signal, ctx, Math.max(discovery.slot, minContextSlot));
  function ownedAccount(address: string): SolanaAccount | null {
    const account = batch.accounts.get(address) ?? null;
    if (account && account.owner !== ORCA_WHIRLPOOL_PROGRAM_ID) throw new Error("Whirlpool account owner mismatch");
    return account;
  }
  const account = ownedAccount(poolAddress);
  if (!account) throw new Error("Missing Whirlpool pool account");
  const pool = decodeWhirlpool(account.data, batch.slot);
  if (pool.tokenMintA !== discovery.tokenMintA || pool.tokenMintB !== discovery.tokenMintB) throw new Error("Whirlpool discovery identity changed");
  if (pool.tickSpacing !== discovery.tickSpacing || [...tickArrayStarts(pool.tickCurrentIndex, pool.tickSpacing, true), ...tickArrayStarts(pool.tickCurrentIndex, pool.tickSpacing, false)].some((start) => !starts.includes(start))) throw new Error("Whirlpool moved outside discovered tick arrays");
  const mints = [pool.tokenMintA, pool.tokenMintB].map((address) => {
    const mint = batch.accounts.get(address);
    if (!mint || mint.owner !== "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" || mint.data.length !== 82 || mint.data[45] !== 1 || mint.data[44] > 18) throw new Error("Whirlpool Token-2022/unsupported mint in final bank");
    return { slot: batch.slot, address, account: mint };
  });
  const tickArrays: WhirlpoolTickArray[] = [];
  for (let i = 0; i < addresses.length; i++) {
    const tickAccount = ownedAccount(addresses[i]);
    if (!tickAccount) continue;
    const array = decodeWhirlpoolTickArray(tickAccount.data, addresses[i], poolAddress, pool.tickSpacing, batch.slot);
    if (array.startTickIndex !== starts[i]) throw new Error("Whirlpool tick array PDA binding mismatch");
    tickArrays.push(array);
  }
  if (onBankCapture) await captureSolanaDexBank({ profileId: "orca-whirlpool-exact-v1", poolAddress, slot: batch.slot, addresses: bankAddresses, accounts: batch.accounts, sink: onBankCapture });
  return { slot: batch.slot, poolAddress, pool, tickArrays, mints };
}
