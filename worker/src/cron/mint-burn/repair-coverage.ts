import { COVERAGE_REPAIR_MAX_BLOCKS } from "./repair-policy";
import { rethrowIfAborted, sleepWithSignal, throwIfAborted } from "../../lib/abort";
import { D1_HEAVY_STATEMENT_IDLE_RATIO, D1_RESOURCE_WINDOW_MS, isD1ResourceWindowError } from "../../lib/d1-overload-retry";
import { CRON_SCHEDULE_CADENCES } from "@shared/lib/cron-cadences";
import { fetchConservationBoundaries, needsMintBurnConservationBoundaries } from "../../lib/mint-burn-conservation";
import { mintBurnScanFingerprint, type MintBurnScanCoverage } from "../../lib/mint-burn-pipeline/scan-coverage";
import { mintBurnConfigKey } from "../../lib/mint-burn-contract-identity";
import type { MintBurnContractConfig } from "../../lib/mint-burn-contracts";
import { setCacheIfNewer } from "../../lib/db-cache";
import { loadMintBurnSupplyProofRepairCursor, mintBurnSupplyProofRepairCursorKey } from "./repair-supply-proofs";
import { MINT_BURN_PENDING_RUNTIME_BUDGET_MS, MINT_BURN_REQUEST_RESERVE, type runMintBurnConfigPhase } from "./run-configs";
import { MINT_BURN_EVENT_RETENTION_SEC } from "./retention";
import { MINT_BURN_RETRY_BOUNDARY_REQUESTS, mintBurnScanRequestFloor } from "./scan-with-retry";
import { createMintBurnConfigSummary, syncMintBurnConfig, type MintBurnConfigSummary } from "./sync-config";

// At 20 transactions/POST, leave room for roughly 100 context batches plus evidence reads.
const COVERAGE_REPAIR_MAX_REQUESTS = 120;
const COVERAGE_REPAIR_MAX_CONFIGS = 4;
const COVERAGE_REPAIR_WINDOW_MS = 120_000;
const COVERAGE_REPAIR_TERMINAL_RESERVE_MS = 60_000;

export async function idleMintBurnRepairD1(deadlineMs: number, signal?: AbortSignal,
  idleMs = D1_RESOURCE_WINDOW_MS): Promise<boolean> {
  if (Date.now() + idleMs + 5_000 >= deadlineMs) return false;
  await sleepWithSignal(idleMs, signal);
  return true;
}

interface CoverageRow {
  config_key: string;
  config_fingerprint: string;
  from_block: number;
  to_block: number;
  from_timestamp: number;
  to_timestamp: number;
  retained_from_block: number | null;
}
export interface MintBurnCoverageGap {
  config: MintBurnContractConfig;
  fromBlock: number;
  toBlock: number;
  backward?: boolean;
}

export function mintBurnRetainedHourlyFloor(now: number): number {
  return Math.ceil((now - MINT_BURN_EVENT_RETENTION_SEC) / 3600) * 3600;
}

/** The replay floor is a whole raw-retained hour, not the 95-day hourly retention.
 * Rebuilding older hours from a partial surviving raw set would erase history.
 * Old-fingerprint boundaries locate work only; only a fresh scan can certify it.
 */
export async function loadMintBurnCoverageGaps(
  db: D1Database, configs: readonly MintBurnContractConfig[], cursors: ReadonlyMap<string, number>, now: number,
): Promise<MintBurnCoverageGap[]> {
  if (configs.length === 0) return [];
  const cutoff = mintBurnRetainedHourlyFloor(now);
  const rows = await db.prepare(`
    WITH retained AS (
      SELECT chain_id, MIN(block_number) AS from_block FROM block_timestamp_cache
      WHERE timestamp >= ? GROUP BY chain_id
    )
    SELECT /* pharos:mint-burn-coverage-gaps */ c.config_key, c.config_fingerprint,
      c.from_block, c.to_block, c.from_timestamp, c.to_timestamp,
      r.from_block AS retained_from_block
    FROM mint_burn_scan_coverage c
    JOIN json_each(?) i ON c.config_key = json_extract(i.value, '$[0]')
      AND c.chain_id = json_extract(i.value, '$[1]')
    LEFT JOIN retained r ON r.chain_id = c.chain_id
    WHERE c.to_timestamp >= ?
    ORDER BY c.config_key, c.from_block
  `).bind(cutoff, JSON.stringify(configs.map((config) => [mintBurnConfigKey(config), config.chain.chainId])), cutoff)
    .all<CoverageRow>();
  const byKey = new Map<string, CoverageRow[]>();
  for (const row of rows.results ?? []) {
    const list = byKey.get(row.config_key) ?? [];
    list.push(row);
    byKey.set(row.config_key, list);
  }
  const gaps: MintBurnCoverageGap[] = [];
  const leadingGaps: MintBurnCoverageGap[] = [];
  for (const config of configs) {
    const key = mintBurnConfigKey(config);
    const lastBlock = cursors.get(key);
    const segments = byKey.get(key);
    if (lastBlock == null || !segments?.length) continue;
    // A retained header or ledger endpoint is a safe time anchor, never proof
    // for the missing interval itself. Include leading and cursor-tail gaps.
    let fromBlock = Infinity;
    for (const segment of segments) {
      if (segment.from_timestamp >= cutoff) fromBlock = Math.min(fromBlock, segment.from_block);
      if (segment.to_timestamp >= cutoff) fromBlock = Math.min(fromBlock, segment.to_block + 1);
      if (segment.retained_from_block != null) fromBlock = Math.min(fromBlock, segment.retained_from_block);
    }
    const retainedFloor = Math.max(config.startBlock, segments[0]!.from_block, fromBlock);
    const fingerprint = mintBurnScanFingerprint(config);
    const current = segments.filter((segment) => segment.config_fingerprint === fingerprint);
    const liveIndex = current.findIndex((segment) => segment.from_block <= lastBlock && segment.to_block >= lastBlock);
    if (liveIndex >= 0) {
      const end = current[liveIndex]!.from_block - 1;
      const start = Math.max(retainedFloor, (current[liveIndex - 1]?.to_block ?? retainedFloor - 1) + 1);
      if (start <= end) {
        // Close the nearest internal hole, then grow the live segment into older history.
        (liveIndex > 0 ? gaps : leadingGaps).push({ config, fromBlock: Math.max(start, end - COVERAGE_REPAIR_MAX_BLOCKS + 1),
          toBlock: end, backward: true });
        continue;
      }
    }
    const findGap = (start: number): MintBurnCoverageGap | null => {
      let from = start;
      let end = lastBlock;
      for (const segment of current) {
        if (segment.to_block < from) continue;
        if (segment.from_block > from) {
          end = Math.min(end, segment.from_block - 1);
          break;
        }
        from = Math.max(from, segment.to_block + 1);
      }
      return from > end ? null : { config, fromBlock: from,
        toBlock: Math.min(end, from + COVERAGE_REPAIR_MAX_BLOCKS - 1) };
    };
    // Repair regressions inside established current coverage before bootstrapping
    // older fingerprint history. A sparse chain-wide header cache is only a time
    // floor; it must not expand every config back to the oldest cached block.
    const internal = current.length ? findGap(Math.max(retainedFloor, current[0]!.from_block)) : null;
    if (internal) gaps.push(internal);
    else {
      const leading = findGap(retainedFloor);
      if (leading) leadingGaps.push(leading);
    }
  }
  return [...gaps, ...leadingGaps];
}

export interface MintBurnCoverageRepairSummary extends MintBurnConfigSummary {
  repairReason: "proof-staged" | "scan-coverage-unproven" | "repair-scan-failed" | "repair-budget-exhausted"
    | "repair-runtime-exhausted" | "finality-head-unavailable" | "provider-deferred"
    | "proof-committed" | "materialization-failed";
}

/** Historical scheduling debt is neutral to live health only with no evidence failure. */
export function isMintBurnCapacityOnlyRepairDebt(summary: MintBurnCoverageRepairSummary): boolean {
  if (!["scan-coverage-unproven", "repair-runtime-exhausted", "repair-budget-exhausted", "proof-staged", "proof-committed"].includes(summary.repairReason)
    || summary.conservationFailure || summary.conservationStatus === "mismatch"
    || summary.supplyProofStatus === "residual" || summary.rpcEvidenceIncomplete
    || summary.sourceFailureReason || summary.headFailureReason
    || summary.rowsDroppedDecode > 0 || (summary.rowsQuarantinedDecode ?? 0) > 0
    || (summary.decodeQuarantines?.length ?? 0) > 0 || summary.missingTimestampCount > 0
    || (summary.conservationStatus === "unavailable" && summary.conservationReason != null
      && !["incomplete-event-persistence-context", "persisted-event-readback-deadline"].includes(summary.conservationReason))
    || (summary.supplyProofReason != null && summary.supplyProofReason !== "persisted-event-readback-deadline")) return false;
  if (summary.failedEventDefs.length > 0) return summary.failedEventDefs.every((reason) =>
    /^(?:range-proof|conservation):persisted-event-readback-deadline$/.test(reason)
    || /^tx-context(?:-request-not-started)?:\d+$/.test(reason));
  return summary.supplyProofReason === "persisted-event-readback-deadline"
    || summary.conservationReason === "persisted-event-readback-deadline"
    || summary.repairReason === "repair-runtime-exhausted" || summary.repairReason === "repair-budget-exhausted"
    || (!summary.attempted && summary.repairReason === "scan-coverage-unproven")
    || (summary.errors > 0 && ["proof-staged", "proof-committed"].includes(summary.repairReason));
}

/** Serial, bounded replays share the live scanner's caches and materialization debt.
 * Returned proofs MUST remain behind the caller's hourly-materialization fence.
 */
export async function repairMintBurnCoverage(
  input: Parameters<typeof runMintBurnConfigPhase>[0], gaps: readonly MintBurnCoverageGap[],
  pendingProofs: MintBurnScanCoverage[], deferred: ReadonlyMap<string, number>,
  options: { supplyProofRepair?: boolean } = {},
): Promise<MintBurnCoverageRepairSummary[]> {
  if (gaps.length === 0) return [];
  const summaries: MintBurnCoverageRepairSummary[] = [];
  const runDeadlineMs = (input.deadlineMs ?? Date.now() + COVERAGE_REPAIR_WINDOW_MS + COVERAGE_REPAIR_TERMINAL_RESERVE_MS)
    - COVERAGE_REPAIR_TERMINAL_RESERVE_MS;
  // A slow D1 batch may outlast the scan allowance; retain time to save its smaller retry span.
  const deadlineMs = Math.min(runDeadlineMs - 2 * D1_RESOURCE_WINDOW_MS, Date.now() + COVERAGE_REPAIR_WINDOW_MS);
  let stopped = false;
  let idleMs = input.affectedHours.size > 0 ? D1_RESOURCE_WINDOW_MS : 0;
  const repairBudget = { count: 0, limit: Math.max(0, input.budget.limit - input.budget.count - MINT_BURN_REQUEST_RESERVE) };
  // Rotate independently of the live frontier; one failing source must not pin
  // every healthy repair behind it on successive scheduled runs.
  // Step by the running lane's cadence, or an hourly lane only ever leads with even offsets.
  const cadenceSec = CRON_SCHEDULE_CADENCES[input.lane === "extended"
    ? "halfHourlyMintBurnExtended" : "halfHourlyMintBurnCritical"].intervalSec;
  const offset = gaps.length ? Math.floor(input.runTimestamp / cadenceSec) % gaps.length : 0;
  const pending = (gap: MintBurnCoverageGap) => input.pendingAdmissionKeys?.has(mintBurnConfigKey(gap.config)) === true;
  const ordered = [...gaps.slice(offset), ...gaps.slice(0, offset)]
    .sort((a, b) => Number(pending(a)) - Number(pending(b)));
  for (let i = 0; i < ordered.length; i++) {
    if (!stopped && i >= COVERAGE_REPAIR_MAX_CONFIGS) break;
    throwIfAborted(input.signal);
    const gap = ordered[i]!;
    const { config } = gap;
    let fromBlock = gap.fromBlock;
    const key = mintBurnConfigKey(config);
    const remainingConfigs = Math.max(1, Math.min(COVERAGE_REPAIR_MAX_CONFIGS, ordered.length) - i);
    const fairDeadlineMs = Date.now() + Math.floor((deadlineMs - Date.now()) / remainingConfigs);
    const configDeadlineMs = input.pendingAdmissionKeys?.has(key)
      ? Math.min(fairDeadlineMs, input.runTimestamp * 1000 + MINT_BURN_PENDING_RUNTIME_BUDGET_MS) : fairDeadlineMs;
    const summary: MintBurnCoverageRepairSummary = {
      ...createMintBurnConfigSummary(config, key, config.tier ?? "critical", { scanFrom: fromBlock, scanTo: gap.toBlock }),
      repairReason: "scan-coverage-unproven",
    };
    summaries.push(summary);
    if (stopped) {
      summary.skippedReason = summary.repairReason = "repair-runtime-exhausted";
      continue;
    }
    const context = input.chainContexts.get(config.chain.chainId);
    if (context?.chainHead == null) {
      summary.repairReason = "finality-head-unavailable";
      continue;
    }
    if (deferred.has(key)) {
      summary.repairReason = "provider-deferred";
      continue;
    }
    if (Date.now() + 5_000 >= configDeadlineMs) {
      summary.repairReason = "repair-runtime-exhausted";
      continue;
    }
    const remainingRequests = repairBudget.limit - repairBudget.count;
    // Preserve a scanner-sized share for each peer; cheap work leaves its remainder to the next.
    const peerAllowance = Math.min(input.extendedConfigBudgetLimit, Math.floor(remainingRequests / remainingConfigs));
    const share = remainingRequests - peerAllowance * (remainingConfigs - 1);
    // An extended config needs the live scanner's own floor over the largest span one attempt can scan
    // (the span cap bounds paging from above; a persisted cursor span can only be smaller). It reserves
    // that before the peer shares, and a refusal lets a cheaper later gap try. Critical configs keep
    // their event-count threshold and stop at the first shortfall: their arithmetic is unchanged.
    const extended = config.tier === "extended";
    const minimum = extended ? mintBurnScanRequestFloor({ config,
      fromBlock: gap.backward ? Math.max(fromBlock, gap.toBlock - COVERAGE_REPAIR_MAX_BLOCKS + 1) : fromBlock,
      scanTo: gap.backward ? gap.toBlock : Math.min(gap.toBlock, fromBlock + COVERAGE_REPAIR_MAX_BLOCKS - 1),
      rpcEndpoints: context.rpcEndpoints, endpointHeads: context.endpointHeads })
      + (needsMintBurnConservationBoundaries(config) ? MINT_BURN_RETRY_BOUNDARY_REQUESTS : 0)
      : config.events.length + 2;
    const limit = Math.min(COVERAGE_REPAIR_MAX_REQUESTS,
      extended ? Math.min(remainingRequests, Math.max(minimum, share)) : share);
    if (limit < minimum) {
      // Refused before idle or D1 reads.
      summary.skippedReason = summary.repairReason = "repair-budget-exhausted";
      summary.requestBudgetLimit = limit;
      if (extended) continue;
      break;
    }
    if (idleMs > 0) {
      if (!await idleMintBurnRepairD1(configDeadlineMs, input.signal, idleMs)) {
        stopped = true;
        summary.skippedReason = summary.repairReason = "repair-runtime-exhausted";
        continue;
      }
      idleMs = 0;
    }
    let cursor;
    try {
      cursor = await loadMintBurnSupplyProofRepairCursor(input.db, config);
    } catch (error) {
      rethrowIfAborted(error, input.signal);
      if (!isD1ResourceWindowError(error)) throw error;
      summary.errors++;
      summary.skippedReason = summary.repairReason = "repair-runtime-exhausted";
      stopped = true;
      idleMs = D1_RESOURCE_WINDOW_MS;
      continue;
    }
    const spanLimit = cursor.maxBlocks ?? COVERAGE_REPAIR_MAX_BLOCKS;
    const toBlock = gap.backward ? gap.toBlock : Math.min(gap.toBlock, fromBlock + spanLimit - 1);
    if (gap.backward) fromBlock = Math.max(fromBlock, toBlock - spanLimit + 1);
    summary.scanFrom = fromBlock;
    summary.scanTo = toBlock;
    if (context.chainHead < toBlock) {
      summary.repairReason = "finality-head-unavailable";
      continue;
    }
    const budget = { count: 0, limit };
    let maxBlocks: number | null = null;
    let overloaded = false;
    const startedAtMs = Date.now();
    summary.attempted = true;
    try {
      const boundaries = await fetchConservationBoundaries({
        requests: [{ key, config, fromBlock, toBlock }],
        rpcEndpointsByChain: new Map([[config.chain.chainId, context.rpcEndpoints]]),
        budget, checkedAt: input.runTimestamp, signal: input.signal, deadlineMs: configDeadlineMs,
      });
      const result = await syncMintBurnConfig({
        db: input.db, config, key, summary, tier: config.tier ?? "critical", fromBlock, scanTo: toBlock,
        chainHead: context.chainHead, rpcEndpoints: context.rpcEndpoints, endpointHeads: context.endpointHeads,
        tronReader: context.tronReader,
        signal: input.signal, configBudgetLimit: Math.max(0, limit - budget.count), runTimestamp: input.runTimestamp,
        priceContext: input.priceContext, chainTimestampCache: context.chainTimestampCache,
        txContextCache: context.txContextCache, affectedHours: input.affectedHours, deadlineMs: configDeadlineMs,
        conservationBoundary: boundaries.get(key),
        supplyProofRepair: options.supplyProofRepair,
      });
      budget.count += result.summary.requestBudgetUsed;
      Object.assign(summary, result.summary);
      if (result.scanCoverage?.toBlock === toBlock && result.newLastBlock === toBlock) {
        pendingProofs.push(result.scanCoverage);
        summary.repairReason = "proof-staged";
      }
      // Scheduling state is not certified progress. Keep the cursor behind the
      // caller's materialization fence, including after partially persisted work.
      const capacityOnly = summary.errors > 0 && summary.failedEventDefs.length > 0
        && !result.rpcEvidenceIncomplete && isMintBurnCapacityOnlyRepairDebt(summary);
      const span = toBlock - fromBlock + 1;
      maxBlocks = capacityOnly ? Math.max(1, Math.floor(span / 2))
        : summary.repairReason === "proof-staged" ? Math.min(COVERAGE_REPAIR_MAX_BLOCKS,
          Math.max((cursor.maxBlocks ?? COVERAGE_REPAIR_MAX_BLOCKS) + 1, Math.floor((cursor.maxBlocks ?? COVERAGE_REPAIR_MAX_BLOCKS) * 1.25))) : null;
    } catch (error) {
      rethrowIfAborted(error, input.signal);
      // An exception can hide consumed requests; conservatively charge the cap.
      budget.count = limit;
      summary.errors++;
      overloaded = isD1ResourceWindowError(error);
      summary.repairReason = overloaded ? "repair-runtime-exhausted" : "repair-scan-failed";
      if (overloaded) maxBlocks = Math.max(1, Math.floor((toBlock - fromBlock + 1) / 2));
    } finally {
      repairBudget.count += budget.count;
      input.budget.count += budget.count;
      summary.requestBudgetUsed = budget.count;
    }
    // One idle window clears prior work; no fresh scan allowance is granted.
    idleMs = overloaded ? D1_RESOURCE_WINDOW_MS
      : Math.min(D1_RESOURCE_WINDOW_MS, (Date.now() - startedAtMs) * D1_HEAVY_STATEMENT_IDLE_RATIO);
    if (maxBlocks != null && maxBlocks !== (cursor.maxBlocks ?? COVERAGE_REPAIR_MAX_BLOCKS)) {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (Date.now() + 5_000 >= runDeadlineMs
          || ((overloaded || attempt > 0) && !await idleMintBurnRepairD1(runDeadlineMs, input.signal))) {
          stopped = true;
          break;
        }
        if (overloaded || attempt > 0) idleMs = 0;
        try {
          await setCacheIfNewer(input.db, mintBurnSupplyProofRepairCursorKey(key),
            JSON.stringify({ ...cursor, maxBlocks }), input.runTimestamp, input.signal);
          break;
        } catch (error) {
          rethrowIfAborted(error, input.signal);
          if (!isD1ResourceWindowError(error)) throw error;
          summary.errors++;
          stopped = true;
          idleMs = D1_RESOURCE_WINDOW_MS;
          if (overloaded) break;
        }
      }
    }
  }
  // Also protect the caller's materialization/terminal writes after the last gap.
  if (idleMs > 0) await idleMintBurnRepairD1(runDeadlineMs, input.signal, idleMs);
  return summaries;
}
