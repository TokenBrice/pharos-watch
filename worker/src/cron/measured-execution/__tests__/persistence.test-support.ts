import type { DatabaseSync } from "node:sqlite";
import type { DexMeasuredExecutionProfile, DexMeasuredExecutionTarget } from "@shared/types/measured-execution";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";

export const databases = createLatestSchemaFixtureTracker();

/** Exact scheduled-owner history used by candidate retention and attribution tests. */
export function seedMeasuredProducerAttempt(sqlite: DatabaseSync, input: {
  job: string;
  scheduleKey: string;
  invocationId: string;
  clockSec: number;
  terminal?: boolean;
}) {
  const terminal = input.terminal ?? true;
  sqlite.prepare(`INSERT INTO cron_slot_executions
    (slot_key, slot_started_at, state, execution_owner, started_at, updated_at, invocation_id, execution_generation)
    VALUES (?, ?, ?, 'slot-owner', ?, ?, ?, 1)`)
    .run(input.scheduleKey, input.clockSec, terminal ? "completed" : "running", input.clockSec, input.clockSec, input.invocationId);
  sqlite.prepare(`INSERT INTO scheduled_child_attempts
    (attempt_key, schedule_key, slot_started_at, job, producer_path, producer_kind, invocation_id, attempt_no,
     execution_schedule_key, execution_slot_started_at, execution_invocation_id, execution_generation, execution_owner,
     lease_owner, terminal_source, terminal_token, terminal_at)
    VALUES (?, ?, ?, ?, ?, 'scheduled-job', ?, 1, ?, ?, ?, 1, 'slot-owner', 'owner', ?, ?, ?)`)
    .run(`attempt:${input.invocationId}`, input.scheduleKey, input.clockSec, input.job, input.scheduleKey,
      input.invocationId, input.scheduleKey, input.clockSec, input.invocationId,
      terminal ? "synthetic" : null, terminal ? `terminal:${input.invocationId}` : null, terminal ? input.clockSec : null);
  if (terminal) {
    sqlite.prepare(`INSERT INTO cron_runs
      (job, started_at, duration_ms, status, schedule_key, producer_path, producer_kind, invocation_id)
      VALUES (?, ?, 0, 'error', ?, ?, 'scheduled-job', ?)`)
      .run(input.job, input.clockSec, input.scheduleKey, input.scheduleKey, input.invocationId);
  } else {
    sqlite.prepare(`INSERT INTO cron_leases (job, lease_owner, lease_until, heartbeat_at, updated_at)
      VALUES (?, 'owner', ?, ?, ?)`).run(input.job, input.clockSec + 900, input.clockSec, input.clockSec);
  }
}

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
