import {
  SolanaDexNativeGenerationSchema,
  type SolanaDexNativeGeneration,
} from "@shared/types/solana-dex-bank";
import { executeAtomicBatch } from "../../lib/db";
import { throwIfAborted } from "../../lib/abort";
import { measuredGenerationId } from "./generation-store";
import { decodeWhirlpool, decodeWhirlpoolTickArray } from "../dex-liquidity/solana/whirlpool-quote";
import { decodeRaydiumPool, decodeRaydiumTickArray } from "../dex-liquidity/solana/raydium-clmm-quote";

export function buildNativeDexGenerationId(nowSec: number): string {
  return measuredGenerationId("dex-native", nowSec);
}

function parseNativeGeneration(value: unknown): SolanaDexNativeGeneration {
  const generation = SolanaDexNativeGenerationSchema.parse(value);
  for (const quote of generation.quotes) {
    if (!quote.points.some((point) => point.status === "full-fill")) continue;
    const bank = quote.bank!;
    const accounts = new Map(bank.accounts.map((entry) => [entry.address, entry.account]));
    const bytes = (address: string) => Uint8Array.from(atob(accounts.get(address)!.dataBase64), (character) => character.charCodeAt(0));
    const orca = quote.target.profileId === "orca-whirlpool-exact-v1";
    const pool = orca ? decodeWhirlpool(bytes(quote.target.poolAddress), bank.slot)
      : decodeRaydiumPool(bytes(quote.target.poolAddress), bank.slot);
    if (!([pool.tokenMintA, pool.tokenMintB].includes(quote.target.tokenMintIn) &&
        [pool.tokenMintA, pool.tokenMintB].includes(quote.target.tokenMintOut)) ||
        ("config" in pool && !quote.dependencyAddresses.includes(pool.config))) {
      throw new Error("native-bank-direction-incompatible");
    }
    for (const address of quote.arrayAddresses) {
      if (orca) decodeWhirlpoolTickArray(bytes(address), address, quote.target.poolAddress, pool.tickSpacing, bank.slot);
      else decodeRaydiumTickArray(bytes(address), address, quote.target.poolAddress, pool.tickSpacing, bank.slot);
    }
  }
  return generation;
}

const NATIVE_PUBLISHER_FENCE_SQL = `SELECT attempt.attempt_key FROM scheduled_child_attempts attempt
  JOIN cron_leases lease ON lease.job = attempt.job AND lease.lease_owner = attempt.lease_owner
  JOIN cron_slot_executions slot ON slot.slot_key = attempt.execution_schedule_key
    AND slot.slot_started_at = attempt.execution_slot_started_at
    AND slot.execution_owner = attempt.execution_owner AND slot.execution_generation = attempt.execution_generation
    AND slot.invocation_id = attempt.execution_invocation_id
  WHERE attempt.job = 'sync-cl-exit-depth' AND attempt.producer_kind = 'scheduled-job'
    AND attempt.terminal_token IS NULL AND slot.state = 'running' AND lease.lease_until > ?`;

export async function captureNativeDexPublisherFence(
  db: D1Database, invocationId: string, attemptNo: number, nowSec: number,
): Promise<string> {
  const result = await db.prepare(`${NATIVE_PUBLISHER_FENCE_SQL}
    AND attempt.invocation_id = ? AND attempt.attempt_no = ?`).bind(nowSec, invocationId, attemptNo)
    .all<{ attempt_key: string }>();
  if (result.results?.length !== 1) throw new Error("native-publisher-fence-unavailable");
  return result.results[0]!.attempt_key;
}

/** One bounded transaction: immutable outcomes first, count-guarded pointer last. */
export async function publishNativeDexGeneration(
  db: D1Database,
  value: SolanaDexNativeGeneration,
  signal?: AbortSignal,
  publisherFence?: string,
): Promise<boolean> {
  const generation = parseNativeGeneration(value);
  throwIfAborted(signal);
  const statements = [db.prepare(`INSERT INTO dex_native_generations
    (generation_id, profile_id, source_generation_id, started_at, published_at, quote_count, score_eligible)
    VALUES (?, ?, ?, ?, ?, ?, 0)`).bind(generation.generationId, generation.profileId,
    generation.sourceGenerationId, generation.startedAt, generation.publishedAt, generation.quotes.length)];
  for (const quote of generation.quotes) {
    statements.push(db.prepare(`INSERT INTO dex_native_generation_quotes (generation_id, target_id, quote_json)
      VALUES (?, ?, ?)`).bind(generation.generationId, quote.target.targetId, JSON.stringify(quote)));
  }
  // A late older attempt cannot supersede a newer native bank generation.
  const fenceGuard = publisherFence === undefined ? "1" : `EXISTS (${NATIVE_PUBLISHER_FENCE_SQL} AND attempt.attempt_key = ?)`;
  statements.push(db.prepare(`INSERT INTO dex_native_publication_pointers (profile_id, generation_id)
    SELECT ?, ? WHERE ${fenceGuard}
    ON CONFLICT(profile_id) DO UPDATE SET generation_id = excluded.generation_id
    WHERE (SELECT started_at FROM dex_native_generations WHERE generation_id = excluded.generation_id) >
      (SELECT started_at FROM dex_native_generations WHERE generation_id = dex_native_publication_pointers.generation_id)`)
    .bind(generation.profileId, generation.generationId,
      ...(publisherFence === undefined ? [] : [Math.floor(Date.now() / 1_000), publisherFence])));
  const results = await executeAtomicBatch(db, statements, { signal, returnResults: true });
  return Number(results[results.length - 1]?.meta.changes ?? 0) === 1;
}

/** Indexed, bounded drain; neither current family pointer can lose its backing bank. */
export async function pruneNativeDexGenerations(db: D1Database, nowSec: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await db.prepare(`DELETE FROM dex_native_generations WHERE generation_id IN (
    SELECT g.generation_id FROM dex_native_generations g
    WHERE g.published_at < ? AND NOT EXISTS (
      SELECT 1 FROM dex_native_publication_pointers p WHERE p.generation_id = g.generation_id)
    ORDER BY g.published_at, g.generation_id LIMIT 16)`)
    .bind(nowSec - 7 * 24 * 60 * 60).run();
}

/** Read only the authoritative pointer, never a latest-success scan or an EVM surface. */
export async function loadCurrentNativeDexGeneration(
  db: D1Database,
  profileId: SolanaDexNativeGeneration["profileId"],
  signal?: AbortSignal,
): Promise<SolanaDexNativeGeneration | null> {
  throwIfAborted(signal);
  // One joined statement keeps the pointer and its complete rows in the same read snapshot.
  const result = await db.prepare(`SELECT g.generation_id, g.profile_id, g.source_generation_id,
    g.started_at, g.published_at, g.quote_count, q.target_id, q.quote_json
    FROM dex_native_publication_pointers p JOIN dex_native_generations g
      ON g.generation_id = p.generation_id AND g.profile_id = p.profile_id
    LEFT JOIN dex_native_generation_quotes q ON q.generation_id = g.generation_id
    WHERE p.profile_id = ? ORDER BY q.target_id`).bind(profileId).all<{
      generation_id: string; profile_id: string; source_generation_id: string | null;
      started_at: number; published_at: number; quote_count: number;
      target_id: string | null; quote_json: string | null;
    }>();
  throwIfAborted(signal);
  const rows = result.results ?? [];
  const first = rows[0];
  if (!first) return null;
  const quoteRows = rows.filter((row) => row.target_id !== null);
  if (quoteRows.length !== first.quote_count) throw new Error("native-generation-incomplete");
  const generation = parseNativeGeneration({
    schemaVersion: "solana-dex-generation-v1", generationId: first.generation_id,
    profileId: first.profile_id, sourceGenerationId: first.source_generation_id,
    startedAt: first.started_at, publishedAt: first.published_at, scoreEligible: false,
    quotes: quoteRows.map((row) => JSON.parse(row.quote_json!)),
  });
  if (generation.quotes.some((quote, index) => quote.target.targetId !== quoteRows[index]!.target_id)) {
    throw new Error("native-target-identity-mismatch");
  }
  return generation;
}
