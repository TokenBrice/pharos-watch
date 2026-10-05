import { fetchSolanaAccountBatch, solanaPublicKey, type SolanaAccount } from "../../reserve-adapters/solana";
import type { AdapterContext } from "../../reserve-adapters/types";
import { programAddress, publicKeyBytes } from "./program-address";

export const METEORA_DLMM_PROGRAM_ID = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
export const METEORA_DLMM_PROFILE_ID = "meteora-dlmm-exact-v1";
const CLOCK = "SysvarC1ock11111111111111111111111111111111";
const SYSVAR_OWNER = "Sysvar1111111111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const Q64 = 1n << 64n;
const MAX_U64 = Q64 - 1n;
const MAX_U128 = (1n << 128n) - 1n;
const FEE_PRECISION = 1_000_000_000n;
const MAX_FEE_RATE = 100_000_000n;
const BPS = 10_000n;
const BINS_PER_ARRAY = 70;
const ARRAY_COUNT = 4;
const PAIR_DISCRIMINATOR = [33, 11, 49, 98, 181, 101, 177, 13];
const ARRAY_DISCRIMINATOR = [92, 142, 92, 220, 5, 148, 70, 181];

export interface DlmmPair {
  slot: number;
  activeId: number;
  binStep: number;
  tokenMintX: string;
  tokenMintY: string;
  baseFactor: number;
  baseFeePowerFactor: number;
  filterPeriod: number;
  decayPeriod: number;
  reductionFactor: number;
  variableFeeControl: number;
  maxVolatilityAccumulator: number;
  minBinId: number;
  maxBinId: number;
  protocolShare: number;
  volatilityAccumulator: number;
  volatilityReference: number;
  indexReference: number;
  lastUpdateTimestamp: bigint;
  supportLimitOrder: boolean;
  collectFeeMode: number;
  bitmap: bigint;
  pairType: number;
  activationType: number;
  activationPoint: bigint;
}
export interface DlmmBin {
  amountX: bigint;
  amountY: bigint;
  price: bigint;
  openOrderAmount: bigint;
  processedOrderRemainingAmount: bigint;
  limitOrderAskSide: boolean;
}
export interface DlmmBinArray {
  slot: number;
  address: string;
  poolAddress: string;
  index: number;
  version: number;
  bins: readonly DlmmBin[];
}
export interface DlmmSnapshot {
  slot: number;
  poolAddress: string;
  pool: DlmmPair;
  timestamp: bigint;
  clockSlot: bigint;
  mintDecimals: readonly [number, number];
  /** Includes null accounts: observed absence, never a failed/missing read. */
  binArrays: readonly { index: number; array: DlmmBinArray | null }[];
}
export interface DlmmQuote {
  slot: number;
  amountOut: bigint;
  /** LP/limit-order fee and protocol fee are disjoint, in the charged token. */
  fee: bigint;
  protocolFee: bigint;
  feeOnInput: boolean;
  binsFilled: number;
  endBinId: number;
}

function unsigned(data: Uint8Array, offset: number, length: number): bigint {
  if (offset < 0 || offset + length > data.length) throw new Error("dlmm-truncated-account");
  let value = 0n;
  for (let i = offset + length - 1; i >= offset; i--) value = (value << 8n) | BigInt(data[i]);
  return value;
}
function ceilDiv(n: bigint, d: bigint): bigint { return (n + d - 1n) / d; }
function u64(value: bigint): bigint {
  if (value < 0n || value > MAX_U64) throw new Error("dlmm-u64-overflow");
  return value;
}

/** IDL 0.12.0 account layouts; unknown versions and Token-2022 fail closed. */
export function decodeDlmmPair(data: Uint8Array, slot: number): DlmmPair {
  if (data.length !== 904 || !PAIR_DISCRIMINATOR.every((byte, i) => data[i] === byte)) throw new Error("dlmm-invalid-pair-account");
  if (!Number.isSafeInteger(slot) || slot <= 0) throw new Error("dlmm-invalid-slot");
  if (data[82] !== 0) throw new Error("dlmm-pool-disabled");
  if (data[880] !== 0 || data[881] !== 0) throw new Error("dlmm-token-2022-unsupported");
  if (data[882] > 1 || data[35] > 2 || data[36] > 1 || data[75] > 3 || data[86] > 1) throw new Error("dlmm-unsupported-pair-version");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const noRewards = unsigned(data, 264, 32) === 0n && unsigned(data, 408, 32) === 0n;
  const pool: DlmmPair = {
    slot, baseFactor: view.getUint16(8, true), filterPeriod: view.getUint16(10, true),
    decayPeriod: view.getUint16(12, true), reductionFactor: view.getUint16(14, true),
    variableFeeControl: view.getUint32(16, true), maxVolatilityAccumulator: view.getUint32(20, true),
    minBinId: view.getInt32(24, true), maxBinId: view.getInt32(28, true), protocolShare: view.getUint16(32, true),
    baseFeePowerFactor: data[34], supportLimitOrder: data[35] === 2 || (data[35] === 0 && noRewards), collectFeeMode: data[36],
    volatilityAccumulator: view.getUint32(40, true), volatilityReference: view.getUint32(44, true),
    indexReference: view.getInt32(48, true), lastUpdateTimestamp: BigInt.asIntN(64, unsigned(data, 56, 8)),
    activeId: view.getInt32(76, true), binStep: view.getUint16(80, true),
    tokenMintX: solanaPublicKey(data.subarray(88, 120)), tokenMintY: solanaPublicKey(data.subarray(120, 152)),
    bitmap: unsigned(data, 584, 128), pairType: data[75], activationType: data[86], activationPoint: unsigned(data, 816, 8),
  };
  if (pool.binStep < 1 || pool.binStep > 400 || pool.baseFeePowerFactor > 38 || pool.protocolShare > 2500 || pool.reductionFactor > 10000 || pool.minBinId > pool.activeId || pool.maxBinId < pool.activeId || Math.abs(pool.activeId) > 351639 || pool.tokenMintX === pool.tokenMintY || pool.lastUpdateTimestamp < 0n) throw new Error("dlmm-invalid-pair-state");
  return pool;
}

export function decodeDlmmBinArray(data: Uint8Array, address: string, poolAddress: string, slot: number): DlmmBinArray {
  if (data.length !== 10136 || !ARRAY_DISCRIMINATOR.every((byte, i) => data[i] === byte) || data[16] > 3) throw new Error("dlmm-invalid-bin-array");
  if (solanaPublicKey(data.subarray(24, 56)) !== poolAddress) throw new Error("dlmm-bin-array-identity-mismatch");
  const rawIndex = BigInt.asIntN(64, unsigned(data, 8, 8));
  if (rawIndex < -5024n || rawIndex > 5023n) throw new Error("dlmm-bin-array-index-invalid");
  const bins: DlmmBin[] = [];
  for (let i = 0; i < BINS_PER_ARRAY; i++) {
    const offset = 56 + i * 144;
    if (data[16] === 3 && data[offset + 140] > 1) throw new Error("dlmm-invalid-order-side");
    bins.push({ amountX: unsigned(data, offset, 8), amountY: unsigned(data, offset + 8, 8), price: unsigned(data, offset + 16, 16),
      // Pre-v3 fields were liquidity-mining reward counters, not order inventory.
      openOrderAmount: data[16] === 3 ? unsigned(data, offset + 112, 8) : 0n,
      processedOrderRemainingAmount: data[16] === 3 ? unsigned(data, offset + 128, 8) : 0n,
      limitOrderAskSide: data[16] === 3 && data[offset + 140] === 1 });
  }
  return { slot, address, poolAddress, index: Number(rawIndex), version: data[16], bins };
}

/**
 * Native BigInt adaptation of Meteora's ISC-licensed SDK, revision
 * 576919e3e4368e542c402f000b4264724f7f23ec, helpers/{bin,fee,u64xu64_math}.ts
 * and DLMM.updateReference/updateVolatilityAccumulator.
 * License declaration: https://github.com/MeteoraAg/dlmm-sdk/blob/576919e3e4368e542c402f000b4264724f7f23ec/ts-client/package.json
 */
export function dlmmBinPrice(id: number, binStep: number): bigint {
  if (!Number.isInteger(id) || Math.abs(id) > 351639 || !Number.isInteger(binStep) || binStep < 1 || binStep > 400) throw new Error("dlmm-price-domain-invalid");
  if (id === 0) return Q64;
  let base = Q64 + BigInt(binStep) * Q64 / BPS;
  let invert = id < 0;
  if (base >= Q64) { base = MAX_U128 / base; invert = !invert; }
  let result = Q64;
  const exponent = Math.abs(id);
  for (let i = 0; i < 19; i++) {
    if (exponent & (1 << i)) result = result * base >> 64n;
    if (i < 18) base = base * base >> 64n;
  }
  if (result === 0n) throw new Error("dlmm-price-overflow");
  return invert ? MAX_U128 / result : result;
}

export function dlmmTotalFee(pool: DlmmPair, volatilityAccumulator: number): bigint {
  const base = BigInt(pool.baseFactor) * BigInt(pool.binStep) * 10n * 10n ** BigInt(pool.baseFeePowerFactor);
  const volatility = BigInt(volatilityAccumulator) * BigInt(pool.binStep);
  const variable = ceilDiv(BigInt(pool.variableFeeControl) * volatility * volatility, 100_000_000_000n);
  if (base > MAX_U128 || variable > MAX_U128) throw new Error("dlmm-fee-overflow");
  return base + variable > MAX_FEE_RATE ? MAX_FEE_RATE : base + variable;
}

/** Full exact-in or an explicit coverage error: never a fabricated partial fill. */
export function quoteDlmmExactIn(snapshot: DlmmSnapshot, tokenMintIn: string, amountIn: bigint): DlmmQuote {
  const { pool, slot } = snapshot;
  if (!Number.isSafeInteger(slot) || slot <= 0 || pool.slot !== slot || snapshot.clockSlot !== BigInt(slot) || snapshot.binArrays.some(({ array }) => array && array.slot !== slot)) throw new Error("dlmm-mixed-account-slots");
  if (snapshot.timestamp < pool.lastUpdateTimestamp) throw new Error("dlmm-stale-clock");
  if (pool.pairType !== 0 && (pool.activationType === 0 ? snapshot.clockSlot : snapshot.timestamp) < pool.activationPoint) throw new Error("dlmm-pool-not-activated");
  if (amountIn <= 0n || amountIn > MAX_U64) throw new Error("dlmm-input-outside-u64");
  if (tokenMintIn !== pool.tokenMintX && tokenMintIn !== pool.tokenMintY) throw new Error("dlmm-input-mint-mismatch");
  const swapForY = tokenMintIn === pool.tokenMintX;
  const feeOnInput = pool.collectFeeMode === 0 || !swapForY;
  const elapsed = snapshot.timestamp - pool.lastUpdateTimestamp;
  const indexReference = elapsed >= BigInt(pool.filterPeriod) ? pool.activeId : pool.indexReference;
  const volatilityReference = elapsed < BigInt(pool.filterPeriod) ? pool.volatilityReference
    : elapsed < BigInt(pool.decayPeriod) ? Number(BigInt(pool.volatilityAccumulator) * BigInt(pool.reductionFactor) / BPS) : 0;
  let remaining = amountIn;
  let amountOut = 0n;
  let fee = 0n;
  let protocolFee = 0n;
  let binsFilled = 0;
  let activeId = pool.activeId;
  const first = Math.floor(activeId / BINS_PER_ARRAY);
  for (let step = 0; step < ARRAY_COUNT; step++) {
    const index = first + (swapForY ? -step : step);
    const entry = snapshot.binArrays.find((row) => row.index === index);
    if (!entry) throw new Error("dlmm-bin-array-coverage-exhausted");
    const array = entry.array;
    if (array && (array.index !== index || array.poolAddress !== snapshot.poolAddress || array.bins.length !== BINS_PER_ARRAY)) throw new Error("dlmm-bin-array-identity-mismatch");
    if (!array) {
      if (index < -512 || index >= 512 || (pool.bitmap & (1n << BigInt(index + 512))) !== 0n) throw new Error("dlmm-missing-initialized-bin-array");
      activeId = swapForY ? index * BINS_PER_ARRAY - 1 : (index + 1) * BINS_PER_ARRAY;
      continue;
    }
    while (Math.floor(activeId / BINS_PER_ARRAY) === index) {
      if (activeId < pool.minBinId || activeId > pool.maxBinId) throw new Error("dlmm-insufficient-liquidity");
      const bin = array.bins[activeId - index * BINS_PER_ARRAY];
      const mm = swapForY ? bin.amountY : bin.amountX;
      const matchingOrder = pool.supportLimitOrder && array.version === 3 && bin.limitOrderAskSide !== swapForY;
      const inventories = [mm, matchingOrder ? bin.processedOrderRemainingAmount : 0n, matchingOrder ? bin.openOrderAmount : 0n];
      if (inventories.some((amount) => amount > 0n)) {
        const price = bin.price === 0n ? dlmmBinPrice(activeId, pool.binStep) : bin.price;
        const volatility = Math.min(volatilityReference + Math.abs(indexReference - activeId) * 10000, pool.maxVolatilityAccumulator);
        const rate = dlmmTotalFee(pool, volatility);
        let tradingFee = feeOnInput ? ceilDiv(remaining * rate, FEE_PRECISION) : 0n;
        const available = remaining - tradingFee;
        let left = available;
        let output = 0n;
        let mmInput = 0n;
        for (let i = 0; i < inventories.length; i++) {
          if (left === 0n) break;
          const capacity = inventories[i];
          const required = u64(swapForY ? ceilDiv(capacity * Q64, price) : ceilDiv(capacity * price, Q64));
          const consumed = left >= required ? required : left;
          output += left >= required ? capacity : swapForY ? consumed * price / Q64 : consumed * Q64 / price;
          if (i === 0) mmInput = consumed;
          left -= consumed;
        }
        const consumed = available - left;
        let included = remaining;
        if (left !== 0n) {
          included = feeOnInput ? ceilDiv(consumed * FEE_PRECISION, FEE_PRECISION - rate) : consumed;
          tradingFee = feeOnInput ? included - consumed : 0n;
        }
        if (!feeOnInput) { tradingFee = ceilDiv(output * rate, FEE_PRECISION); output -= tradingFee; }
        // MM receives ceil-proportional fees; limit-order fees split 50/50.
        const mmFee = consumed === 0n ? 0n : ceilDiv(tradingFee * mmInput, consumed);
        const loFee = consumed === 0n ? 0n : tradingFee - mmFee;
        const protocol = mmFee * BigInt(pool.protocolShare) / BPS + loFee - loFee * 5000n / BPS;
        u64(mmInput + (swapForY ? bin.amountX : bin.amountY));
        remaining -= u64(included);
        amountOut = u64(amountOut + output);
        fee = u64(fee + (consumed === 0n ? 0n : tradingFee - protocol));
        protocolFee = u64(protocolFee + protocol);
        if (included > 0n) binsFilled++;
        if (remaining === 0n) return { slot, amountOut, fee, protocolFee, feeOnInput, binsFilled, endBinId: activeId };
      }
      activeId += swapForY ? -1 : 1;
    }
  }
  throw new Error("dlmm-bin-array-coverage-exhausted");
}

export async function dlmmBinArrayAddress(poolAddress: string, index: number): Promise<string> {
  if (!Number.isSafeInteger(index)) throw new Error("dlmm-bin-array-index-invalid");
  const seed = new Uint8Array(8);
  new DataView(seed.buffer).setBigInt64(0, BigInt(index), true);
  return programAddress(METEORA_DLMM_PROGRAM_ID, [new TextEncoder().encode("bin_array"), publicKeyBytes(poolAddress), seed]);
}

/** Pool + four arrays + both mints + Clock share one getMultipleAccounts bank. */
export async function fetchDlmmSnapshot(poolAddress: string, discovery: DlmmPair, tokenMintIn: string, signal: AbortSignal, ctx?: AdapterContext, minContextSlot = discovery.slot): Promise<DlmmSnapshot> {
  if (tokenMintIn !== discovery.tokenMintX && tokenMintIn !== discovery.tokenMintY) throw new Error("dlmm-input-mint-mismatch");
  const direction = tokenMintIn === discovery.tokenMintX ? -1 : 1;
  const first = Math.floor(discovery.activeId / BINS_PER_ARRAY);
  const indexes = Array.from({ length: ARRAY_COUNT }, (_, i) => first + direction * i);
  const addresses: string[] = [];
  for (const index of indexes) addresses.push(await dlmmBinArrayAddress(poolAddress, index));
  const batch = await fetchSolanaAccountBatch([poolAddress, ...addresses, discovery.tokenMintX, discovery.tokenMintY, CLOCK], signal, ctx, minContextSlot);
  function owned(address: string, owner: string): SolanaAccount | null {
    if (!batch.accounts.has(address)) throw new Error("dlmm-incomplete-account-batch");
    const account = batch.accounts.get(address) ?? null;
    if (account && account.owner !== owner) throw new Error("dlmm-account-owner-mismatch");
    return account;
  }
  if (batch.slot < minContextSlot) throw new Error("dlmm-stale-slot");
  const account = owned(poolAddress, METEORA_DLMM_PROGRAM_ID);
  if (!account) throw new Error("dlmm-missing-pair-account");
  const pool = decodeDlmmPair(account.data, batch.slot);
  if (pool.tokenMintX !== discovery.tokenMintX || pool.tokenMintY !== discovery.tokenMintY || pool.binStep !== discovery.binStep || Math.floor(pool.activeId / BINS_PER_ARRAY) !== first) throw new Error("dlmm-discovery-identity-changed");
  const clock = owned(CLOCK, SYSVAR_OWNER);
  if (!clock || clock.data.length !== 40) throw new Error("dlmm-invalid-clock");
  const decimals = [pool.tokenMintX, pool.tokenMintY].map((mint) => {
    const account = owned(mint, TOKEN_PROGRAM);
    if (!account || account.data.length !== 82 || account.data[45] !== 1 || account.data[44] > 18) throw new Error("dlmm-unsupported-token-mint");
    return account.data[44];
  }) as [number, number];
  const binArrays = addresses.map((address, i) => {
    const account = owned(address, METEORA_DLMM_PROGRAM_ID);
    const array = account ? decodeDlmmBinArray(account.data, address, poolAddress, batch.slot) : null;
    if (array && array.index !== indexes[i]) throw new Error("dlmm-bin-array-pda-mismatch");
    return { index: indexes[i], array };
  });
  return { slot: batch.slot, poolAddress, pool, timestamp: BigInt.asIntN(64, unsigned(clock.data, 32, 8)), clockSlot: unsigned(clock.data, 0, 8), mintDecimals: decimals, binArrays };
}
