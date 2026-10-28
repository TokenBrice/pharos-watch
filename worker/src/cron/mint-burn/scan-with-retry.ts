import { throwIfAborted } from "../../lib/abort";
import { conservationOnlyEventDefsFor, fetchConservationBoundaries, getMintBurnConservationEligibility } from "../../lib/mint-burn-conservation";
import { syncMintBurnConfig, type SyncMintBurnConfigInput, type SyncMintBurnConfigResult } from "./sync-config";
import { TRON_RPC_MAX_BLOCK_SPAN } from "@shared/lib/tron-jsonrpc";

export const MINT_BURN_MAX_SCAN_ATTEMPTS = 4;
// Header, pinned supply/state, then header recheck: three healthy batch requests.
export const MINT_BURN_RETRY_BOUNDARY_REQUESTS = 3;

/** Fund logs plus event timestamps and proof headers, even with cold caches. */
export function mintBurnScanRequestFloor(input: Pick<SyncMintBurnConfigInput,
  "config" | "fromBlock" | "scanTo" | "rpcEndpoints" | "endpointHeads">): number {
  const preferred = input.rpcEndpoints[0];
  const pages = input.config.chain.chainId === "tron"
    ? Math.ceil((input.scanTo - input.fromBlock + 1) / TRON_RPC_MAX_BLOCK_SPAN)
    : preferred?.operator === "dwellir" && preferred.maxLogBlockSpan
    ? Math.ceil((input.scanTo - input.fromBlock + 1) / preferred.maxLogBlockSpan) : 1;
  const headRequest = input.rpcEndpoints.length > 1 && preferred && !input.endpointHeads?.has(preferred.url) ? 1 : 0;
  return pages * (input.config.events.length + conservationOnlyEventDefsFor(input.config).length) + headRequest + 2;
}

/** A failed large scan never licenses a cursor skip. Re-run successively smaller
 * prefixes through the complete parser/persistence/proof path instead. Reserve
 * request capacity for retries so a budget-limited first attempt can make progress.
 */
export async function syncMintBurnConfigWithRetries(input: SyncMintBurnConfigInput): Promise<SyncMintBurnConfigResult> {
  let scanTo = Math.min(input.scanTo, input.chainHead);
  let used = 0;
  const boundaryRequests = getMintBurnConservationEligibility(input.config).supported ? MINT_BURN_RETRY_BOUNDARY_REQUESTS : 0;
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
    const minimumRequests = mintBurnScanRequestFloor({ ...input, scanTo }) + (attempt > 0 ? boundaryRequests : 0);
    const halfTo = input.fromBlock + Math.floor((scanTo - input.fromBlock) / 2);
    const retryMinimum = mintBurnScanRequestFloor({ ...input, scanTo: halfTo }) + boundaryRequests;
    const canReserveRetry = attempt < MINT_BURN_MAX_SCAN_ATTEMPTS - 1
      && scanTo > input.fromBlock && remaining >= minimumRequests + retryMinimum;
    const attemptBudget = { count: 0, limit: canReserveRetry
      ? Math.min(Math.max(minimumRequests, Math.ceil(remaining / 2)), remaining - retryMinimum) : remaining };
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
    // A known timestamp/decode/topic frontier is a tighter safe retry target
    // than blind halving. Re-scan it; the candidate alone never becomes proof.
    let knownFrontier = result.summary.coverageFrontier != null && result.summary.coverageFrontier >= input.fromBlock
      ? result.summary.coverageFrontier : scanTo;
    for (const block of [result.summary.earliestMissingTimestampBlock, result.summary.earliestDecodeFailureBlock]) {
      if (block != null) knownFrontier = Math.min(knownFrontier, block - 1);
    }
    for (const quarantine of result.summary.decodeQuarantines ?? []) {
      knownFrontier = Math.min(knownFrontier, quarantine.blockNumber - 1);
    }
    const nextScanTo = knownFrontier < scanTo ? knownFrontier : halfTo;
    if (result.summary.conservationFailure || result.summary.headFailureReason || scanTo <= input.fromBlock || nextScanTo < input.fromBlock
      || attempt + 1 >= MINT_BURN_MAX_SCAN_ATTEMPTS
      || input.configBudgetLimit - used < mintBurnScanRequestFloor({ ...input, scanTo: nextScanTo }) + boundaryRequests
      || (input.deadlineMs != null && Date.now() + 5_000 >= input.deadlineMs)) break;
    scanTo = nextScanTo;
  }
  return { ...result, ...counts, summary: { ...result.summary, ...totals,
    earliestMissingTimestampBlock, earliestDecodeFailureBlock,
    failedEventDefs: [...new Set(failures)], requestBudgetLimit: input.configBudgetLimit, requestBudgetUsed: used,
    scanAttempts: attempts.length, scanAttemptRanges: attempts } };
}
