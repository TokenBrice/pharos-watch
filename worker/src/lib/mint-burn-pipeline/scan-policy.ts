import type { AlchemyLogEntry } from "../alchemy-logs";
import { logWorkerEventArgs } from "../structured-log";

export const EVM_SAFETY_MARGIN_BLOCKS = 75; // ceil(900s indexing safety / 12s block time)
const DECODE_RETRY_LIMIT = 3;
export const DECODE_QUARANTINE_REASON = "amount-decode-retry-exhausted" as const;

/** Successful RPC reads do not prove exhaustive indexing beyond observed events. */
export function mintBurnSuccessfulScanFrontier(
  fromBlock: number,
  scanTo: number,
  chainHead: number,
  maxBlockSeen: number,
  safetyMarginBlocks = EVM_SAFETY_MARGIN_BLOCKS,
): number {
  return maxBlockSeen > 0
    ? maxBlockSeen
    : Math.max(fromBlock - 1, Math.min(scanTo, chainHead - safetyMarginBlocks));
}

export async function shouldQuarantineDecodeFailure(
  db: D1Database,
  configKey: string,
  log: AlchemyLogEntry,
  runTimestamp: number,
): Promise<{ quarantined: boolean; attempts: number }> {
  const cacheKey = `mint-burn:decode-retry:${configKey}:${log.blockNumber}:${log.transactionHash}:${log.logIndex}`;
  try {
    const prior = await db.prepare("SELECT value FROM cache WHERE key = ?").bind(cacheKey).first<{ value: string }>();
    const parsed = prior ? JSON.parse(prior.value) as { attempts?: unknown } : null;
    const attempts = (typeof parsed?.attempts === "number" ? parsed.attempts : 0) + 1;
    const quarantined = attempts >= DECODE_RETRY_LIMIT;
    await db.prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .bind(cacheKey, JSON.stringify({
        attempts,
        quarantined,
        reason: quarantined ? DECODE_QUARANTINE_REASON : "amount-decode-retry",
      }), runTimestamp)
      .run();
    return { quarantined, attempts };
  } catch (error) {
    logWorkerEventArgs("handler", "warn", "[mint-burn] decode retry state unavailable:", error);
    return { quarantined: false, attempts: 0 };
  }
}
