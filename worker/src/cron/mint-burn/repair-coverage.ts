import { rethrowIfAborted, throwIfAborted } from "../../lib/abort";
import { fetchConservationBoundaries } from "../../lib/mint-burn-conservation";
import { mintBurnScanFingerprint, type MintBurnScanCoverage } from "../../lib/mint-burn-pipeline/scan-coverage";
import { mintBurnConfigKey } from "../../lib/mint-burn-pipeline/sync-state";
import type { MintBurnContractConfig } from "../../lib/mint-burn-contracts";
import type { runMintBurnConfigPhase } from "./run-configs";
import { MINT_BURN_EVENT_RETENTION_SEC } from "./retention";
import { createMintBurnConfigSummary, syncMintBurnConfig, type MintBurnConfigSummary } from "./sync-config";

export const COVERAGE_REPAIR_REQUEST_LIMIT = 40;
const COVERAGE_REPAIR_MAX_CONFIGS = 4;
export const COVERAGE_REPAIR_MAX_BLOCKS = 10_000;
export const COVERAGE_REPAIR_WINDOW_MS = 60_000;

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
}

/** The replay floor is a whole raw-retained hour, not the 95-day hourly retention.
 * Rebuilding older hours from a partial surviving raw set would erase history.
 * Old-fingerprint boundaries locate work only; only a fresh scan can certify it.
 */
export async function loadMintBurnCoverageGaps(
  db: D1Database, configs: readonly MintBurnContractConfig[], cursors: ReadonlyMap<string, number>, now: number,
): Promise<MintBurnCoverageGap[]> {
  if (configs.length === 0) return [];
  const cutoff = Math.ceil((now - MINT_BURN_EVENT_RETENTION_SEC) / 3600) * 3600;
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
  return gaps.length ? gaps : leadingGaps;
}

export interface MintBurnCoverageRepairSummary extends MintBurnConfigSummary {
  repairReason: "proof-staged" | "scan-coverage-unproven" | "repair-scan-failed" | "repair-budget-exhausted"
    | "repair-runtime-exhausted" | "finality-head-unavailable" | "provider-deferred"
    | "proof-committed" | "materialization-failed";
}

/** Serial, bounded replays share the live scanner's caches and materialization debt.
 * Returned proofs MUST remain behind the caller's hourly-materialization fence.
 */
export async function repairMintBurnCoverage(
  input: Parameters<typeof runMintBurnConfigPhase>[0], gaps: readonly MintBurnCoverageGap[],
  pendingProofs: MintBurnScanCoverage[], deferred: ReadonlyMap<string, number>,
): Promise<MintBurnCoverageRepairSummary[]> {
  const summaries: MintBurnCoverageRepairSummary[] = [];
  const deadlineMs = Math.min(input.deadlineMs ?? Infinity, Date.now() + COVERAGE_REPAIR_WINDOW_MS);
  const repairBudget = { count: 0, limit: Math.min(COVERAGE_REPAIR_REQUEST_LIMIT, input.budget.limit - input.budget.count) };
  // Rotate independently of the live frontier; one failing source must not pin
  // every healthy repair behind it on successive scheduled runs.
  const offset = gaps.length ? Math.floor(input.runTimestamp / (30 * 60)) % gaps.length : 0;
  for (let i = 0; i < Math.min(gaps.length, COVERAGE_REPAIR_MAX_CONFIGS); i++) {
    throwIfAborted(input.signal);
    const gap = gaps[(offset + i) % gaps.length]!;
    const { config, fromBlock, toBlock } = gap;
    const key = mintBurnConfigKey(config);
    const summary: MintBurnCoverageRepairSummary = {
      ...createMintBurnConfigSummary(config, key, config.tier ?? "critical", { scanFrom: fromBlock, scanTo: toBlock }),
      repairReason: "scan-coverage-unproven",
    };
    summaries.push(summary);
    const context = input.chainContexts.get(config.chain.chainId);
    if (context?.chainHead == null || context.chainHead < toBlock) {
      summary.repairReason = "finality-head-unavailable";
      continue;
    }
    if (deferred.has(key)) {
      summary.repairReason = "provider-deferred";
      continue;
    }
    if (Date.now() + 5_000 >= deadlineMs) {
      summary.repairReason = "repair-runtime-exhausted";
      break;
    }
    const limit = Math.min(input.extendedConfigBudgetLimit, repairBudget.limit - repairBudget.count);
    if (limit < config.events.length + 2) {
      summary.repairReason = "repair-budget-exhausted";
      break;
    }
    const budget = { count: 0, limit };
    try {
      const boundaries = await fetchConservationBoundaries({
        requests: [{ key, config, fromBlock, toBlock }],
        rpcEndpointsByChain: new Map([[config.chain.chainId, context.rpcEndpoints]]),
        budget, checkedAt: input.runTimestamp, signal: input.signal, deadlineMs,
      });
      const result = await syncMintBurnConfig({
        db: input.db, config, key, tier: config.tier ?? "critical", fromBlock, scanTo: toBlock,
        chainHead: context.chainHead, rpcEndpoints: context.rpcEndpoints, endpointHeads: context.endpointHeads,
        signal: input.signal, configBudgetLimit: Math.max(0, limit - budget.count), runTimestamp: input.runTimestamp,
        priceContext: input.priceContext, chainTimestampCache: context.chainTimestampCache,
        txContextCache: context.txContextCache, affectedHours: input.affectedHours, deadlineMs,
        conservationBoundary: boundaries.get(key),
      });
      budget.count += result.summary.requestBudgetUsed;
      Object.assign(summary, result.summary);
      if (result.scanCoverage?.toBlock === toBlock && result.newLastBlock === toBlock) {
        pendingProofs.push(result.scanCoverage);
        summary.repairReason = "proof-staged";
      }
    } catch (error) {
      rethrowIfAborted(error, input.signal);
      // An exception can hide consumed requests; conservatively charge the cap.
      budget.count = limit;
      summary.errors++;
      summary.repairReason = "repair-scan-failed";
    } finally {
      repairBudget.count += budget.count;
      input.budget.count += budget.count;
      summary.requestBudgetUsed = budget.count;
    }
  }
  return summaries;
}
