import { throwIfAborted } from "../lib/abort";
import { recordOutcomeSafe, shouldAttemptFetch } from "../lib/circuit-breaker";
import {
  USER_AGENT,
  CIRCUIT_SOURCE,
  KINESIS_KAU_HORIZON,
  KINESIS_KAG_HORIZON,
} from "../lib/constants";
import { fetchTextWithRetry } from "../lib/fetch-retry";
import { recordCronFailure, type CronResult } from "../lib/cron-logger";
import { createCronResult } from "../lib/cron-result";
import { runWithOverloadRetry } from "../lib/d1-overload-retry";

interface KinesisChainConfig {
  stablecoinId: string;
  chain: string;
  baseUrl: string;
  circuitSource: string;
}

const KINESIS_CHAINS: KinesisChainConfig[] = [
  {
    stablecoinId: "kau-kinesis",
    chain: "kinesis-kau",
    baseUrl: KINESIS_KAU_HORIZON,
    circuitSource: CIRCUIT_SOURCE.KINESIS_KAU,
  },
  {
    stablecoinId: "kag-kinesis",
    chain: "kinesis-kag",
    baseUrl: KINESIS_KAG_HORIZON,
    circuitSource: CIRCUIT_SOURCE.KINESIS_KAG,
  },
];

interface KinesisCirculationData {
  circulation: number;
  mint: number;
  redemption: number;
}

const INVALID_PAYLOAD_REASON = "invalid-upstream-payload";

function decodeKinesisNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) return null;
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isValidKinesisNumber(value: number | null): value is number {
  return value != null && value >= 0;
}

function newestDatedRecord(records: unknown[]): unknown {
  let newest: { record: unknown; timestamp: number } | null = null;
  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    const date = "date" in record ? record.date : undefined;
    const timestamp = typeof date === "string" || typeof date === "number"
      ? Date.parse(String(date))
      : Number.NaN;
    if (Number.isFinite(timestamp) && (newest == null || timestamp > newest.timestamp)) {
      newest = { record, timestamp };
    }
  }
  return newest?.record ?? records[records.length - 1];
}

/** Parse the `/coin_in_circulation` response (single object, raw record array, or Horizon envelope). */
export function parseKinesisResponse(data: unknown): KinesisCirculationData | null {
  if (Array.isArray(data)) {
    if (data.length === 0) return null;
    return extractFields(newestDatedRecord(data));
  }
  if (data && typeof data === "object") {
    const records = "records" in data ? data.records : undefined;
    if (Array.isArray(records)) {
      if (records.length === 0) return null;
      return extractFields(newestDatedRecord(records));
    }
  }
  return extractFields(data);
}

function extractFields(record: unknown): KinesisCirculationData | null {
  if (!record || typeof record !== "object") return null;
  const r = record as Record<string, unknown>;
  const circulation = decodeKinesisNumber(r.circulation);
  const mint = decodeKinesisNumber(r.mint);
  const redemption = decodeKinesisNumber(r.redemption);
  if (!isValidKinesisNumber(circulation)) return null;
  if (!isValidKinesisNumber(mint)) return null;
  if (!isValidKinesisNumber(redemption)) return null;
  return { circulation, mint, redemption };
}

/**
 * Fetch circulation, mint, and redemption totals from the Kinesis Horizon
 * `/coin_in_circulation` endpoint for both KAU and KAG chains.
 *
 * Writes circulation to the `onchain_supply` table for independent supply
 * verification.
 */
export async function syncKinesisSupply(
  db: D1Database,
  signal: AbortSignal,
): Promise<CronResult> {
  let synced = 0;
  let failed = 0;
  let skipped = 0;
  let invalidPayloads = 0;
  let fetchFailures = 0;
  let persistenceFailures = 0;
  const chainResults: Array<{ chain: string; status: string; circulation?: number; reason?: string }> = [];

  for (const config of KINESIS_CHAINS) {
    throwIfAborted(signal);

    const allowed = await shouldAttemptFetch(db, config.circuitSource);
    if (!allowed) {
      skipped++;
      chainResults.push({ chain: config.chain, status: "circuit_open" });
      continue;
    }

    let parsed: KinesisCirculationData;
    try {
      const result = await fetchTextWithRetry(
        `${config.baseUrl}/coin_in_circulation`,
        { headers: { "User-Agent": USER_AGENT }, signal },
        2,
        { timeoutMs: 10_000, returnFinalResponse: true },
      );

      if (!result?.response.ok) {
        throw new Error(`HTTP ${result?.response.status ?? "null"}`);
      }

      let payload: unknown;
      try {
        payload = JSON.parse(result.body);
      } catch {
        throw new Error(INVALID_PAYLOAD_REASON);
      }
      const fetched = parseKinesisResponse(payload);
      if (!fetched) {
        throw new Error(INVALID_PAYLOAD_REASON);
      }
      parsed = fetched;
    } catch (err) {
      if (signal.aborted) throw err instanceof Error ? err : new Error(String(err));
      const invalidPayload = err instanceof Error && err.message === INVALID_PAYLOAD_REASON;
      if (invalidPayload) invalidPayloads++;
      else fetchFailures++;
      await recordOutcomeSafe(db, config.circuitSource, false);
      failed++;
      chainResults.push({
        chain: config.chain,
        status: invalidPayload ? "invalid_payload" : "error",
        reason: invalidPayload ? INVALID_PAYLOAD_REASON : "upstream-fetch-failed",
      });
      recordCronFailure("sync-kinesis-supply", err, {
        metadata: { chain: config.chain, stage: "fetch" },
      });
      continue;
    }

    await recordOutcomeSafe(db, config.circuitSource, true);

    try {
      // Write to onchain_supply for independent supply verification
      const nowSec = Math.floor(Date.now() / 1000);
      await runWithOverloadRetry(
        () =>
          db
            .prepare(
              "INSERT OR REPLACE INTO onchain_supply (stablecoin_id, chain, supply, updated_at) VALUES (?, ?, ?, ?)",
            )
            .bind(config.stablecoinId, config.chain, parsed.circulation, nowSec)
            .run(),
        3,
        signal,
      );
    } catch (err) {
      if (signal.aborted) throw err instanceof Error ? err : new Error(String(err));
      persistenceFailures++;
      failed++;
      chainResults.push({ chain: config.chain, status: "d1_error", circulation: parsed.circulation, reason: "d1-write-failed" });
      recordCronFailure("sync-kinesis-supply", err, {
        metadata: { chain: config.chain, stage: "persist" },
      });
      continue;
    }

    synced++;
    chainResults.push({ chain: config.chain, status: "ok", circulation: parsed.circulation });
  }

  const reason = invalidPayloads > 0
    ? INVALID_PAYLOAD_REASON
    : persistenceFailures > 0
      ? "d1-write-failed"
      : fetchFailures > 0
        ? "upstream-fetch-failed"
        : skipped > 0
          ? "circuit-open"
          : undefined;
  const status = failed === 0
    ? (skipped > 0 ? "degraded" : "ok")
    : synced > 0
      ? "degraded"
      : invalidPayloads > 0 && fetchFailures === 0 && persistenceFailures === 0
        ? "degraded"
        : "error";
  return createCronResult({
    itemCount: synced,
    status,
    metadata: {
      synced,
      failed,
      skipped,
      ...(reason ? { reason } : {}),
      chains: chainResults,
    },
  });
}
