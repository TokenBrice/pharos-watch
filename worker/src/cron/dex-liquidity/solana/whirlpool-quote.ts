import { fetchSolanaAccountBatch, solanaPublicKey, type SolanaAccount } from "../../reserve-adapters/solana";
import type { AdapterContext } from "../../reserve-adapters/types";

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
const POSITIVE_FACTORS = [79232123823359799118286999567n,79236085330515764027303304731n,79244008939048815603706035061n,79259858533276714757314932305n,79291567232598584799939703904n,79355022692464371645785046466n,79482085999252804386437311141n,79736823300114093921829183326n,80248749790819932309965073892n,81282483887344747381513967011n,83390072131320151908154831281n,87770609709833776024991924138n,97234110755111693312479820773n,119332217159966728226237229890n,179736315981702064433883588727n,407748233172238350107850275304n,2098478828474011932436660412517n,55581415166113811149459800483533n,38992368544603139932233054999993551n];
const NEGATIVE_FACTORS = [18445821805675392311n,18444899583751176498n,18443055278223354162n,18439367220385604838n,18431993317065449817n,18417254355718160513n,18387811781193591352n,18329067761203520168n,18212142134806087854n,17980523815641551639n,17526086738831147013n,16651378430235024244n,15030750278693429944n,12247334978882834399n,8131365268884726200n,3584323654723342297n,696457651847595233n,26294789957452057n,37481735321082n];
export function tickSqrtPrice(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) throw new Error("Whirlpool tick out of range");
  const positive = tick > 0;
  const shift = positive ? 96n : 64n;
  const factors = positive ? POSITIVE_FACTORS : NEGATIVE_FACTORS;
  let ratio = 1n << shift;
  const absolute = Math.abs(tick);
  for (let i = 0; i < factors.length; i++) if (absolute & (1 << i)) ratio = (ratio * factors[i]) >> shift;
  return positive ? ratio >> 32n : ratio;
}
function ceilDiv(n: bigint, d: bigint): bigint { return (n + d - 1n) / d; }
function delta(a: bigint, b: bigint, liquidity: bigint, tokenA: boolean, roundUp: boolean): bigint {
  const difference = a > b ? a - b : b - a;
  const numerator = liquidity * difference * (tokenA ? Q64 : 1n);
  const denominator = tokenA ? a * b : Q64;
  return roundUp ? ceilDiv(numerator, denominator) : numerator / denominator;
}

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

function publicKeyBytes(address: string): Uint8Array {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  if (address.length < 32 || address.length > 44) throw new Error("Invalid Solana address");
  let value = 0n;
  for (const character of address) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) throw new Error("Invalid Solana address");
    value = value * 58n + BigInt(digit);
  }
  const bytes = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) { bytes[i] = Number(value & 255n); value >>= 8n; }
  if (value !== 0n || solanaPublicKey(bytes) !== address) throw new Error("Invalid Solana address");
  return bytes;
}
const FIELD = (1n << 255n) - 19n;
function modPow(base: bigint, power: bigint): bigint {
  let result = 1n;
  base = ((base % FIELD) + FIELD) % FIELD;
  while (power > 0n) { if (power & 1n) result = result * base % FIELD; base = base * base % FIELD; power >>= 1n; }
  return result;
}
const EDWARDS_D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;
function isEd25519Point(bytes: Uint8Array): boolean {
  const y = unsigned(bytes, 0, 32) & ((1n << 255n) - 1n);
  const square = y * y % FIELD;
  // x²=(y²-1)/(d*y²+1); quadratic character is unchanged by multiplying
  // instead of dividing the denominator (avoids a second modular exponent).
  const numerator = (square + FIELD - 1n) % FIELD;
  const denominator = (EDWARDS_D * square + 1n) % FIELD;
  if (denominator === 0n) return false;
  return numerator === 0n || modPow(numerator * denominator, (FIELD - 1n) / 2n) === 1n;
}

export async function whirlpoolTickArrayAddress(poolAddress: string, startTickIndex: number): Promise<string> {
  const encoder = new TextEncoder();
  const seeds = [encoder.encode("tick_array"), publicKeyBytes(poolAddress), encoder.encode(String(startTickIndex))];
  const suffix = [publicKeyBytes(ORCA_WHIRLPOOL_PROGRAM_ID), encoder.encode("ProgramDerivedAddress")];
  const size = seeds.reduce((total, seed) => total + seed.length, 1) + suffix.reduce((total, seed) => total + seed.length, 0);
  const input = new Uint8Array(size);
  let offset = 0;
  for (const seed of seeds) { input.set(seed, offset); offset += seed.length; }
  const bumpOffset = offset++;
  for (const seed of suffix) { input.set(seed, offset); offset += seed.length; }
  for (let bump = 255; bump >= 0; bump--) {
    input[bumpOffset] = bump;
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
    if (!isEd25519Point(hash)) return solanaPublicKey(hash);
  }
  throw new Error("Unable to derive Whirlpool tick array PDA");
}

export async function fetchWhirlpoolSnapshot(poolAddress: string, discovery: { tickCurrentIndex: number; tickSpacing: number }, signal: AbortSignal, ctx?: AdapterContext): Promise<WhirlpoolSnapshot> {
  const starts = [...new Set([...tickArrayStarts(discovery.tickCurrentIndex, discovery.tickSpacing, true), ...tickArrayStarts(discovery.tickCurrentIndex, discovery.tickSpacing, false)])];
  const addresses: string[] = [];
  for (const start of starts) addresses.push(await whirlpoolTickArrayAddress(poolAddress, start));
  const batch = await fetchSolanaAccountBatch([poolAddress, ...addresses], signal, ctx);
  function ownedAccount(address: string): SolanaAccount | null {
    const account = batch.accounts.get(address) ?? null;
    if (account && account.owner !== ORCA_WHIRLPOOL_PROGRAM_ID) throw new Error("Whirlpool account owner mismatch");
    return account;
  }
  const account = ownedAccount(poolAddress);
  if (!account) throw new Error("Missing Whirlpool pool account");
  const pool = decodeWhirlpool(account.data, batch.slot);
  if (pool.tickSpacing !== discovery.tickSpacing || [...tickArrayStarts(pool.tickCurrentIndex, pool.tickSpacing, true), ...tickArrayStarts(pool.tickCurrentIndex, pool.tickSpacing, false)].some((start) => !starts.includes(start))) throw new Error("Whirlpool moved outside discovered tick arrays");
  const tickArrays: WhirlpoolTickArray[] = [];
  for (let i = 0; i < addresses.length; i++) {
    const tickAccount = ownedAccount(addresses[i]);
    if (!tickAccount) continue;
    const array = decodeWhirlpoolTickArray(tickAccount.data, addresses[i], poolAddress, pool.tickSpacing, batch.slot);
    if (array.startTickIndex !== starts[i]) throw new Error("Whirlpool tick array PDA binding mismatch");
    tickArrays.push(array);
  }
  return { slot: batch.slot, poolAddress, pool, tickArrays };
}
