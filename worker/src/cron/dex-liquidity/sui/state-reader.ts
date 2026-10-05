import { isRecord } from "@shared/lib/type-guards";
import { DEX_MEASURED_FRESHNESS_MAX_SEC, type DexRequestBudget } from "@shared/types/measured-execution";
import { readDexApiJson } from "../direct-api-json";
import { tickSqrtPrice } from "../solana/whirlpool-quote";
import { SUI_CLMM_DEPLOYMENTS, suiCoinType, suiObjectId, type SuiClmmFamily } from "./identity";
import type { SuiTransactionCheckpointResolver } from "./archival-checkpoints";

export type SuiRpc = (method: string, params: readonly unknown[]) => Promise<unknown>;
export const SUI_CLMM_MAX_TICKS = 256;
const OBJECT_OPTIONS = { showContent: true, showOwner: true, showPreviousTransaction: true };

/** One request and fully consumed, capped body at a time; errors never expose the endpoint/auth. */
export function createSuiClmmRpc(input: {
  url: string; headers?: HeadersInit; signal: AbortSignal; budget: DexRequestBudget;
  onResponse?: () => void;
}): SuiRpc {
  let id = 0;
  let busy = false;
  return async (method, params) => {
    if (busy) throw new Error("sui-rpc-concurrent-request");
    if (input.signal.aborted || !input.budget.tryConsume()) throw new Error("sui-rpc-budget-exhausted");
    busy = true;
    try {
      const headers = new Headers(input.headers);
      headers.set("content-type", "application/json");
      const response = await fetch(input.url, { method: "POST", headers, signal: input.signal,
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
      const parsed = await readDexApiJson<Record<string, unknown>>(response, "sui-clmm", 2 * 1024 * 1024);
      input.onResponse?.();
      if (!response.ok || !parsed.ok || !isRecord(parsed.data) || parsed.data.id !== id || parsed.data.error != null || !("result" in parsed.data)) {
        throw new Error(`sui-rpc-response-failed:${method}`);
      }
      return parsed.data.result;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("sui-")) throw error;
      throw new Error(`sui-rpc-transport-failed:${method}`);
    } finally { busy = false; }
  };
}

export function moveFields(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value.fields)) throw new Error("sui-invalid-move-fields");
  return value.fields;
}
export function suiUint(value: unknown, bits = 64): bigint {
  if (!(typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) && !(typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) throw new Error("sui-invalid-integer");
  const result = BigInt(value);
  if (result < 0n || result >= 1n << BigInt(bits)) throw new Error("sui-integer-overflow");
  return result;
}
export function suiObject(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value.data) || value.error != null) throw new Error("sui-object-unavailable");
  const data = value.data;
  if (typeof data.objectId !== "string" || !suiObjectId(data.objectId) || typeof data.digest !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(data.digest) || typeof data.previousTransaction !== "string") throw new Error("sui-invalid-object-reference");
  suiUint(data.version);
  return data;
}
function nestedId(value: unknown): string {
  const fields = moveFields(value);
  if (!isRecord(fields.id) || typeof fields.id.id !== "string") throw new Error("sui-table-id-missing");
  const id = suiObjectId(fields.id.id);
  if (!id) throw new Error("sui-table-id-invalid");
  return id;
}

export interface SuiClmmTick { index: number; sqrtPrice: bigint; liquidityNet: bigint; liquidityGross: bigint }
export interface SuiClmmPool {
  family: SuiClmmFamily; poolId: string; coinA: string; coinB: string;
  sqrtPrice: bigint; currentTick: number; liquidity: bigint; tickSpacing: number;
  feePips: number; protocolFeeRate: number; tickTable: string; tickCount: number;
  bitmapTable: string | null; bitmapCount: number; initialSharedVersion: string;
}
export interface SuiClmmCapture {
  family: SuiClmmFamily;
  checkpoint: unknown;
  objects: unknown[];
  transactions: unknown[];
  finalObjects: unknown[];
}
export interface SuiClmmSnapshot {
  checkpoint: string; checkpointDigest: string; timestampMs: number;
  pool: SuiClmmPool; ticks: readonly SuiClmmTick[];
  references: readonly { objectId: string; version: string; digest: string; transaction: string; transactionCheckpoint: string }[];
}

export function decodeSuiClmmPool(data: Record<string, unknown>, family: SuiClmmFamily, config?: Record<string, unknown>): SuiClmmPool {
  const deployment = SUI_CLMM_DEPLOYMENTS[family];
  if (!isRecord(data.content) || typeof data.content.type !== "string" || !isRecord(data.owner) || !isRecord(data.owner.Shared)) throw new Error("sui-pool-identity-mismatch");
  const match = /^(0x[a-f0-9]{64})::pool::Pool<([^,<>]+),\s*([^,<>]+)>$/.exec(data.content.type);
  if (!match || match[1] !== deployment.typePackage) throw new Error("sui-pool-identity-mismatch");
  const coinA = suiCoinType(match[2]);
  const coinB = suiCoinType(match[3]);
  if (!coinA || !coinB || coinA === coinB) throw new Error("sui-pool-identity-mismatch");
  const fields = moveFields(data.content);
  if (fields[family === "cetus" ? "is_pause" : "is_paused"] !== false) throw new Error("sui-pool-paused-or-unknown");
  const manager = moveFields(fields[family === "cetus" ? "tick_manager" : "ticks_manager"]);
  const tickTable = nestedId(manager.ticks);
  const tickCount = Number(suiUint(moveFields(manager.ticks).size));
  const bitmapTable = family === "bluefin" ? nestedId(manager.bitmap) : null;
  const bitmapCount = bitmapTable ? Number(suiUint(moveFields(manager.bitmap).size)) : 0;
  const tickSpacing = Number(suiUint(manager.tick_spacing, 32));
  const currentTick = Number(BigInt.asIntN(32, suiUint(moveFields(fields.current_tick_index).bits, 32)));
  const sqrtPrice = suiUint(fields.current_sqrt_price, 128);
  const feePips = Number(suiUint(fields.fee_rate));
  const protocolFeeRate = Number(suiUint(family === "cetus" ? moveFields(config?.content).protocol_fee_rate : fields.protocol_fee_share));
  if (tickCount > SUI_CLMM_MAX_TICKS || bitmapCount > SUI_CLMM_MAX_TICKS || tickSpacing <= 0 || tickSpacing > 65535 || feePips >= 1_000_000 || protocolFeeRate > (family === "cetus" ? 10_000 : 1_000_000) || currentTick < -443637 || currentTick > 443636 || sqrtPrice < tickSqrtPrice(-443636) || sqrtPrice > tickSqrtPrice(443636)) throw new Error("sui-invalid-pool-state");
  // A downward crossing can leave currentTick one below the price's exact tick.
  if (sqrtPrice < tickSqrtPrice(Math.max(-443636, currentTick)) || (currentTick < 443636 && sqrtPrice > tickSqrtPrice(currentTick + 1))) throw new Error("sui-pool-tick-price-mismatch");
  return { family, poolId: String(data.objectId), coinA, coinB, sqrtPrice, currentTick,
    liquidity: suiUint(fields.liquidity, 128), tickSpacing, feePips, protocolFeeRate,
    tickTable, tickCount, bitmapTable, bitmapCount,
    initialSharedVersion: suiUint(data.owner.Shared.initial_shared_version).toString() };
}

/** Latest-object reads are not a checkpoint selector. Finalized previous-transaction pins
 * plus unchanged full object references prove the complete read set existed at this checkpoint. */
export function decodeSuiClmmSnapshot(capture: SuiClmmCapture, nowSec: number, expected: { poolId: string; coinA?: string; coinB?: string }): SuiClmmSnapshot {
  if (!isRecord(capture.checkpoint)) throw new Error("sui-checkpoint-missing");
  const checkpoint = suiUint(capture.checkpoint.sequenceNumber).toString();
  const timestampMs = Number(suiUint(capture.checkpoint.timestampMs));
  const checkpointSec = Math.floor(timestampMs / 1000);
  if (!Number.isSafeInteger(timestampMs) || !Number.isSafeInteger(nowSec) || checkpointSec > nowSec || nowSec - checkpointSec > DEX_MEASURED_FRESHNESS_MAX_SEC) throw new Error("sui-stale-or-future-checkpoint");
  if (typeof capture.checkpoint.digest !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(capture.checkpoint.digest)) throw new Error("sui-checkpoint-digest-missing");
  const objects = capture.objects.map(suiObject);
  const finalObjects = capture.finalObjects.map(suiObject);
  const byId = new Map(objects.map((object) => [String(object.objectId), object]));
  const finalById = new Map(finalObjects.map((object) => [String(object.objectId), object]));
  if (byId.size !== objects.length || finalById.size !== objects.length) throw new Error("sui-object-census-mismatch");
  const transactions = new Map(capture.transactions.map((transaction) => {
    if (!isRecord(transaction) || typeof transaction.digest !== "string" || transaction.checkpoint == null) throw new Error("sui-transaction-not-finalized");
    return [transaction.digest, suiUint(transaction.checkpoint).toString()] as const;
  }));
  const references = objects.map((object) => {
    const final = finalById.get(String(object.objectId));
    const txCheckpoint = transactions.get(String(object.previousTransaction));
    if (!final || final.version !== object.version || final.digest !== object.digest || final.previousTransaction !== object.previousTransaction) throw new Error("sui-object-changed-during-capture");
    if (txCheckpoint == null || BigInt(txCheckpoint) > BigInt(checkpoint)) throw new Error("sui-object-newer-than-checkpoint");
    return { objectId: String(object.objectId), version: String(object.version), digest: String(object.digest), transaction: String(object.previousTransaction), transactionCheckpoint: txCheckpoint };
  });
  const poolData = byId.get(suiObjectId(expected.poolId) ?? "");
  if (!poolData) throw new Error("sui-pool-identity-mismatch");
  const configId = SUI_CLMM_DEPLOYMENTS[capture.family].configId;
  const config = configId ? byId.get(configId) : undefined;
  if (configId && (!config || !isRecord(config.content) || config.content.type !== `${SUI_CLMM_DEPLOYMENTS.cetus.typePackage}::config::GlobalConfig`)) throw new Error("sui-config-identity-mismatch");
  const pool = decodeSuiClmmPool(poolData, capture.family, config);
  if ((expected.coinA != null && suiCoinType(expected.coinA) !== pool.coinA) || (expected.coinB != null && suiCoinType(expected.coinB) !== pool.coinB)) throw new Error("sui-coin-identity-mismatch");
  const ticks: SuiClmmTick[] = [];
  const bitmaps = new Map<number, bigint>();
  for (const object of objects) {
    if (object === poolData || object === config) continue;
    if (!isRecord(object.owner) || !isRecord(object.content)) throw new Error("sui-tick-owner-mismatch");
    const fields = moveFields(object.content);
    if (object.owner.ObjectOwner === pool.bitmapTable) {
      const word = Number(BigInt.asIntN(32, suiUint(moveFields(fields.name).bits, 32)));
      if (bitmaps.has(word) || word < -1733 || word > 1732) throw new Error("sui-bitmap-identity-mismatch");
      bitmaps.set(word, suiUint(fields.value, 256));
      continue;
    }
    if (object.owner.ObjectOwner !== pool.tickTable) throw new Error("sui-tick-owner-mismatch");
    const node = moveFields(fields.value);
    const tickValue = pool.family === "cetus" ? node.value : fields.value;
    if (!isRecord(tickValue) || tickValue.type !== `${SUI_CLMM_DEPLOYMENTS[pool.family].typePackage}::tick::${pool.family === "cetus" ? "Tick" : "TickInfo"}`) throw new Error("sui-tick-type-mismatch");
    const tick = moveFields(tickValue);
    const index = Number(BigInt.asIntN(32, suiUint(moveFields(tick.index).bits, 32)));
    const key = pool.family === "cetus" ? Number(suiUint(fields.name)) - 443636 : Number(BigInt.asIntN(32, suiUint(moveFields(fields.name).bits, 32)));
    if (index !== key || index < -443636 || index > 443636 || (index % pool.tickSpacing !== 0 && Math.abs(index) !== 443636)) throw new Error("sui-tick-identity-mismatch");
    const sqrtPrice = suiUint(tick.sqrt_price, 128);
    const liquidityGross = suiUint(tick.liquidity_gross, 128);
    const liquidityNet = BigInt.asIntN(128, suiUint(moveFields(tick.liquidity_net).bits, 128));
    if (sqrtPrice !== tickSqrtPrice(index) || (liquidityNet < 0n ? -liquidityNet : liquidityNet) > liquidityGross) throw new Error("sui-tick-liquidity-mismatch");
    ticks.push({ index, sqrtPrice, liquidityGross, liquidityNet });
  }
  if (ticks.length !== pool.tickCount || new Set(ticks.map((tick) => tick.index)).size !== ticks.length || bitmaps.size !== pool.bitmapCount) throw new Error("sui-incomplete-tick-census");
  if (pool.family === "bluefin") {
    const derived = new Map<number, bigint>();
    for (const tick of ticks) if (tick.liquidityGross > 0n) {
      const compressed = tick.index / pool.tickSpacing;
      const word = Math.floor(compressed / 256);
      derived.set(word, (derived.get(word) ?? 0n) | 1n << BigInt(compressed - word * 256));
    }
    for (const word of new Set([...derived.keys(), ...bitmaps.keys()])) if ((derived.get(word) ?? 0n) !== (bitmaps.get(word) ?? 0n)) throw new Error("sui-bitmap-tick-census-mismatch");
  }
  ticks.sort((a, b) => a.index - b.index);
  let activeLiquidity = 0n;
  let netLiquidity = 0n;
  for (const tick of ticks) {
    netLiquidity += tick.liquidityNet;
    if (tick.index <= pool.currentTick) activeLiquidity += tick.liquidityNet;
  }
  if (netLiquidity !== 0n || activeLiquidity !== pool.liquidity) throw new Error("sui-tick-active-liquidity-mismatch");
  return { checkpoint, checkpointDigest: capture.checkpoint.digest, timestampMs, pool, ticks, references };
}

export async function fetchSuiClmmCapture(rpc: SuiRpc, family: SuiClmmFamily, poolId: string, checkpoint?: string, resolvePrunedTransactions?: SuiTransactionCheckpointResolver): Promise<SuiClmmCapture> {
  const id = suiObjectId(poolId);
  if (!id) throw new Error("sui-pool-identity-mismatch");
  const objects: unknown[] = [await rpc("sui_getObject", [id, OBJECT_OPTIONS])];
  const configId = SUI_CLMM_DEPLOYMENTS[family].configId;
  if (configId) objects.push(await rpc("sui_getObject", [configId, OBJECT_OPTIONS]));
  const pool = decodeSuiClmmPool(suiObject(objects[0]), family, configId ? suiObject(objects[1]) : undefined);
  for (const [table, count] of [[pool.tickTable, pool.tickCount], [pool.bitmapTable, pool.bitmapCount]] as const) {
    if (!table) continue;
    let cursor: string | null = null;
    const ids: string[] = [];
    do {
      const page = await rpc("suix_getDynamicFields", [table, cursor, 50]);
      if (!isRecord(page) || !Array.isArray(page.data) || typeof page.hasNextPage !== "boolean") throw new Error("sui-invalid-dynamic-fields-page");
      for (const field of page.data) {
        if (!isRecord(field) || field.type !== "DynamicField" || typeof field.objectId !== "string" || !suiObjectId(field.objectId) || ids.includes(field.objectId)) throw new Error("sui-invalid-dynamic-field-identity");
        ids.push(field.objectId);
      }
      if (ids.length > count || ids.length > SUI_CLMM_MAX_TICKS) throw new Error("sui-tick-census-overflow");
      if (!page.hasNextPage) break;
      if (typeof page.nextCursor !== "string" || page.nextCursor === cursor || page.data.length === 0) throw new Error("sui-invalid-dynamic-fields-cursor");
      cursor = page.nextCursor;
    } while (true);
    if (ids.length !== count) throw new Error("sui-incomplete-tick-census");
    for (let i = 0; i < ids.length; i += 50) {
      const requested = ids.slice(i, i + 50);
      const batch = await rpc("sui_multiGetObjects", [requested, OBJECT_OPTIONS]);
      if (!Array.isArray(batch) || batch.length !== requested.length || batch.some((object, index) => suiObject(object).objectId !== requested[index])) throw new Error("sui-object-batch-incomplete");
      objects.push(...batch);
    }
  }
  const pin = checkpoint ?? String(await rpc("sui_getLatestCheckpointSequenceNumber", []));
  const pinnedCheckpoint = await rpc("sui_getCheckpoint", [pin]);
  if (!isRecord(pinnedCheckpoint) || String(pinnedCheckpoint.sequenceNumber) !== pin) throw new Error("sui-checkpoint-identity-mismatch");
  const digests = [...new Set(objects.map((object) => String(suiObject(object).previousTransaction)))];
  const transactions: unknown[] = [];
  for (let i = 0; i < digests.length; i += 50) {
    const requested = digests.slice(i, i + 50);
    const batch = await rpc("sui_multiGetTransactionBlocks", [requested, {}]);
    if (!Array.isArray(batch) || batch.length !== requested.length || batch.some((transaction, index) => !isRecord(transaction) || transaction.digest !== requested[index])) throw new Error("sui-transaction-batch-incomplete");
    const missing = batch.filter((transaction) => !isRecord(transaction) || transaction.checkpoint == null).map((transaction) => String(transaction.digest));
    const archived = missing.length && resolvePrunedTransactions ? await resolvePrunedTransactions(missing) : [];
    const archiveByDigest = new Map(archived.map((transaction) => {
      if (!isRecord(transaction) || typeof transaction.digest !== "string") throw new Error("sui-archive-transaction-invalid");
      return [transaction.digest, transaction] as const;
    }));
    transactions.push(...batch.map((transaction) => transaction.checkpoint != null ? transaction : (archiveByDigest.get(transaction.digest) ?? transaction)));
  }
  const finalObjects: unknown[] = [];
  for (let i = 0; i < objects.length; i += 50) {
    const requested = objects.slice(i, i + 50).map((object) => suiObject(object).objectId);
    const batch = await rpc("sui_multiGetObjects", [requested, OBJECT_OPTIONS]);
    if (!Array.isArray(batch) || batch.length !== requested.length || batch.some((object, index) => suiObject(object).objectId !== requested[index])) throw new Error("sui-object-batch-incomplete");
    finalObjects.push(...batch);
  }
  return { family, checkpoint: pinnedCheckpoint, objects, transactions, finalObjects };
}
