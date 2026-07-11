import { createLeaseOwner } from "./cron-lease-primitives";
import { runWithOverloadRetry } from "./d1-overload-retry";

export interface DetailCacheGenerationClaim {
  stablecoinId: string;
  generation: number;
  owner: string;
  claimedAtMs: number;
}

export interface DetailCacheGenerationWriteResult {
  written: boolean;
  skippedBecauseStale: boolean;
  generation: number;
}

export async function claimDetailCacheGeneration(
  db: D1Database,
  stablecoinId: string,
  options: { owner?: string; claimedAtMs?: number } = {},
): Promise<DetailCacheGenerationClaim> {
  const owner = options.owner ?? createLeaseOwner(`detail-cache:${stablecoinId}`);
  const claimedAtMs = options.claimedAtMs ?? Date.now();
  const updatedAt = Math.floor(claimedAtMs / 1_000);
  const row = await runWithOverloadRetry(() =>
    db.prepare(
      `INSERT INTO detail_cache_write_generations (
         stablecoin_id, generation, claim_owner, claimed_at_ms, published_at, updated_at
       ) VALUES (?, 1, ?, ?, NULL, ?)
       ON CONFLICT(stablecoin_id) DO UPDATE SET
         generation = detail_cache_write_generations.generation + 1,
         claim_owner = excluded.claim_owner,
         claimed_at_ms = excluded.claimed_at_ms,
         published_at = NULL,
         updated_at = excluded.updated_at
       RETURNING generation`,
    ).bind(stablecoinId, owner, claimedAtMs, updatedAt).first<{ generation: number }>(),
  );
  if (!row || !Number.isInteger(row.generation) || row.generation < 1) {
    throw new Error(`Failed to claim detail cache generation for ${stablecoinId}`);
  }
  return { stablecoinId, generation: row.generation, owner, claimedAtMs };
}

export async function publishDetailCacheGeneration(
  db: D1Database,
  cacheKey: string,
  value: string,
  claim: DetailCacheGenerationClaim,
): Promise<DetailCacheGenerationWriteResult> {
  const updatedAt = Math.floor(claim.claimedAtMs / 1_000);
  const cacheResult = await runWithOverloadRetry(() =>
    db.prepare(
      `INSERT INTO cache (key, value, updated_at)
       SELECT ?, ?, ?
        WHERE EXISTS (
          SELECT 1
            FROM detail_cache_write_generations
           WHERE stablecoin_id = ?
             AND generation = ?
             AND claim_owner = ?
        )
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at
       WHERE EXISTS (
         SELECT 1
           FROM detail_cache_write_generations
          WHERE stablecoin_id = ?
            AND generation = ?
            AND claim_owner = ?
       )`,
    ).bind(
      cacheKey,
      value,
      updatedAt,
      claim.stablecoinId,
      claim.generation,
      claim.owner,
      claim.stablecoinId,
      claim.generation,
      claim.owner,
    ).run(),
  );
  const written = (cacheResult.meta.changes ?? 0) === 1;
  if (written) {
    await runWithOverloadRetry(() =>
      db.prepare(
        `UPDATE detail_cache_write_generations
            SET published_at = ?, updated_at = ?
          WHERE stablecoin_id = ?
            AND generation = ?
            AND claim_owner = ?`,
      ).bind(
        Math.floor(Date.now() / 1_000),
        Math.floor(Date.now() / 1_000),
        claim.stablecoinId,
        claim.generation,
        claim.owner,
      ).run(),
    );
  }
  return {
    written,
    skippedBecauseStale: !written,
    generation: claim.generation,
  };
}
