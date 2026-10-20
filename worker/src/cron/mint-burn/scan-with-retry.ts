import { throwIfAborted } from "../../lib/abort";
import { fetchConservationBoundaries } from "../../lib/mint-burn-conservation";
import { syncMintBurnConfig, type SyncMintBurnConfigInput, type SyncMintBurnConfigResult } from "./sync-config";

export const MINT_BURN_MAX_SCAN_ATTEMPTS = 4;

/** A failed large scan never licenses a cursor skip. Re-run successively smaller
 * prefixes through the complete parser/persistence/proof path instead. Reserve
 * request capacity for retries so a budget-limited first attempt can make progress.
 */
export async function syncMintBurnConfigWithRetries(input: SyncMintBurnConfigInput): Promise<SyncMintBurnConfigResult> {
  let scanTo = Math.min(input.scanTo, input.chainHead);
  let used = 0;
  const attempts: NonNullable<SyncMintBurnConfigResult["summary"]["scanAttemptRanges"]> = [];
  const totals = { rowsRead: 0, rowsParsed: 0, rowsInserted: 0, rowsIgnored: 0, rowsDropped: 0,
    rowsDroppedDecode: 0, rowsQuarantinedDecode: 0, errors: 0, missingTimestampCount: 0,
    txContextShortfalls: 0, bridgeClassificationDeferredRows: 0 };
  const counts = { apiErrors: 0, effectiveBurns: 0, bridgeBurns: 0, reviewBurns: 0, atomicRoundtripsDetected: 0 };
  const failures: string[] = [];
  let earliestMissingTimestampBlock: number | null = null;
  let earliestDecodeFailureBlock: number | null = null;
  let result: SyncMintBurnConfigResult;
  for (let attempt = 0; ; attempt++) {
    throwIfAborted(input.signal);
    const remaining = Math.max(0, input.configBudgetLimit - used);
    const minimumRequests = input.config.events.length + 2;
    const canReserveRetry = attempt < MINT_BURN_MAX_SCAN_ATTEMPTS - 1
      && scanTo > input.fromBlock && remaining >= minimumRequests * 2;
    const attemptBudget = { count: 0, limit: canReserveRetry ? Math.ceil(remaining / 2) : remaining };
    let conservationBoundary = input.conservationBoundary;
    if (attempt > 0) {
      // A shortened prefix has different supply boundaries. Never reuse the
      // original range's audit to certify its retry.
      const boundaries = await fetchConservationBoundaries({
        requests: [{ key: input.key, config: input.config, fromBlock: input.fromBlock, toBlock: scanTo }],
        rpcEndpointsByChain: new Map([[input.config.chain.chainId, input.rpcEndpoints]]),
        budget: attemptBudget, checkedAt: input.runTimestamp, signal: input.signal, deadlineMs: input.deadlineMs,
      });
      conservationBoundary = boundaries.get(input.key);
    }
    result = await syncMintBurnConfig({ ...input, scanTo, conservationBoundary,
      configBudgetLimit: Math.max(0, attemptBudget.limit - attemptBudget.count) });
    used += attemptBudget.count + result.summary.requestBudgetUsed;
    attempts.push({ scanTo, requestBudgetUsed: attemptBudget.count + result.summary.requestBudgetUsed,
      reason: result.summary.advanceReason });
    for (const field of Object.keys(totals) as Array<keyof typeof totals>) totals[field] += result.summary[field] ?? 0;
    for (const field of Object.keys(counts) as Array<keyof typeof counts>) counts[field] += result[field];
    failures.push(...result.summary.failedEventDefs);
    if (result.summary.earliestMissingTimestampBlock != null) {
      earliestMissingTimestampBlock = Math.min(earliestMissingTimestampBlock ?? Infinity, result.summary.earliestMissingTimestampBlock);
    }
    if (result.summary.earliestDecodeFailureBlock != null) {
      earliestDecodeFailureBlock = Math.min(earliestDecodeFailureBlock ?? Infinity, result.summary.earliestDecodeFailureBlock);
    }
    const accepted = result.newLastBlock != null && result.scanCoverage?.toBlock === result.newLastBlock;
    if (accepted) {
      // A smaller certified range is real progress, not full catch-up health.
      if (attempt > 0) result.summary.advanceReason = "partial-frontier";
      result.summary.coverageFrontier = result.newLastBlock;
      break;
    }
    if (!result.summary.conservationFailure) result.summary.advanceReason = "scan-coverage-unproven";
    if (result.summary.conservationFailure || scanTo <= input.fromBlock
      || attempt + 1 >= MINT_BURN_MAX_SCAN_ATTEMPTS
      || input.configBudgetLimit - used < minimumRequests
      || (input.deadlineMs != null && Date.now() + 5_000 >= input.deadlineMs)) break;
    scanTo = input.fromBlock + Math.floor((scanTo - input.fromBlock) / 2);
  }
  return { ...result, ...counts, summary: { ...result.summary, ...totals,
    earliestMissingTimestampBlock, earliestDecodeFailureBlock,
    failedEventDefs: [...new Set(failures)], requestBudgetLimit: input.configBudgetLimit, requestBudgetUsed: used,
    scanAttempts: attempts.length, scanAttemptRanges: attempts } };
}
