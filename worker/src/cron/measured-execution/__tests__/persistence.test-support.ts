import type { DatabaseSync } from "node:sqlite";
import type { DexMeasuredExecutionProfile, DexMeasuredExecutionTarget } from "@shared/types/measured-execution";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";

export const databases = createLatestSchemaFixtureTracker();

export function seedGeneration(sqlite: DatabaseSync, input: {
  generationId: string;
  targetGenerationId: string;
  publishedAt: number;
  state?: "published" | "superseded" | "failed" | "rejected" | "candidate";
  rows: Array<{ target: DexMeasuredExecutionTarget; profile?: DexMeasuredExecutionProfile | null;
    status?: "measured" | "failed"; failureReason?: string | null }>;
}) {
  const { generationId, targetGenerationId, publishedAt, rows } = input;
  const ledger = sqlite.prepare(`INSERT OR IGNORE INTO surface_publication_generations
    (surface, generation_id, started_at, published_at, state, expected_rows, published_rows, dependency_snapshot_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  ledger.run("dex-measured-execution-targets", targetGenerationId, publishedAt - 10, publishedAt - 10,
    "superseded", rows.length, rows.length, null);
  ledger.run("dex-measured-execution-quotes", generationId, publishedAt, publishedAt,
    input.state ?? "superseded", rows.length, rows.length, JSON.stringify({ targetGenerationId }));
  for (const { target, profile, status, failureReason } of rows) {
    sqlite.prepare(`INSERT OR IGNORE INTO dex_measured_execution_targets
      (generation_id, target_id, stablecoin_id, adapter_profile_id, protocol, chain, pool_id, captured_at, target_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(targetGenerationId, target.targetId, target.stablecoinId,
      target.adapterProfileId, target.protocol, target.chain, target.poolId, target.capturedAt, JSON.stringify(target));
    sqlite.prepare(`INSERT INTO dex_measured_execution_quotes
      (generation_id, target_generation_id, target_id, stablecoin_id, adapter_profile_id, protocol, chain,
       pool_id, status, failure_reason, quoted_at, block_number, quote_profile_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(generationId, targetGenerationId, target.targetId,
      target.stablecoinId, target.adapterProfileId, target.protocol, target.chain, target.poolId,
      status ?? "measured", failureReason ?? null, profile?.quotedAt ?? null,
      profile?.blockNumber ?? null, profile ? JSON.stringify(profile) : null);
  }
}

export function evidenceDb(input: {
  target: DexMeasuredExecutionTarget;
  latest: { status: "measured" | "failed"; failureReason: string | null; profile: DexMeasuredExecutionProfile | null };
  historical?: Array<{ target: DexMeasuredExecutionTarget; profile?: DexMeasuredExecutionProfile | null;
    status?: "measured" | "failed"; failureReason?: string | null; generationId?: string;
    targetGenerationId?: string; publishedAt?: number }>;
}) {
  const fixture = databases.open();
  seedGeneration(fixture.sqlite, { generationId: "quote-generation-latest", targetGenerationId: "target-generation-latest",
    publishedAt: 2_010, state: "published", rows: [{ target: input.target, ...input.latest }] });
  for (const [index, entry] of (input.historical ?? []).entries()) {
    seedGeneration(fixture.sqlite, {
      generationId: entry.generationId ?? entry.profile?.quoteGenerationId ?? `quote-generation-failed-${index}`,
      targetGenerationId: entry.targetGenerationId ?? entry.profile?.targetGenerationId ?? `target-generation-failed-${index}`,
      publishedAt: entry.publishedAt ?? 1_900 - index, rows: [entry],
    });
  }
  return fixture;
}
