import { rethrowIfAborted, throwIfAborted } from "../../lib/abort";
import { runWithOverloadRetry } from "../../lib/d1-overload-retry";
import { toErrorMessage } from "@shared/lib/error-utils";

export interface DexGenerationStoreSpec<ChildRowsKey extends string = "deletedChildRows", ManifestRowsKey extends string = "deletedManifestRows"> {
  manifestTable: string;
  childTable: string;
  columns: {
    generationId: string;
    state: string;
    createdAt: string;
    failureReason: string;
    failedAt?: string;
  };
  terminalStates: readonly string[];
  failureState: string;
  failureReasonMaxLength: number;
  failureTransitionWhere: (columns: DexGenerationStoreSpec["columns"]) => string;
  retentionSeconds: number;
  maxGenerationsPerRun: number;
  resultKeys?: { child: ChildRowsKey; manifest: ManifestRowsKey };
  prune: {
    alwaysPruneStates?: readonly string[];
    protectGenerationId?: boolean;
    childExtraWhere?: string;
    manifestExtraWhere?: (alias: string) => string;
    childOrderBy: string;
    manifestOrderBy: string;
    oldestRequiresChildRows?: boolean;
  };
}

export type DexGenerationPruneResult<ChildRowsKey extends string = "deletedChildRows", ManifestRowsKey extends string = "deletedManifestRows"> = {
  cutoff: number;
  deletedRows: number;
  oldestRemainingAt: number | null;
  durationMs: number;
  error: string | null;
} & Record<ChildRowsKey | ManifestRowsKey, number>;

type TransitionResult = number | { meta?: { changes?: number | null } };

function quoteStates(states: readonly string[]): string {
  if (states.length === 0) throw new Error("DEX generation store requires at least one state");
  return states.map((state) => `'${state.replaceAll("'", "''")}'`).join(", ");
}

function qualifiedColumn(alias: string, column: string): string {
  return alias.length === 0 ? column : `${alias}.${column}`;
}

function getChanges(result: TransitionResult): number {
  return typeof result === "number" ? result : Number(result.meta?.changes ?? 0);
}

export function createDexGenerationStore<ChildRowsKey extends string = "deletedChildRows", ManifestRowsKey extends string = "deletedManifestRows">(
  spec: DexGenerationStoreSpec<ChildRowsKey, ManifestRowsKey>,
) {
  const terminalStatesSql = quoteStates(spec.terminalStates);
  const alwaysPruneStates = spec.prune.alwaysPruneStates ?? [];
  const alwaysPruneStatesSql = alwaysPruneStates.length === 0
    ? null
    : quoteStates(alwaysPruneStates);
  const failureState = `'${spec.failureState.replaceAll("'", "''")}'`;

  const stateWhere = (alias: string): string => {
    const state = qualifiedColumn(alias, spec.columns.state);
    const createdAt = qualifiedColumn(alias, spec.columns.createdAt);
    if (alwaysPruneStatesSql == null) {
      return `${createdAt} < ? AND ${state} IN (${terminalStatesSql})`;
    }
    const alwaysState = alwaysPruneStates.length === 1
      ? `${state} = ${alwaysPruneStatesSql}`
      : `${state} IN (${alwaysPruneStatesSql})`;
    return `(${alwaysState} OR (${state} IN (${terminalStatesSql}) AND ${createdAt} < ?))`;
  };

  const candidateWhere = (alias: string, extraWhere: string | undefined): string => {
    const clauses: string[] = [];
    if (spec.prune.protectGenerationId) {
      clauses.push(`${qualifiedColumn(alias, spec.columns.generationId)} != ?`);
    }
    clauses.push(stateWhere(alias));
    if (extraWhere != null && extraWhere.trim().length > 0) clauses.push(extraWhere.trim().replace(/^AND\s+/i, ""));
    return clauses.join(" AND ");
  };

  const prune = async (
    db: D1Database,
    input: { protectedGenerationId?: string; nowSec: number; signal?: AbortSignal },
  ): Promise<DexGenerationPruneResult<ChildRowsKey, ManifestRowsKey>> => {
    const startedAtMs = Date.now();
    const cutoff = input.nowSec - spec.retentionSeconds;
    const childRowsKey = spec.resultKeys?.child ?? "deletedChildRows" as ChildRowsKey;
    const manifestRowsKey = spec.resultKeys?.manifest ?? "deletedManifestRows" as ManifestRowsKey;
    let deletedChildRows = 0;
    let deletedManifestRows = 0;
    let oldestRemainingAt: number | null = null;
    let pruneError: string | null = null;
    try {
      throwIfAborted(input.signal);
      const protectedBinds = spec.prune.protectGenerationId
        ? [input.protectedGenerationId]
        : [];
      if (spec.prune.protectGenerationId && input.protectedGenerationId == null) {
        throw new Error("DEX generation retention requires a protected generation id");
      }
      const cutoffBinds = [cutoff];
      const childCandidates = `
    SELECT ${spec.columns.generationId}
     FROM ${spec.manifestTable}
     WHERE ${candidateWhere("", spec.prune.childExtraWhere)}
     ORDER BY ${spec.prune.childOrderBy} LIMIT ?`;
      // SAFETY: spec.childTable/manifestTable/columns are closed literal unions from
      // DexGenerationStoreSpec; callers cannot supply arbitrary SQL identifiers.
      const childRows = await runWithOverloadRetry(
        () => db.prepare(
          `DELETE FROM ${spec.childTable}
            WHERE ${spec.columns.generationId} IN (${childCandidates})`,
        ).bind(...protectedBinds, ...cutoffBinds, spec.maxGenerationsPerRun).run(),
        3,
        input.signal,
      );
      deletedChildRows = Number(childRows.meta?.changes ?? 0);

      const manifestCandidates = `
    SELECT candidate.rowid
      FROM ${spec.manifestTable} candidate
     WHERE ${candidateWhere("candidate", spec.prune.manifestExtraWhere?.("candidate"))}
     ORDER BY ${spec.prune.manifestOrderBy}
     LIMIT ?`;
      // SAFETY: spec.manifestTable and column names are closed literal unions from
      // DexGenerationStoreSpec; callers cannot supply arbitrary SQL identifiers.
      const manifestRows = await runWithOverloadRetry(
        () => db.prepare(
          `DELETE FROM ${spec.manifestTable}
            WHERE rowid IN (${manifestCandidates})`,
        ).bind(...protectedBinds, ...cutoffBinds, spec.maxGenerationsPerRun).run(),
        3,
        input.signal,
      );
      deletedManifestRows = Number(manifestRows.meta?.changes ?? 0);

      const oldestAlias = spec.prune.oldestRequiresChildRows ? "generation" : "";
      const oldestTable = oldestAlias.length === 0
        ? spec.manifestTable
        : `${spec.manifestTable} ${oldestAlias}`;
      const oldestColumn = qualifiedColumn(oldestAlias, spec.columns.createdAt);
      const oldestWhere = spec.prune.oldestRequiresChildRows
        ? ` WHERE EXISTS (
              SELECT 1 FROM ${spec.childTable} row
               WHERE row.${spec.columns.generationId} = ${qualifiedColumn(oldestAlias, spec.columns.generationId)}
            )`
        : "";
      // SAFETY: oldestTable/oldestColumn derive solely from DexGenerationStoreSpec's
      // closed literal-union identifiers and a fixed alias; no caller-supplied SQL.
      const oldest = await runWithOverloadRetry(
        () => db
          .prepare(`SELECT MIN(${oldestColumn}) AS oldest_remaining_at FROM ${oldestTable}${oldestWhere}`)
          .first<{ oldest_remaining_at: number | null }>(),
        3,
        input.signal,
      );
      oldestRemainingAt = oldest?.oldest_remaining_at ?? null;
    } catch (error) {
      rethrowIfAborted(error, input.signal);
      pruneError = toErrorMessage(error).slice(0, 500);
    }
    return {
      cutoff,
      deletedRows: deletedChildRows + deletedManifestRows,
      [childRowsKey]: deletedChildRows,
      [manifestRowsKey]: deletedManifestRows,
      oldestRemainingAt,
      durationMs: Math.max(0, Date.now() - startedAtMs),
      error: pruneError,
    } as DexGenerationPruneResult<ChildRowsKey, ManifestRowsKey>;
  };

  return {
    async markFailed(
      db: D1Database,
      generationId: string,
      reason: unknown,
      options: { failedAt?: number; signal?: AbortSignal } = {},
    ): Promise<void> {
      const assignments = [`${spec.columns.state} = ${failureState}`];
      const binds: unknown[] = [];
      if (spec.columns.failedAt != null) {
        assignments.push(`${spec.columns.failedAt} = ?`);
        binds.push(options.failedAt ?? Math.floor(Date.now() / 1000));
      }
      assignments.push(`${spec.columns.failureReason} = ?`);
      binds.push(toErrorMessage(reason).slice(0, spec.failureReasonMaxLength), generationId);
      try {
        await runWithOverloadRetry(
          () => db.prepare(
            `UPDATE ${spec.manifestTable}
                SET ${assignments.join(", ")}
              WHERE ${spec.columns.generationId} = ?
                AND ${spec.failureTransitionWhere(spec.columns)}`,
          ).bind(...binds).run(),
          3,
          options.signal,
        );
      } catch (error) {
        if (options.signal) rethrowIfAborted(error, options.signal);
        // Failure marking is diagnostic only; preserve the original operation error.
      }
    },

    assertTransition(result: TransitionResult, expectedChanges: number, message: string): void {
      if (getChanges(result) !== expectedChanges) throw new Error(message);
    },

    prune,
  };
}
