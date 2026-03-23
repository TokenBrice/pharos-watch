import { throwIfAborted } from "../lib/abort";
import { shouldAttemptFetch, recordOutcome } from "../lib/circuit-breaker";
import {
  USER_AGENT,
  CIRCUIT_SOURCE,
  KINESIS_KAU_HORIZON,
  KINESIS_KAG_HORIZON,
} from "../lib/constants";
import { setCache } from "../lib/db-cache";
import { fetchWithRetry } from "../lib/fetch-retry";
import type { CronResult } from "../lib/cron-logger";

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
 * verification.  Caches full totals for future mint/redemption delta computation.
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

    try {
      const res = await fetchWithRetry(
        `${config.baseUrl}/coin_in_circulation`,
        { headers: { "User-Agent": USER_AGENT }, signal },
        2,
        { timeoutMs: 10_000 },
      );

      if (!res?.ok) {
        throw new Error(`HTTP ${res?.status ?? "null"}`);
      }

      const data = await res.json();
      const parsed = parseKinesisResponse(data);
      if (!parsed) {
        throw new Error("Invalid response: could not extract circulation data");
      }

      // Write to onchain_supply for independent supply verification
      const nowSec = Math.floor(Date.now() / 1000);
      await db
        .prepare(
          "INSERT OR REPLACE INTO onchain_supply (stablecoin_id, chain, supply, updated_at) VALUES (?, ?, ?, ?)",
        )
        .bind(config.stablecoinId, config.chain, parsed.circulation, nowSec)
        .run();

      // Cache full totals for future flow-delta computation
      await setCache(
        db,
        `kinesis-${config.chain}-totals`,
        JSON.stringify({
          circulation: parsed.circulation,
          mint: parsed.mint,
          redemption: parsed.redemption,
          fetchedAt: nowSec,
        }),
      );

      await recordOutcome(db, config.circuitSource, true);
      synced++;
      chainResults.push({ chain: config.chain, status: "ok", circulation: parsed.circulation });
      console.log(
        `[sync-kinesis-supply] ${config.chain}: circulation=${parsed.circulation.toLocaleString()}, ` +
          `mint=${parsed.mint.toLocaleString()}, redemption=${parsed.redemption.toLocaleString()}`,
      );
    } catch (err) {
      if (signal.aborted) throw err instanceof Error ? err : new Error(String(err));
      await recordOutcome(db, config.circuitSource, false);
      failed++;
      chainResults.push({ chain: config.chain, status: "error" });
      console.warn(
        `[sync-kinesis-supply] ${config.chain} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  const total = synced + failed + skipped;
  return {
    itemCount: synced,
    status: synced === total ? "ok" : synced > 0 ? "degraded" : "error",
    metadata: JSON.stringify({ synced, failed, skipped, chains: chainResults }),
  };
}
