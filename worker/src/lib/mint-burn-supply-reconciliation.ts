import { MINT_BURN_RECONCILIATION_POLICY as POLICY } from "@shared/lib/mint-burn-reconciliation-policy";
import { sha256Hex } from "@shared/lib/sha256";
import {
  MintBurnSupplyReconciliationReceiptSchema,
  type MintBurnSupplyReconciliationReceipt as Receipt,
  type MintBurnSupplyReconciliationLeg as Leg,
} from "@shared/types/status";
import { throwIfAborted, rethrowIfAborted } from "./abort";
import { getCache, setCache, setCacheIfAbsent } from "./db-cache";
import { decimalNumberFromBigInt } from "./bigint";
import { fetchEvmBlockHeader, fetchEvmUint256AtBlock, resolveClosestBlockAtOrBeforeTimestamp,
  type EvmBlockSearchCache, type EvmRpcOptions } from "./evm-rpc";
import { getMintBurnConservationEligibility, getMintBurnConservationRuntimeEntry, getMintBurnRangeProofEligibility,
  mintBurnConservationFingerprint } from "./mint-burn-conservation";
import type { MintBurnContractConfig } from "./mint-burn-contracts";
import { mintBurnConfigKey } from "./mint-burn-pipeline/sync-state";
import { mintBurnScanCoverageAdmits, decodeMintBurnScanCoverage, prepareMintBurnScanCoverage,
  mintBurnScanFingerprint, type MintBurnScanSegment } from "./mint-burn-pipeline/scan-coverage";
import { resolveMintBurnEventPrice, type loadMintBurnPriceContextBatch } from "./mint-burn-pipeline/context";
import type { MintBurnRow } from "./mint-burn-pipeline/types";
import type { RpcEndpoint } from "./chain-registry";
import type { SubrequestBudget } from "./evm-logs";
import { MINT_BURN_EVENT_RETENTION_SEC } from "../cron/mint-burn/retention";

const STATE_KEY = "mint-burn:daily-reconciliation-state";
const MAX_CONFIGS = 8;
const MAX_REQUESTS = 24;
const MAX_ROWS = 20_000;
const WINDOW_DAYS = [1, 7, 30, 90] as const;
type Classes = NonNullable<Receipt["classes"]>;
type ClassTotal = Classes["counted"];
type Checkpoint = NonNullable<Receipt["opening"]>;
type LedgerRow = Pick<MintBurnRow, "amount_raw" | "direction" | "flow_type" | "burn_type" | "burn_review_reason">;
type StoredRow = { config_key: string; day_ts: number; checked_at: number; receipt_json: string };

function emptyTotal(): ClassTotal { return { mintRaw: "0", burnRaw: "0", eventCount: 0 }; }
function emptyClasses(): Classes {
  return { counted: emptyTotal(), review: emptyTotal(), bridge: emptyTotal(), atomic: emptyTotal(), protocol_internal: emptyTotal() };
}
function addTotal(target: ClassTotal, source: ClassTotal): void {
  target.mintRaw = (BigInt(target.mintRaw) + BigInt(source.mintRaw)).toString();
  target.burnRaw = (BigInt(target.burnRaw) + BigInt(source.burnRaw)).toString();
  target.eventCount += source.eventCount;
}
function net(total: ClassTotal): bigint { return BigInt(total.mintRaw) - BigInt(total.burnRaw); }
function materialReview(total: ClassTotal, closing: Checkpoint, decimals: number, priceUsd: number | null): boolean {
  const review = BigInt(total.mintRaw) > BigInt(total.burnRaw) ? BigInt(total.mintRaw) : BigInt(total.burnRaw);
  return review * 100n > BigInt(closing.supplyRaw) * BigInt(POLICY.supplyPercent)
    || (priceUsd != null && decimalNumberFromBigInt(review, decimals) * priceUsd > POLICY.valueUsd);
}
function fingerprint(config: MintBurnContractConfig): string {
  return sha256Hex(JSON.stringify(["daily-ledger-v1", mintBurnScanFingerprint(config), mintBurnConservationFingerprint(config)]));
}
/**
 * Range-proof tokens can emit a zero-recipient Transfer that destroys nothing. Such a
 * transfer stays an unresolved burn, so it may explain a positive remainder of at most
 * the day's unresolved burn total; anything else is still an unexplained residual.
 */
function allowsFalseZeroTransfers(config: MintBurnContractConfig): boolean {
  return getMintBurnRangeProofEligibility(config).supported;
}
function lawTerm(residual: bigint, review: ClassTotal, falseZeroLaw: boolean): bigint {
  return falseZeroLaw && residual > 0n && residual <= BigInt(review.burnRaw) ? residual : 0n;
}
function lawReason(config: MintBurnContractConfig): string | null {
  if (allowsFalseZeroTransfers(config)) return null;
  const eligible = getMintBurnConservationEligibility(config);
  if (!eligible.supported) return eligible.reason ?? "unreviewed-contract-or-event-semantics";
  const entry = getMintBurnConservationRuntimeEntry(config)!;
  // The economic rows do not retain vault yield, DestroyedBlackFunds or multiplier replay.
  if (entry.eventSet !== "transfer" || entry.invariant !== "transfer-supply" || entry.requiresNotDeprecated
    || entry.conservationOnlyEvents?.length || entry.invariantParams) return "reviewed-law-term-unavailable";
  return null;
}
function baseReceipt(config: MintBurnContractConfig, day: number, now: number): Receipt {
  return { configKey: mintBurnConfigKey(config), configFingerprint: fingerprint(config), chainId: config.chain.chainId,
    stablecoinId: config.stablecoinId, address: config.contractAddress, decimals: config.decimals,
    law: getMintBurnConservationRuntimeEntry(config)?.invariant ?? "unreviewed", day, checkedAt: now,
    status: "unavailable", reason: "daily-receipt-missing", opening: null, closing: null,
    classes: null, reviewByReason: null, lawTermRaw: null, residualRaw: null, priceUsd: null };
}

/** Exact arithmetic; materiality never absorbs a nonzero native residual. */
export function reconcileMintBurnSupplyReceipt(base: Receipt, rows: readonly LedgerRow[], falseZeroLaw = false): Receipt {
  if (!base.opening || !base.closing) return { ...base, status: "unavailable", reason: "boundary-evidence-missing" };
  const classes = emptyClasses();
  const reviewByReason: Record<string, ClassTotal> = {};
  for (const row of rows) {
    if (row.amount_raw == null || !/^[0-9]+$/.test(row.amount_raw) || BigInt(row.amount_raw) <= 0n
      || (row.direction !== "mint" && row.direction !== "burn")) {
      return { ...base, status: "unavailable", reason: "raw-event-amount-unavailable" };
    }
    const key = row.flow_type === "atomic_roundtrip" ? "atomic" : row.flow_type === "bridge_transfer" ? "bridge"
      : row.flow_type === "protocol_internal" ? "protocol_internal" : row.flow_type !== "standard" ? null
      : row.burn_type === "review_required" || (row.direction === "burn" && row.burn_type == null) ? "review"
      : row.direction === "burn" && row.burn_type === "bridge_burn" ? "bridge"
      : row.direction === "mint" || row.burn_type === "effective_burn" ? "counted" : null;
    if (key == null) return { ...base, status: "unavailable", reason: "event-class-unavailable" };
    const total = { mintRaw: row.direction === "mint" ? row.amount_raw : "0",
      burnRaw: row.direction === "burn" ? row.amount_raw : "0", eventCount: 1 };
    addTotal(classes[key], total);
    if (key === "review") {
      const reason = row.burn_review_reason ?? "review-reason-unrecorded";
      const bucket = Object.prototype.hasOwnProperty.call(reviewByReason, reason) ? reviewByReason[reason] : emptyTotal();
      addTotal(bucket, total);
      Object.defineProperty(reviewByReason, reason, { value: bucket, enumerable: true, configurable: true });
    }
  }
  const raw = BigInt(base.closing.supplyRaw) - BigInt(base.opening.supplyRaw)
    - Object.values(classes).reduce((sum, total) => sum + net(total), 0n);
  const term = lawTerm(raw, classes.review, falseZeroLaw);
  const residual = raw - term;
  const material = materialReview(classes.review, base.closing, base.decimals, base.priceUsd);
  const status = residual !== 0n ? "unexplained-residual" : material ? "review-suppression"
    : classes.review.eventCount > 0 && base.priceUsd == null ? "unavailable" : "ok";
  return { ...base, classes, reviewByReason, lawTermRaw: term.toString(), residualRaw: residual.toString(), status,
    reason: status === "ok" ? "exact-native-equality" : status === "unavailable" ? "review-materiality-price-unavailable" : status };
}

function admitStored(row: StoredRow, config: MintBurnContractConfig, now: number): Receipt | null {
  try {
    const parsed = MintBurnSupplyReconciliationReceiptSchema.safeParse(JSON.parse(row.receipt_json));
    if (!parsed.success) return null;
    const receipt = parsed.data;
    if (receipt.configKey !== row.config_key || receipt.day !== row.day_ts || receipt.checkedAt !== row.checked_at
      || receipt.configKey !== mintBurnConfigKey(config) || receipt.configFingerprint !== fingerprint(config)
      || receipt.chainId !== config.chain.chainId || receipt.stablecoinId !== config.stablecoinId
      || receipt.address.toLowerCase() !== config.contractAddress.toLowerCase() || receipt.decimals !== config.decimals
      || receipt.day % POLICY.daySec !== 0 || receipt.day + POLICY.daySec > now || receipt.checkedAt > now
      || receipt.checkedAt < receipt.day + POLICY.daySec) return null;
    if (receipt.status === "unavailable" || receipt.status === "unsupported-law") return receipt;
    if (lawReason(config) || !receipt.opening || !receipt.closing || !receipt.classes || !receipt.reviewByReason
      || receipt.lawTermRaw == null || receipt.residualRaw == null
      || receipt.opening.timestamp >= receipt.day || receipt.closing.timestamp >= receipt.day + POLICY.daySec
      || receipt.opening.number >= receipt.closing.number) return null;
    const raw = BigInt(receipt.closing.supplyRaw) - BigInt(receipt.opening.supplyRaw)
      - Object.values(receipt.classes).reduce((sum, total) => sum + net(total), 0n);
    if (lawTerm(raw, receipt.classes.review, allowsFalseZeroTransfers(config)).toString() !== receipt.lawTermRaw) return null;
    const residual = raw - BigInt(receipt.lawTermRaw);
    const review = emptyTotal();
    for (const total of Object.values(receipt.reviewByReason)) addTotal(review, total);
    const expected = residual !== 0n ? "unexplained-residual"
      : materialReview(receipt.classes.review, receipt.closing, receipt.decimals, receipt.priceUsd) ? "review-suppression"
      : receipt.classes.review.eventCount > 0 && receipt.priceUsd == null ? "unavailable" : "ok";
    if (residual.toString() !== receipt.residualRaw || receipt.status !== expected
      || JSON.stringify(review) !== JSON.stringify(receipt.classes.review)) return null;
    return receipt;
  } catch { return null; }
}

function checkpointMatches(left: Checkpoint, right: Checkpoint): boolean {
  return left.number === right.number && left.hash === right.hash && left.timestamp === right.timestamp && left.supplyRaw === right.supplyRaw;
}
function windowSummary(receipts: readonly Receipt[], end: number, days: typeof WINDOW_DAYS[number]): Leg["windows"][number] {
  const fromDay = end - days * POLICY.daySec;
  const base = { days, fromDay, toDay: end, status: "unavailable" as const, reason: "daily-window-incomplete" };
  const byDay = new Map(receipts.map((receipt) => [receipt.day, receipt]));
  const classes = emptyClasses();
  const reviewByReason: Record<string, ClassTotal> = {};
  let previous: Checkpoint | null = null;
  let closingReceipt: Receipt | null = null;
  let supplyDelta = 0n;
  let residual = 0n;
  let status: Receipt["status"] = "ok";
  for (let day = fromDay; day < end; day += POLICY.daySec) {
    const receipt = byDay.get(day);
    if (!receipt) return base;
    if (receipt.status === "unsupported-law") return { ...base, status: receipt.status, reason: receipt.reason };
    if (!receipt.opening || !receipt.closing || !receipt.classes || !receipt.reviewByReason || receipt.residualRaw == null
      || receipt.status === "unavailable") return { ...base, reason: receipt.reason };
    if (previous && !checkpointMatches(previous, receipt.opening)) return { ...base, reason: "daily-checkpoint-chain-broken" };
    previous = receipt.closing;
    closingReceipt = receipt;
    supplyDelta += BigInt(receipt.closing.supplyRaw) - BigInt(receipt.opening.supplyRaw);
    residual += BigInt(receipt.residualRaw);
    for (const key of Object.keys(classes) as Array<keyof Classes>) addTotal(classes[key], receipt.classes[key]);
    for (const [reason, total] of Object.entries(receipt.reviewByReason)) {
      const bucket = Object.prototype.hasOwnProperty.call(reviewByReason, reason) ? reviewByReason[reason] : emptyTotal();
      addTotal(bucket, total);
      Object.defineProperty(reviewByReason, reason, { value: bucket, enumerable: true, configurable: true });
    }
    if (receipt.status === "unexplained-residual" || (status === "ok" && receipt.status === "review-suppression")) status = receipt.status;
  }
  if (status === "ok" && previous && closingReceipt
    && materialReview(classes.review, previous, closingReceipt.decimals, closingReceipt.priceUsd)) status = "review-suppression";
  return { ...base, status, reason: status === "ok" ? "exact-native-equality" : status,
    supplyDeltaRaw: supplyDelta.toString(), residualRaw: residual.toString(), classes, reviewByReason };
}

/** No RPC on status/sentinel reads. A missing day cannot inherit yesterday's pass. */
export async function readMintBurnSupplyReconciliation(db: D1Database, configs: readonly MintBurnContractConfig[], now: number): Promise<Map<string, Leg>> {
  const result = new Map<string, Leg>();
  if (!configs.length) return result;
  const end = Math.floor(now / POLICY.daySec) * POLICY.daySec;
  // Bound retained JSON in memory; the projection keeps only the latest day and window totals.
  for (let offset = 0; offset < configs.length; offset += 20) {
    const batch = configs.slice(offset, offset + 20);
    const rows = await db.prepare(`SELECT config_key, day_ts, checked_at, receipt_json FROM mint_burn_supply_reconciliation
      WHERE config_key IN (SELECT value FROM json_each(?)) AND day_ts >= ? AND day_ts < ? ORDER BY day_ts`)
      .bind(JSON.stringify(batch.map(mintBurnConfigKey)), end - POLICY.retentionSec, end).all<StoredRow>();
    for (const config of batch) {
      const configKey = mintBurnConfigKey(config);
      const receipts = rows.results.filter((row) => row.config_key === configKey)
        .flatMap((row) => { const receipt = admitStored(row, config, now); return receipt ? [receipt] : []; });
      const latest = receipts.find((receipt) => receipt.day === end - POLICY.daySec);
      const windows = WINDOW_DAYS.map((days) => windowSummary(receipts, end, days));
      const unsupported = lawReason(config);
      const { configFingerprint: _fingerprint, ...projected } = latest ?? baseReceipt(config, end - POLICY.daySec, now);
      result.set(configKey, { configKey, chainId: config.chain.chainId, address: config.contractAddress, decimals: config.decimals,
        latestDay: latest?.day ?? null, checkedAt: latest?.checkedAt ?? null,
        status: latest?.status ?? (unsupported ? "unsupported-law" : "unavailable"),
        reason: latest?.reason ?? unsupported ?? "daily-receipt-missing", ...(latest ? { latest: projected } : {}),
        windows,
        activeFindings: [...receipts.flatMap((receipt) => receipt.status === "unexplained-residual" || receipt.status === "review-suppression"
          ? [{ day: receipt.day, status: receipt.status, reason: receipt.reason, residualRaw: receipt.residualRaw ?? undefined }] : []),
          ...windows.flatMap((window) => window.days > 1 && window.status === "review-suppression"
            ? [{ day: end - POLICY.daySec, status: "review-suppression" as const,
              reason: `window-${window.days}d-review-suppression`, residualRaw: window.residualRaw }] : [])] });
    }
  }
  return result;
}

interface PassInput {
  db: D1Database;
  configs: readonly MintBurnContractConfig[];
  now: number;
  budget: SubrequestBudget;
  rpcEndpointsByChain: ReadonlyMap<string, readonly RpcEndpoint[]>;
  heads: ReadonlyMap<string, number>;
  priceContext: Awaited<ReturnType<typeof loadMintBurnPriceContextBatch>>;
  signal?: AbortSignal;
  deadlineMs: number;
}

async function boundary(input: PassInput, config: MintBurnContractConfig, day: number,
  caches: Map<string, EvmBlockSearchCache>, pins: Map<string, Omit<Checkpoint, "supplyRaw">>,
  options: EvmRpcOptions, previous?: Checkpoint): Promise<Checkpoint | null> {
  const chainId = config.chain.chainId;
  const pinKey = `${chainId}:${day}`;
  const header = pins.get(pinKey) ?? (previous ? await fetchEvmBlockHeader(chainId, previous.number, options) : null);
  if (previous && (!header || header.hash !== previous.hash || header.timestamp !== previous.timestamp)) return null;
  let number = header?.number ?? previous?.number;
  if (number == null) {
    let cache = caches.get(pinKey);
    if (!cache) {
      const rows = await input.db.prepare(`WITH headers AS (
        SELECT block_number, timestamp FROM block_timestamp_cache WHERE chain_id = ? AND block_number <= ?)
        SELECT block_number, timestamp FROM headers WHERE block_number IN (
          SELECT block_number FROM (SELECT block_number FROM headers WHERE timestamp < ? ORDER BY timestamp DESC LIMIT 1)
          UNION SELECT block_number FROM (SELECT block_number FROM headers WHERE timestamp >= ? ORDER BY timestamp LIMIT 1))`)
        .bind(chainId, input.heads.get(chainId) ?? 0, day, day).all<{ block_number: number; timestamp: number }>();
      cache = { latestBlockNumber: input.heads.get(chainId), blockTimestampByNumber: new Map(rows.results.map((row) => [row.block_number, row.timestamp])) };
      caches.set(pinKey, cache);
    }
    number = await resolveClosestBlockAtOrBeforeTimestamp(chainId, day - 1, cache, options) ?? undefined;
    // Persist probes even on a capped search: the next opportunity continues its bracket.
    if (cache.blockTimestampByNumber.size) await input.db.batch([...cache.blockTimestampByNumber].map(([block, timestamp]) =>
      input.db.prepare(`INSERT OR IGNORE INTO block_timestamp_cache
        (chain_id, block_number, timestamp, updated_at) VALUES (?, ?, ?, ?)`).bind(chainId, block, timestamp, input.now)));
  }
  if (number == null) return null;
  const pin = header ?? await fetchEvmBlockHeader(chainId, number, options);
  const next = pins.has(pinKey) ? null : await fetchEvmBlockHeader(chainId, number + 1, options);
  if (!pin || pin.timestamp >= day || (!pins.has(pinKey)
    && (!next || next.timestamp < day || next.number > (input.heads.get(chainId) ?? -1)))) return null;
  pins.set(pinKey, pin);
  if (next) {
    await input.db.batch([pin, next].map((block) => input.db.prepare(`INSERT OR REPLACE INTO block_timestamp_cache
      (chain_id, block_number, timestamp, updated_at, block_hash) VALUES (?, ?, ?, ?, ?)`)
      .bind(chainId, block.number, block.timestamp, input.now, block.hash)));
  }
  if (previous) return previous;
  const supply = await fetchEvmUint256AtBlock(chainId, config.contractAddress, "0x18160ddd", number,
    { ...options, stateBlockHash: pin.hash as `0x${string}` });
  const recheck = await fetchEvmBlockHeader(chainId, number, options);
  if (supply == null || !recheck || recheck.hash !== pin.hash || recheck.timestamp !== pin.timestamp) return null;
  return { ...pin, supplyRaw: supply.toString() };
}

/** Bounded serialized maintenance inside the existing producer's request/deadline budget. */
export async function runMintBurnSupplyReconciliation(input: PassInput): Promise<{ processed: number; requests: number; reason?: string }> {
  const { db, now, configs, signal } = input;
  throwIfAborted(signal);
  await setCacheIfAbsent(db, STATE_KEY, JSON.stringify({ firstDay: Math.ceil(now / POLICY.daySec) * POLICY.daySec, cursor: 0 }), now, signal);
  const state = JSON.parse((await getCache(db, STATE_KEY, signal))!.value) as { firstDay: number; cursor: number };
  if (!Number.isSafeInteger(state.firstDay) || state.firstDay % POLICY.daySec !== 0 || !Number.isSafeInteger(state.cursor) || state.cursor < 0) {
    throw new Error("daily-reconciliation-state-invalid");
  }
  const lastDay = Math.floor(now / POLICY.daySec) * POLICY.daySec - POLICY.daySec;
  if (state.firstDay > lastDay || !configs.length) return { processed: 0, requests: 0 };
  const ordered = [...configs].sort((a, b) => mintBurnConfigKey(a).localeCompare(mintBurnConfigKey(b)));
  const caches = new Map<string, EvmBlockSearchCache>();
  const pins = new Map<string, Omit<Checkpoint, "supplyRaw">>();
  const initialRequests = input.budget.count;
  const deadlineMs = Math.min(input.deadlineMs, Date.now() + 45_000);
  const optionsFor = (config: MintBurnContractConfig): EvmRpcOptions => ({
    chainRpcs: new Map([[config.chain.chainId, { chainId: config.chain.chainId, chainName: config.chain.chainId, type: "evm",
      explorerUrl: config.chain.explorerUrl, endpoints: [...(input.rpcEndpointsByChain.get(config.chain.chainId) ?? [])] }]]),
    signal, deadlineMs, timeoutMs: 5_000, maxRetries: 0, observedHeadBlock: input.heads.get(config.chain.chainId),
    beforeRequest: () => {
      if (input.budget.count >= input.budget.limit || input.budget.count - initialRequests >= MAX_REQUESTS || Date.now() >= deadlineMs) return false;
      input.budget.count++;
      return true;
    },
  });
  let processed = 0;
  let visited = 0;
  for (; visited < Math.min(MAX_CONFIGS, ordered.length); visited++) {
    throwIfAborted(signal);
    if (Date.now() >= deadlineMs || input.budget.count - initialRequests >= MAX_REQUESTS || input.budget.count >= input.budget.limit) break;
    const config = ordered[(state.cursor + visited) % ordered.length]!;
    const key = mintBurnConfigKey(config);
    const stored = await db.prepare(`SELECT config_key, day_ts, checked_at, receipt_json FROM mint_burn_supply_reconciliation
      WHERE config_key = ? AND day_ts >= ? AND day_ts <= ? ORDER BY day_ts`)
      .bind(key, Math.max(state.firstDay, lastDay - MINT_BURN_EVENT_RETENTION_SEC), lastDay).all<StoredRow>();
    const receipts = new Map(stored.results.flatMap((row) => { const r = admitStored(row, config, now); return r ? [[r.day, r] as const] : []; }));
    const settledDays = new Set(stored.results.filter((row) => {
      try { return JSON.parse(row.receipt_json).status !== "unavailable"; } catch { return true; }
    }).map((row) => row.day_ts));
    const floor = Math.max(state.firstDay, Math.ceil((now - MINT_BURN_EVENT_RETENTION_SEC) / POLICY.daySec) * POLICY.daySec);
    // Missing days take priority; unavailable attempts retry while every raw sibling is retained.
    let day: number | undefined;
    for (let candidate = floor; candidate <= lastDay; candidate += POLICY.daySec) {
      if (!receipts.has(candidate) && !settledDays.has(candidate)) { day = candidate; break; }
    }
    if (day == null) day = [...receipts.values()].find((r) => r.status === "unavailable" && r.day >= floor && r.checkedAt < now - 6 * 3600)?.day;
    if (day == null) continue;
    let receipt = baseReceipt(config, day, now);
    let ledgerSnapshot: string | null = null;
    const unsupported = lawReason(config);
    const siblings = configs.filter((c) => c.stablecoinId === config.stablecoinId && c.chain.chainId === config.chain.chainId);
    if (unsupported) receipt = { ...receipt, status: "unsupported-law", reason: unsupported };
    else if (siblings.length > 1) receipt.reason = "contract-attribution-unavailable";
    else {
      try {
        // Both queries share one D1 transaction snapshot; no partial/paged event population.
        const [coverage, events] = await db.batch([
          prepareMintBurnScanCoverage(db, [config], day, day + POLICY.daySec),
          db.prepare(`SELECT amount_raw, direction, flow_type, burn_type, burn_review_reason FROM mint_burn_events
            WHERE stablecoin_id = ? AND chain_id = ? AND timestamp >= ? AND timestamp < ? ORDER BY id LIMIT ?`)
            .bind(config.stablecoinId, config.chain.chainId, day, day + POLICY.daySec, MAX_ROWS + 1),
        ]);
        if (!mintBurnScanCoverageAdmits([config], decodeMintBurnScanCoverage(coverage as D1Result<MintBurnScanSegment>), day, day + POLICY.daySec)) {
          receipt.reason = "scan-coverage-incomplete-or-dirty";
        } else if (events.results.length > MAX_ROWS) receipt.reason = "daily-event-row-budget";
        else {
          const options = optionsFor(config);
          const prior = receipts.get(day - POLICY.daySec);
          const previous = prior && prior.status !== "unavailable" && prior.status !== "unsupported-law" ? prior.closing ?? undefined : undefined;
          receipt.opening = await boundary(input, config, day, caches, pins, options, previous);
          receipt.closing = await boundary(input, config, day + POLICY.daySec, caches, pins, options);
          receipt.priceUsd = resolveMintBurnEventPrice(config.stablecoinId, now, input.priceContext)?.price ?? null;
          receipt = reconcileMintBurnSupplyReceipt(receipt, events.results as LedgerRow[], allowsFalseZeroTransfers(config));
          ledgerSnapshot = JSON.stringify((events.results as LedgerRow[]).map((row) =>
            [row.amount_raw, row.direction, row.flow_type, row.burn_type, row.burn_review_reason]));
        }
      } catch (error) {
        rethrowIfAborted(error, signal);
        receipt = { ...baseReceipt(config, day, now), reason: "daily-reconciliation-read-failed" };
      }
    }
    throwIfAborted(signal);
    // A settled receipt is immutable. Late maintenance cannot replace it with a pruned subset.
    await db.prepare(`INSERT INTO mint_burn_supply_reconciliation (config_key, day_ts, status, checked_at, receipt_json)
      SELECT ?, ?, ?, ?, ? WHERE (NOT EXISTS (SELECT 1 FROM mint_burn_dirty_hours
        WHERE stablecoin_id = ? AND chain_id = ? AND hour_ts >= ? AND hour_ts < ?)
        AND (SELECT json_group_array(json_array(amount_raw, direction, flow_type, burn_type, burn_review_reason))
          FROM (SELECT amount_raw, direction, flow_type, burn_type, burn_review_reason FROM mint_burn_events
            WHERE stablecoin_id = ? AND chain_id = ? AND timestamp >= ? AND timestamp < ? ORDER BY id LIMIT ?)) = ?)
      OR ? IN ('unavailable', 'unsupported-law')
      ON CONFLICT(config_key, day_ts) DO UPDATE SET
      status = excluded.status, checked_at = excluded.checked_at, receipt_json = excluded.receipt_json
      WHERE mint_burn_supply_reconciliation.status = 'unavailable'`)
      .bind(key, day, receipt.status, now, JSON.stringify(receipt), config.stablecoinId,
        config.chain.chainId, day, day + POLICY.daySec, config.stablecoinId, config.chain.chainId,
        day, day + POLICY.daySec, MAX_ROWS + 1, ledgerSnapshot, receipt.status).run();
    processed++;
  }
  await setCache(db, STATE_KEY, JSON.stringify({ firstDay: state.firstDay, cursor: (state.cursor + visited) % ordered.length }), signal);
  return { processed, requests: input.budget.count - initialRequests };
}
