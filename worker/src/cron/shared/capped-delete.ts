import { rethrowIfAborted, sleepWithSignal, throwIfAborted } from "../../lib/abort";
import { D1_HEAVY_STATEMENT_IDLE_RATIO, D1_RESOURCE_WINDOW_MS, isD1ResourceWindowError, runWithOverloadRetry } from "../../lib/d1-overload-retry";
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

/** One retention entry; its ordered windows share the batch size and run budget. */
export interface CappedPruneStatement {
  key?: string;
  sql: string;
  bindsForLimit: (limit: number) => unknown[];
  batchLimit: number;
  runLimit: number;
  windows?: readonly (Pick<CappedPruneStatement, "sql" | "bindsForLimit"> & { window: string })[];
}

export class RetentionGroupError extends Error {
  constructor(
    readonly failedRetentionGroup: { key: string; window?: string }[],
    readonly cause: unknown,
    readonly completedResults: Record<string, CappedDeleteResult> = {},
    /** Policies not started because the run's soft deadline passed; not failures. */
    readonly deferredKeys: readonly string[] = [],
  ) {
    super(`Retention group ${failedRetentionGroup.map(({ key, window }) => window ? `${key} [${window}]` : key).join(", ")}: ${toErrorMessage(cause)}`);
  }
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
    const startedAtMs = Date.now();
    const completed = group.map((statement, index) => ({
      key: (statement.key ?? String(offset + index)).slice(0, 100),
      pruned: 0 as number | null,
      rowsRead: 0 as number | null,
      rowsWritten: 0 as number | null,
      d1DurationMs: 0 as number | null,
    }));
    let completedRounds = 0;
    let batchOutcomeUnknown = false;
    let status = "ok";
    let error: string | null = null;
    let failedRetentionGroup: { key: string; window?: string }[] = completed.map(({ key }) => ({ key }));
    try {
      const passes = group.map(() => ({ pruned: 0, cappedAtLimit: false }));
      const windowCount = Math.max(1, ...group.map((statement) => statement.windows?.length ?? 1));
      for (let windowIndex = 0; windowIndex < windowCount; windowIndex += 1) {
        const current = group.map((statement) => statement.windows
          ? statement.windows[windowIndex] : windowIndex === 0 ? statement : undefined);
        const windowPasses = await runBoundedPruneGroup(
          group.map((statement, index) => ({
            batchLimit: statement.batchLimit,
            runLimit: current[index] ? Math.max(0, statement.runLimit - passes[index].pruned) : 0,
          })),
          async (batches) => {
            failedRetentionGroup = batches.map(({ index }) => ({
              key: completed[index].key,
              ...(group[index].windows ? { window: group[index].windows![windowIndex].window.slice(0, 100) } : {}),
            }));
            const roundStartedAtMs = Date.now();
            const round = await db.batch(batches.map(({ index, limit }) => {
              const statement = current[index]!;
              return db.prepare(statement.sql).bind(...statement.bindsForLimit(limit));
            })).catch((caught: unknown) => {
              batchOutcomeUnknown = true;
              throw caught;
            });
            if (round.length !== batches.length) {
              batchOutcomeUnknown = true;
              throw new Error("Retention batch result count mismatch");
            }
            completedRounds += 1;
            for (let index = 0; index < batches.length; index += 1) {
              const work = completed[batches[index].index];
              const meta = round[index].meta;
              const add = (total: number | null, value: number | undefined) =>
                total !== null && typeof value === "number" && Number.isFinite(value) ? total + value : null;
              work.pruned = add(work.pruned, meta?.changes);
              work.rowsRead = add(work.rowsRead, meta?.rows_read);
              work.rowsWritten = add(work.rowsWritten, meta?.rows_written);
              work.d1DurationMs = add(work.d1DurationMs, meta?.duration);
            }
            // Yield D1's rolling resource budget after each acknowledged round; a
            // failed attempt goes straight to the overload retry's own backoff.
            await sleepWithSignal(Math.max(0, Date.now() - roundStartedAtMs) * D1_HEAVY_STATEMENT_IDLE_RATIO, signal);
            return round;
          },
          signal,
        );
        for (let index = 0; index < group.length; index += 1) {
          if (!current[index]) continue;
          passes[index].pruned += windowPasses[index].deleted;
          passes[index].cappedAtLimit ||= windowPasses[index].truncated;
        }
      }
      results.push(...passes);
    } catch (caught) {
      status = signal?.aborted || (typeof caught === "object" && caught !== null && "name" in caught && caught.name === "AbortError")
        ? "aborted" : "error";
      error = toErrorMessage(caught).slice(0, PRUNE_ERROR_TEXT_LIMIT);
      if (status === "aborted") throw caught;
      throw new RetentionGroupError(failedRetentionGroup, caught);
    } finally {
      // Only acknowledged rounds are costs/counts; a failed binding can have an unknown outcome.
      const diagnostic = JSON.stringify({
        completed, completedRounds, batchOutcomeUnknown, status, error,
        ...(status === "ok" ? {} : { failedRetentionGroup }),
        durationMs: Math.max(0, Date.now() - startedAtMs),
      });
      if (status === "ok") console.info("[retention-group]", diagnostic);
      else console.error("[retention-group]", diagnostic);
    }
  }
  return results;
}

/** Drain policies serially; isolate failures while preserving shared-budget priority. */
export async function runRetentionPolicies<Key extends string>(
  db: D1Database,
  policies: Record<Key, WindowedRetentionPolicy>,
  nowSec: number,
  signal?: AbortSignal,
  options: { deadlineMs?: number } = {},
): Promise<Record<Key, CappedDeleteResult>> {
  const results = {} as Record<Key, CappedDeleteResult>;
  const used = new Map<string, number>();
  const failures: RetentionGroupError[] = [];
  const failedBudgets = new Set<string>();
  const deferredKeys: Key[] = [];
  for (const key of Object.keys(policies) as Key[]) {
    throwIfAborted(signal);
    // Past the soft deadline, leave the remaining backlog to the next run.
    if (options.deadlineMs != null && Date.now() >= options.deadlineMs) {
      deferredKeys.push(key);
      continue;
    }
    const policy = policies[key];
    const budget = policy.budgetGroup;
    if (budget && failedBudgets.has(budget)) {
      failures.push(new RetentionGroupError([{ key }], new Error("Shared retention budget has an unconfirmed outcome")));
      continue;
    }
    const statement = retentionDeleteStatement(policy, nowSec);
    if (budget) statement.runLimit = Math.max(0, policy.runLimit - (used.get(budget) ?? 0));
    try {
      const [pass] = await deleteCappedGroup(db, [{
        ...statement, key,
        windows: policy.windows?.map((window) => ({
          ...retentionDeleteStatement(policy, nowSec, window), window: window.predicate,
        })),
      }], signal);
      results[key] = pass;
      if (budget) used.set(budget, (used.get(budget) ?? 0) + pass.pruned);
    } catch (caught) {
      if (signal?.aborted || !(caught instanceof RetentionGroupError)) throw caught;
      failures.push(caught);
      if (budget) failedBudgets.add(budget);
      // An exhausted window must expire before admitting an independent policy.
      if (isD1ResourceWindowError(caught.cause)) {
        await sleepWithSignal(D1_RESOURCE_WINDOW_MS, signal);
      }
    }
  }
  if (failures.length > 0 || deferredKeys.length > 0) {
    throw new RetentionGroupError(
      [...failures.flatMap((failure) => failure.failedRetentionGroup), ...deferredKeys.map((key) => ({ key }))],
      failures[0]?.cause ?? new Error("Retention run soft deadline reached"), results, deferredKeys,
    );
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
