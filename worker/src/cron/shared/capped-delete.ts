import { rethrowIfAborted, throwIfAborted } from "../../lib/abort";
import { runWithOverloadRetry } from "../../lib/d1-overload-retry";
import { runBoundedPrune, runBoundedPruneGroup } from "../../lib/bounded-prune";
import { toErrorMessage } from "@shared/lib/error-utils";
import { retentionDeleteStatement, type WindowedRetentionPolicy } from "@shared/lib/retention-policy";

export interface CappedDeleteResult {
  pruned: number;
  cappedAtLimit: boolean;
}

/**
 * Runs one capped `DELETE` repeatedly until a batch comes back short (nothing
 * left to prune) or the run budget is exhausted.
 *
 * `bindsForLimit` receives the batch limit and returns the full bind list, so
 * every call site keeps its own cutoff/bind order without this helper knowing
 * the statement shape. `batchLimit` (D1's 30-second per-statement budget) and
 * `runLimit` (the per-run row budget) stay call-site arguments because only the
 * caller knows how expensive its table is.
 */
export async function deleteCapped(
  db: D1Database,
  sql: string,
  bindsForLimit: (limit: number) => unknown[],
  batchLimit: number,
  runLimit: number,
  signal?: AbortSignal,
): Promise<CappedDeleteResult> {
  const result = await runBoundedPrune({
    batchLimit,
    runLimit,
    signal,
    deleteBatch: (limit) => db.prepare(sql).bind(...bindsForLimit(limit)).run(),
  });
  return { pruned: result.deleted, cappedAtLimit: result.truncated };
}

/** Every retention envelope publishes the same bounded failure text. */
const PRUNE_ERROR_TEXT_LIMIT = 500;

/** One capped retention statement: its own SQL, binds, batch size and run budget. */
export interface CappedPruneStatement {
  sql: string;
  bindsForLimit: (limit: number) => unknown[];
  batchLimit: number;
  runLimit: number;
}

/** Up to five independent statements share one binding call per drain round. */
const RETENTION_STATEMENTS_PER_BATCH = 5;

export async function deleteCappedGroup(
  db: D1Database,
  statements: readonly CappedPruneStatement[],
  signal?: AbortSignal,
): Promise<CappedDeleteResult[]> {
  const results: CappedDeleteResult[] = [];
  for (let offset = 0; offset < statements.length; offset += RETENTION_STATEMENTS_PER_BATCH) {
    const group = statements.slice(offset, offset + RETENTION_STATEMENTS_PER_BATCH);
    const passes = await runBoundedPruneGroup(
      group,
      (batches) => db.batch(batches.map(({ index, limit }) => {
        const statement = group[index];
        return db.prepare(statement.sql).bind(...statement.bindsForLimit(limit));
      })),
      signal,
    );
    results.push(...passes.map((pass) => ({ pruned: pass.deleted, cappedAtLimit: pass.truncated })));
  }
  return results;
}

/** Execute registry entries, preserving shared-budget priority in declaration order. */
export async function runRetentionPolicies<Key extends string>(
  db: D1Database,
  policies: Record<Key, WindowedRetentionPolicy>,
  nowSec: number,
  signal?: AbortSignal,
): Promise<Record<Key, CappedDeleteResult>> {
  const results = {} as Record<Key, CappedDeleteResult>;
  const used = new Map<string, number>();
  const keys = Object.keys(policies) as Key[];
  let offset = 0;
  while (offset < keys.length) {
    throwIfAborted(signal);
    const group: Key[] = [];
    const budgets = new Set<string>();
    while (offset < keys.length && group.length < RETENTION_STATEMENTS_PER_BATCH) {
      const key = keys[offset];
      const budget = policies[key].budgetGroup;
      if (budget && budgets.has(budget)) break;
      group.push(key);
      if (budget) budgets.add(budget);
      offset += 1;
    }
    const statements = group.map((key) => {
      const policy = policies[key];
      const statement = retentionDeleteStatement(policy, nowSec);
      if (policy.budgetGroup) statement.runLimit = Math.max(0, policy.runLimit - (used.get(policy.budgetGroup) ?? 0));
      return statement;
    });
    const passes = await deleteCappedGroup(db, statements, signal);
    for (let index = 0; index < group.length; index += 1) {
      const key = group[index];
      const budget = policies[key].budgetGroup;
      results[key] = passes[index];
      if (budget) used.set(budget, (used.get(budget) ?? 0) + passes[index].pruned);
    }
  }
  return results;
}

/** A read issued after the statements, reporting what the pass left behind. */
export interface CappedPruneProbe {
  sql: string;
  binds?: readonly unknown[];
}

/** Probe columns are `MIN(...)`-style timestamps: a number, or NULL once drained. */
export type CappedPruneProbeRow = Record<string, number | null>;

export interface CappedPruneFamilyResult<StatementKey extends string, ProbeKey extends string> {
  changedRows: number;
  changed: Record<StatementKey, number>;
  cappedAtLimit: boolean;
  retentionTruncated: Record<StatementKey, boolean>;
  probes: Record<ProbeKey, CappedPruneProbeRow>;
  durationMs: number;
  error: string | null;
}

/**
 * The lifecycle every capped prune shares: run each capped statement in
 * declaration order, then each backlog probe, and report the pass instead of
 * throwing.
 *
 * A shutdown abort is always rethrown; any other failure ends the pass and is
 * captured as bounded text alongside the counts collected so far, so a caller
 * can still publish a partial pass. Table-specific SQL, binds, limits and probe
 * semantics stay caller data: this owns only timing, sequencing, abort handling
 * and the error envelope. Retention work that clears a payload column or
 * backfills a missing aggregate is a capped statement like any delete.
 */
export async function runCappedPruneFamily<StatementKey extends string, ProbeKey extends string = never>(input: {
  db: D1Database;
  signal?: AbortSignal;
  statements: Record<StatementKey, CappedPruneStatement>;
  probes?: Record<ProbeKey, CappedPruneProbe>;
}): Promise<CappedPruneFamilyResult<StatementKey, ProbeKey>> {
  const startedAtMs = Date.now();
  const changed = {} as Record<StatementKey, number>;
  const retentionTruncated = {} as Record<StatementKey, boolean>;
  const probes = {} as Record<ProbeKey, CappedPruneProbeRow>;
  for (const key of Object.keys(input.statements) as StatementKey[]) {
    changed[key] = 0;
    retentionTruncated[key] = false;
  }
  for (const key of Object.keys(input.probes ?? {}) as ProbeKey[]) probes[key] = {};
  let changedRows = 0;
  let cappedAtLimit = false;
  let error: string | null = null;
  try {
    for (const key of Object.keys(changed) as StatementKey[]) {
      const statement = input.statements[key];
      const pass = await deleteCapped(
        input.db,
        statement.sql,
        statement.bindsForLimit,
        statement.batchLimit,
        statement.runLimit,
        input.signal,
      );
      changed[key] = pass.pruned;
      retentionTruncated[key] = pass.cappedAtLimit;
      changedRows += pass.pruned;
      cappedAtLimit ||= pass.cappedAtLimit;
      throwIfAborted(input.signal);
    }
    for (const key of Object.keys(probes) as ProbeKey[]) {
      const probe = (input.probes as Record<ProbeKey, CappedPruneProbe>)[key];
      const row = await runWithOverloadRetry(
        () => {
          const prepared = input.db.prepare(probe.sql);
          return (probe.binds && probe.binds.length > 0 ? prepared.bind(...probe.binds) : prepared)
            .first<CappedPruneProbeRow>();
        },
        3,
        input.signal,
      );
      probes[key] = row ?? {};
    }
  } catch (caught) {
    rethrowIfAborted(caught, input.signal);
    error = toErrorMessage(caught).slice(0, PRUNE_ERROR_TEXT_LIMIT);
  }
  return {
    changedRows,
    changed,
    cappedAtLimit,
    retentionTruncated,
    probes,
    durationMs: Math.max(0, Date.now() - startedAtMs),
    error,
  };
}
