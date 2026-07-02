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
import { runWithOverloadRetry } from "../lib/cron-lease";

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

/** Parse the `/coin_in_circulation` response (single object, raw record array, or Horizon envelope). */
export function parseKinesisResponse(data: unknown): KinesisCirculationData | null {
  if (Array.isArray(data)) {
    if (data.length === 0) return null;
    return extractFields(data[data.length - 1]);
  }
  if (data && typeof data === "object") {
    const records = (data as { records?: unknown }).records;
    if (Array.isArray(records)) {
      if (records.length === 0) return null;
      return extractFields(records[records.length - 1]);
    }
  }
  return extractFields(data);
}

function extractFields(record: unknown): KinesisCirculationData | null {
  if (!record || typeof record !== "object") return null;
  const r = record as Record<string, unknown>;
  const circulation = Number(r.circulation);
  const mint = Number(r.mint);
  const redemption = Number(r.redemption);
  if (!Number.isFinite(circulation) || circulation < 0) return null;
  if (!Number.isFinite(mint) || mint < 0) return null;
  if (!Number.isFinite(redemption) || redemption < 0) return null;
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
  const chainResults: Array<{ chain: string; status: string; circulation?: number }> = [];

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

      const fetched = parseKinesisResponse(JSON.parse(result.body));
      if (!fetched) {
        throw new Error("Invalid response: could not extract circulation data");
      }
      parsed = fetched;
    } catch (err) {
      if (signal.aborted) throw err instanceof Error ? err : new Error(String(err));
      await recordOutcomeSafe(db, config.circuitSource, false);
      failed++;
      chainResults.push({ chain: config.chain, status: "error" });
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
      failed++;
      chainResults.push({ chain: config.chain, status: "d1_error", circulation: parsed.circulation });
      recordCronFailure("sync-kinesis-supply", err, {
        metadata: { chain: config.chain, stage: "persist" },
      });
      continue;
    }

    synced++;
    chainResults.push({ chain: config.chain, status: "ok", circulation: parsed.circulation });
  }

  return {
    itemCount: synced,
    status: failed === 0
      ? (skipped > 0 ? "degraded" : "ok")
      : (synced > 0 ? "degraded" : "error"),
    metadata: JSON.stringify({ synced, failed, skipped, chains: chainResults }),
  };
}
