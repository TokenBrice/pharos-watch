import { DEX_CURVE_STABLESWAP_MEASURED_FRESHNESS_MAX_SEC, DexMeasuredExecutionProfileSchema, DexMeasuredExecutionTargetSchema,
  getDexMeasuredExecutionFreshnessMaxSec, type DexMeasuredExecutionObservationHistory, type DexMeasuredExecutionProfile, type DexMeasuredExecutionTarget } from "@shared/types/measured-execution";
import { runWithOverloadRetry } from "../../lib/d1-overload-retry";
import { parseJson } from "../../lib/json-parse";
import { DEX_MEASURED_QUOTE_SURFACE, DEX_MEASURED_TARGET_SURFACE, hashMeasuredTargetIds, latestPublishedGeneration,
  loadSupersededQuoteGenerationIds, parsePersistedJson, type MeasuredQuoteGenerationDependency, type SurfaceGenerationRow } from "./generation-store";
import { summarizeDexMeasuredExecutionHistory, type DexMeasuredExecutionHistoryCycle } from "./history";
const DEX_MEASURED_HISTORY_LOOKBACK_MAX_SEC = DEX_CURVE_STABLESWAP_MEASURED_FRESHNESS_MAX_SEC;
/** Preserve the full window while keeping proof-heavy history rows below the scoring graph's heap peak. */
const DEX_MEASURED_HISTORY_TARGET_BATCH_SIZE = 16;
/** Bound raw target/profile JSON beside the assembled DEX pool graph. */
export const DEX_MEASURED_CURRENT_EVIDENCE_PAGE_SIZE = 32;
export function getDexMeasuredHistoryFreshnessSec(adapterProfileId: string): number {
  return getDexMeasuredExecutionFreshnessMaxSec(adapterProfileId);
}

interface QuoteRow {
  generation_id: string;
  target_generation_id: string;
  target_id: string;
  status: "measured" | "failed";
  failure_reason: string | null;
  quote_profile_json: string | null;
}

interface HistoricalQuoteRow extends QuoteRow {
  quote_published_at: number;
  target_json: string;
}

interface SparseCurrentQuoteWithTargetRow {
  target_id: string;
  target_json: string;
  /** Compatibility alias retained by test/read adapters built for dense generations. */
  generation_id?: string | null;
  quote_generation_id: string | null;
  target_generation_id: string | null;
  status: "measured" | "failed" | null;
  failure_reason: string | null;
  quote_profile_json: string | null;
}

interface QuoteGenerationSummaryRow {
  row_count: number;
  min_target_generation_id: string | null;
  max_target_generation_id: string | null;
}

export interface LoadedDexMeasuredQuoteEvidence {
  quoteGenerationId: string;
  targetGenerationId: string;
  publishedAt: number;
  byTargetId: Map<
    string,
    {
      quotedTarget: DexMeasuredExecutionTarget;
      status: "measured" | "failed";
      failureReason: string | null;
      profile: DexMeasuredExecutionProfile | null;
      /** Scoring-only lazy form; validated once on read and materialized per consumer target. */
      deferredProfileJson?: string;
      quoteGenerationId: string;
      targetGenerationId: string;
      resolution: "latest" | "last-known-good";
      latestFailureReason: string | null;
      observationHistory?: DexMeasuredExecutionObservationHistory;
    }
  >;
}

const OPERATIONAL_DEX_MEASURED_FAILURE_REASONS = new Set([
  "block-number-unavailable",
  "budget-deferred",
  "chain-circuit-open",
  "block-header-unavailable",
  "block-timestamp-unavailable",
  "factory-code-unavailable",
  "pool-manager-code-unavailable",
  "pool-state-rpc-unavailable",
  "quote-call-budget-exhausted",
  "quoter-rpc-unavailable",
  "quoter-code-unavailable",
  "registry-code-unavailable",
  "request-budget-exhausted",
  "rpc-failure",
  "runtime-code-unavailable",
  "runtime-binding-unavailable",
  "runtime-deadline-exceeded",
  "state-view-code-unavailable",
]);

export function isOperationalDexMeasuredFailure(reason: string | null | undefined): boolean {
  return reason != null && OPERATIONAL_DEX_MEASURED_FAILURE_REASONS.has(reason);
}

export function materializeDexMeasuredQuoteProfile(
  entry: LoadedDexMeasuredQuoteEvidence["byTargetId"] extends Map<string, infer T> ? T : never,
): DexMeasuredExecutionProfile | null {
  if (entry.profile) return entry.profile;
  if (!entry.deferredProfileJson) return null;
  return DexMeasuredExecutionProfileSchema.parse(
    parsePersistedJson(entry.deferredProfileJson, "DEX measured deferred profile JSON"),
  );
}

/**
 * A historical quote row is reusable only when its target parses back to the same
 * identity and its terminal state is internally consistent: measured rows carry a
 * profile bound to the same target and quote generation, failed rows carry a reason.
 */
function isCoherentHistoricalQuoteRow(
  row: QuoteRow,
  target: { targetId: string },
  profile: { targetId: string; targetGenerationId: string; quoteGenerationId: string } | null,
): boolean {
  if (target.targetId !== row.target_id) return false;
  if (row.status === "measured") {
    return (
      profile != null &&
      row.failure_reason == null &&
      profile.targetId === row.target_id &&
      profile.targetGenerationId === row.target_generation_id &&
      profile.quoteGenerationId === row.generation_id
    );
  }
  return profile == null && Boolean(row.failure_reason?.trim());
}

async function loadCurrentMeasuredQuoteEvidence<
  TTarget extends { targetId: string },
  TProfile extends {
    targetId: string;
    targetGenerationId: string;
    quoteGenerationId: string;
  },
>(input: {
  db: D1Database;
  quoteSurface: string;
  targetSurface: string;
  label: string;
  targetSchema: { parse(value: unknown): TTarget };
  profileSchema: { parse(value: unknown): TProfile };
  deferProfiles?: boolean;
  targetIds?: readonly string[];
  signal?: AbortSignal;
}): Promise<{
  quoteGenerationId: string;
  targetGenerationId: string;
  publishedAt: number;
  byTargetId: Map<
    string,
    {
      quotedTarget: TTarget;
      status: "measured" | "failed";
      failureReason: string | null;
      profile: TProfile | null;
      deferredProfileJson?: string;
    }
  >;
} | null> {
  const generation = await latestPublishedGeneration(input.db, input.quoteSurface, input.signal);
  if (!generation) return null;
  const summary = await runWithOverloadRetry(
    () =>
      input.db
        .prepare(
          `SELECT COUNT(*) AS row_count,
                  MIN(target_generation_id) AS min_target_generation_id,
                  MAX(target_generation_id) AS max_target_generation_id
           FROM dex_measured_execution_quotes
           WHERE generation_id = ?`,
        )
        .bind(generation.generation_id)
        .first<QuoteGenerationSummaryRow>(),
    3,
    input.signal,
  );
  const rowCount = Number(summary?.row_count ?? -1);
  if (
    rowCount < 0 ||
    (generation.expected_rows != null && generation.expected_rows !== rowCount) ||
    (generation.published_rows != null && generation.published_rows !== rowCount)
  ) {
    throw new Error(`Published ${input.label} measured quote generation ${generation.generation_id} is incomplete`);
  }
  const dependency = generation.dependency_snapshot_json
    ? (parsePersistedJson(
        generation.dependency_snapshot_json,
        `${input.label} measured dependency JSON`,
      ) as MeasuredQuoteGenerationDependency)
    : {};
  const targetGenerationId = summary?.min_target_generation_id ?? dependency.targetGenerationId;
  if (
    !targetGenerationId ||
    (rowCount > 0 && summary?.min_target_generation_id !== summary?.max_target_generation_id) ||
    (rowCount > 0 && summary?.min_target_generation_id !== targetGenerationId) ||
    dependency.targetGenerationId !== targetGenerationId
  ) {
    throw new Error(
      `Published ${input.label} measured quote generation ${generation.generation_id} has a torn target dependency`,
    );
  }
  const targetGeneration = await input.db
    .prepare(
      `SELECT generation_id, state, started_at, published_at, expected_rows, published_rows, dependency_snapshot_json
       FROM surface_publication_generations
       WHERE surface = ? AND generation_id = ? AND state IN ('published', 'superseded')`,
    )
    .bind(input.targetSurface, targetGenerationId)
    .first<SurfaceGenerationRow>();
  if (!targetGeneration) {
    throw new Error(`${input.label} measured target generation ${targetGenerationId} was not published`);
  }
  const targetCount = dependency.targetCount ?? targetGeneration.expected_rows ?? rowCount;
  const persistedOutcomeCount = dependency.persistedOutcomeCount ?? rowCount;
  const omittedBudgetDeferredCount = dependency.omittedBudgetDeferredCount ?? 0;
  const sparseTargetDigest = dependency.targetIdsSha256?.trim().toLowerCase() ?? null;
  if (
    !Number.isInteger(targetCount) || targetCount <= 0 ||
    !Number.isInteger(persistedOutcomeCount) || persistedOutcomeCount < 0 ||
    !Number.isInteger(omittedBudgetDeferredCount) || omittedBudgetDeferredCount < 0 ||
    persistedOutcomeCount !== rowCount ||
    persistedOutcomeCount + omittedBudgetDeferredCount !== targetCount ||
    (omittedBudgetDeferredCount > 0 && !/^[0-9a-f]{64}$/.test(sparseTargetDigest ?? "")) ||
    (targetGeneration.expected_rows != null && targetGeneration.expected_rows !== targetCount) ||
    (targetGeneration.published_rows != null && targetGeneration.published_rows !== targetCount)
  ) {
    throw new Error(`${input.label} measured quote generation ${generation.generation_id} has incomplete targets`);
  }

  const byTargetId = new Map<
    string,
    {
      quotedTarget: TTarget;
      status: "measured" | "failed";
      failureReason: string | null;
      profile: TProfile | null;
    }
  >();
  if (input.targetIds) {
    const allTargetResult = await runWithOverloadRetry(
      () =>
        input.db
          .prepare(
            `SELECT target_id
             FROM dex_measured_execution_targets
             WHERE generation_id = ?
             ORDER BY target_id`,
          )
          .bind(targetGenerationId)
          .all<{ target_id: string }>(),
      3,
      input.signal,
    );
    const allTargetIds = (allTargetResult.results ?? []).map((row) => row.target_id);
    const allTargetIdsSha256 = await hashMeasuredTargetIds(allTargetIds);
    if (
      allTargetIds.length !== targetCount ||
      (sparseTargetDigest != null && sparseTargetDigest !== allTargetIdsSha256)
    ) {
      throw new Error(`Published ${input.label} measured quote generation ${generation.generation_id} is incomplete`);
    }

    const available = new Set(allTargetIds);
    const selectedTargetIds = [...new Set(input.targetIds)].filter((targetId) => available.has(targetId));
    for (let offset = 0; offset < selectedTargetIds.length; offset += DEX_MEASURED_HISTORY_TARGET_BATCH_SIZE) {
      const targetIdBatch = selectedTargetIds.slice(offset, offset + DEX_MEASURED_HISTORY_TARGET_BATCH_SIZE);
      const selectedResult: { results?: SparseCurrentQuoteWithTargetRow[] } = await runWithOverloadRetry(
        () =>
          input.db
            .prepare(
              `/* JOIN dex_measured_execution_targets: selected score-facing evidence scan */
               SELECT t.target_id, t.target_json,
                      q.generation_id AS quote_generation_id, q.target_generation_id,
                      q.status, q.failure_reason, q.quote_profile_json
               FROM dex_measured_execution_targets t
               LEFT JOIN dex_measured_execution_quotes q
                 ON q.generation_id = ?
                AND q.target_generation_id = t.generation_id
                AND q.target_id = t.target_id
               WHERE t.generation_id = ?
                 AND t.target_id IN (SELECT value FROM json_each(?))
               ORDER BY t.target_id`,
            )
            .bind(generation.generation_id, targetGenerationId, JSON.stringify(targetIdBatch))
            .all<SparseCurrentQuoteWithTargetRow>(),
        3,
        input.signal,
      );
      for (const row of selectedResult.results ?? []) {
        const quotedTarget = input.targetSchema.parse(
          parsePersistedJson(row.target_json, `${input.label} measured target JSON`),
        );
        if (quotedTarget.targetId !== row.target_id) {
          throw new Error(`${input.label} measured quote ${row.target_id} has a mismatched target row`);
        }
        const quoteGenerationId = row.quote_generation_id ?? row.generation_id ?? null;
        if (quoteGenerationId == null) {
          byTargetId.set(row.target_id, {
            quotedTarget,
            status: "failed",
            failureReason: "budget-deferred",
            profile: null,
          });
          continue;
        }
        const profile = row.quote_profile_json
          ? input.profileSchema.parse(
              parsePersistedJson(row.quote_profile_json, `${input.label} measured profile JSON`),
            )
          : null;
        if (
          (row.status === "measured" &&
            (row.target_generation_id !== targetGenerationId ||
              profile == null ||
              row.failure_reason != null ||
              profile.targetId !== row.target_id ||
              profile.targetGenerationId !== targetGenerationId ||
              profile.quoteGenerationId !== generation.generation_id)) ||
          (row.status === "failed" &&
            (row.target_generation_id !== targetGenerationId || profile != null || !row.failure_reason?.trim())) ||
          row.status == null
        ) {
          throw new Error(`${input.label} measured quote row ${row.target_id} has a torn terminal identity`);
        }
        byTargetId.set(row.target_id, {
          quotedTarget,
          status: row.status,
          failureReason: row.failure_reason,
          profile,
        });
      }
    }
    if (byTargetId.size !== selectedTargetIds.length) {
      throw new Error(`Published ${input.label} measured quote generation ${generation.generation_id} is incomplete`);
    }
    return {
      quoteGenerationId: generation.generation_id,
      targetGenerationId,
      publishedAt: generation.published_at ?? generation.started_at,
      byTargetId,
    };
  }
  const targetIds: string[] = [];
  let persistedRowsSeen = 0;
  let omittedRowsSeen = 0;
  let afterTargetId = "";
  while (byTargetId.size < targetCount) {
    const pageResult = await runWithOverloadRetry(
      () =>
        input.db
          .prepare(
            `/* JOIN dex_measured_execution_targets: sparse target-first evidence scan */
             SELECT t.target_id, t.target_json,
                    q.generation_id AS quote_generation_id, q.target_generation_id,
                    q.status, q.failure_reason, q.quote_profile_json
             FROM dex_measured_execution_targets t
             LEFT JOIN dex_measured_execution_quotes q
               ON q.generation_id = ?
              AND q.target_generation_id = t.generation_id
              AND q.target_id = t.target_id
             WHERE t.generation_id = ? AND t.target_id > ?
             ORDER BY t.target_id
             LIMIT ?`,
          )
          .bind(
            generation.generation_id,
            targetGenerationId,
            afterTargetId,
            DEX_MEASURED_CURRENT_EVIDENCE_PAGE_SIZE,
          )
          .all<SparseCurrentQuoteWithTargetRow>(),
      3,
      input.signal,
    );
    const page: Array<SparseCurrentQuoteWithTargetRow | undefined> = pageResult.results ?? [];
    if (page.length === 0) break;
    for (let rowIndex = 0; rowIndex < page.length; rowIndex++) {
      const row = page[rowIndex];
      page[rowIndex] = undefined;
      if (!row) continue;
      if (row.target_id <= afterTargetId || byTargetId.has(row.target_id)) {
        throw new Error(`${input.label} measured quote evidence pagination did not advance`);
      }
      const quotedTarget = input.targetSchema.parse(
        parsePersistedJson(row.target_json, `${input.label} measured target JSON`),
      );
      if (quotedTarget.targetId !== row.target_id) {
        throw new Error(`${input.label} measured quote ${row.target_id} has a mismatched target row`);
      }
      targetIds.push(row.target_id);
      const quoteGenerationId = row.quote_generation_id ?? row.generation_id ?? null;
      if (quoteGenerationId == null) {
        omittedRowsSeen++;
        byTargetId.set(row.target_id, {
          quotedTarget,
          status: "failed",
          failureReason: "budget-deferred",
          profile: null,
        });
        afterTargetId = row.target_id;
        continue;
      }
      persistedRowsSeen++;
      const profile = row.quote_profile_json
        ? input.profileSchema.parse(
            parsePersistedJson(row.quote_profile_json, `${input.label} measured profile JSON`),
          )
        : null;
      if (
        (row.status === "measured" &&
          (row.target_generation_id !== targetGenerationId ||
            profile == null ||
            row.failure_reason != null ||
            profile.targetId !== row.target_id ||
            profile.targetGenerationId !== targetGenerationId ||
            profile.quoteGenerationId !== generation.generation_id)) ||
        (row.status === "failed" &&
          (row.target_generation_id !== targetGenerationId || profile != null || !row.failure_reason?.trim())) ||
        row.status == null
      ) {
        throw new Error(`${input.label} measured quote row ${row.target_id} has a torn terminal identity`);
      }
      byTargetId.set(row.target_id, {
        quotedTarget,
        status: row.status,
        failureReason: row.failure_reason,
        profile: input.deferProfiles ? null : profile,
        ...(input.deferProfiles && row.quote_profile_json
          ? { deferredProfileJson: row.quote_profile_json }
          : {}),
      });
      afterTargetId = row.target_id;
    }
    page.length = 0;
  }
  const targetIdsSha256 = await hashMeasuredTargetIds(targetIds);
  if (
    byTargetId.size !== targetCount ||
    persistedRowsSeen !== persistedOutcomeCount ||
    omittedRowsSeen !== omittedBudgetDeferredCount ||
    (sparseTargetDigest != null && sparseTargetDigest !== targetIdsSha256)
  ) {
    throw new Error(`Published ${input.label} measured quote generation ${generation.generation_id} is incomplete`);
  }
  return {
    quoteGenerationId: generation.generation_id,
    targetGenerationId,
    publishedAt: generation.published_at ?? generation.started_at,
    byTargetId,
  };
}

export async function loadLatestPublishedDexMeasuredQuoteEvidence(
  db: D1Database,
  signal?: AbortSignal,
  options: { deferProfiles?: boolean } = {},
): Promise<LoadedDexMeasuredQuoteEvidence | null> {
  const currentEvidence = await loadCurrentMeasuredQuoteEvidence({
    db,
    quoteSurface: DEX_MEASURED_QUOTE_SURFACE,
    targetSurface: DEX_MEASURED_TARGET_SURFACE,
    label: "DEX",
    targetSchema: DexMeasuredExecutionTargetSchema,
    profileSchema: DexMeasuredExecutionProfileSchema,
    deferProfiles: options.deferProfiles,
    signal,
  });
  if (!currentEvidence) return null;
  const {
    quoteGenerationId,
    targetGenerationId,
    publishedAt: latestPublishedAt,
  } = currentEvidence;
  const byTargetId = new Map<
    string,
    LoadedDexMeasuredQuoteEvidence["byTargetId"] extends Map<string, infer T> ? T : never
  >();
  const historyCyclesByTargetId = new Map<string, DexMeasuredExecutionHistoryCycle[]>();
  const currentProfileJsonByTargetId = new Map<string, string>();
  const historyFinalizedTargetIds = new Set<string>();
  for (const [targetId, current] of currentEvidence.byTargetId) {
    const entry = {
      ...current,
      quoteGenerationId,
      targetGenerationId,
      resolution: "latest",
      latestFailureReason: current.failureReason,
    } as const;
    byTargetId.set(targetId, entry);
    if (current.deferredProfileJson) {
      currentProfileJsonByTargetId.set(targetId, current.deferredProfileJson);
    }
    historyCyclesByTargetId.set(targetId, [
      {
        generationId: quoteGenerationId,
        publishedAt: latestPublishedAt,
        status: current.status,
        operationalFailure:
          current.status === "failed" && isOperationalDexMeasuredFailure(current.failureReason),
        profile: current.profile,
      },
    ]);
  }
  currentEvidence.byTargetId.clear();
  const populateCurrentHistoryProfile = (targetId: string) => {
    const profileJson = currentProfileJsonByTargetId.get(targetId);
    if (!profileJson) return;
    const cycles = historyCyclesByTargetId.get(targetId);
    const currentCycle = cycles?.find((cycle) => cycle.generationId === quoteGenerationId);
    if (currentCycle?.status === "measured" && currentCycle.profile === null) {
      currentCycle.profile = DexMeasuredExecutionProfileSchema.parse(
        parsePersistedJson(profileJson, "DEX measured deferred history profile JSON"),
      );
    }
    currentProfileJsonByTargetId.delete(targetId);
  };

  // A transport or runtime-budget failure says nothing about executable depth.
  // Reuse the newest still-fresh measured row for that exact target identity;
  // consumer validation below retains the original quote clock and snapshot.
  try {
    const historyGenerationIds = await loadSupersededQuoteGenerationIds({
      db,
      quoteSurface: DEX_MEASURED_QUOTE_SURFACE,
      publishedAtFloor: latestPublishedAt - DEX_MEASURED_HISTORY_LOOKBACK_MAX_SEC,
      signal,
    });
    if (historyGenerationIds.length > 0) {
      const historyGenerationIdsJson = JSON.stringify(historyGenerationIds);
      const historicalTargetResult = await runWithOverloadRetry(
        () =>
          db
            .prepare(
              `SELECT DISTINCT target_id
         FROM dex_measured_execution_quotes
         WHERE generation_id IN (SELECT value FROM json_each(?))
         ORDER BY target_id`,
            )
            .bind(historyGenerationIdsJson)
            .all<{ target_id: string }>(),
        3,
        signal,
      );
      const historicalTargetIds = (historicalTargetResult.results ?? []).map((row) => row.target_id);
      for (let offset = 0; offset < historicalTargetIds.length; offset += DEX_MEASURED_HISTORY_TARGET_BATCH_SIZE) {
        const targetIdBatch = historicalTargetIds.slice(offset, offset + DEX_MEASURED_HISTORY_TARGET_BATCH_SIZE);
        const lkgBlockedTargetIds = new Set<string>();
        const historicalResult = await runWithOverloadRetry(
          () =>
            db
              .prepare(
                `SELECT q.generation_id, q.target_generation_id, q.target_id, q.status, q.failure_reason,
                  q.quote_profile_json, g.published_at AS quote_published_at, t.target_json
           FROM dex_measured_execution_quotes q
           JOIN surface_publication_generations g ON g.surface = ? AND g.generation_id = q.generation_id
           JOIN dex_measured_execution_targets t
             ON t.generation_id = q.target_generation_id AND t.target_id = q.target_id
           WHERE q.generation_id IN (SELECT value FROM json_each(?))
             AND q.target_id IN (SELECT value FROM json_each(?))
           ORDER BY q.target_id, g.published_at DESC, q.generation_id DESC`,
              )
              .bind(
                DEX_MEASURED_QUOTE_SURFACE,
                historyGenerationIdsJson,
                JSON.stringify(targetIdBatch),
              )
              .all<HistoricalQuoteRow>(),
          3,
          signal,
        );
        const historicalRows: Array<HistoricalQuoteRow | undefined> = historicalResult.results ?? [];
        for (let rowIndex = 0; rowIndex < historicalRows.length; rowIndex++) {
          const row = historicalRows[rowIndex];
          historicalRows[rowIndex] = undefined;
          if (!row) continue;
          const currentTarget = byTargetId.get(row.target_id)?.quotedTarget;
          if (
            currentTarget &&
            latestPublishedAt - row.quote_published_at >
              getDexMeasuredHistoryFreshnessSec(currentTarget.adapterProfileId)
          ) {
            continue;
          }
          const recordCycle = (cycle: DexMeasuredExecutionHistoryCycle) => {
            const cycles = historyCyclesByTargetId.get(row.target_id) ?? [];
            cycles.push(cycle);
            historyCyclesByTargetId.set(row.target_id, cycles);
          };
          const recordIntegrityBarrier = () => {
            recordCycle({
              generationId: row.generation_id,
              publishedAt: row.quote_published_at,
              status: "failed",
              operationalFailure: false,
              profile: null,
            });
            lkgBlockedTargetIds.add(row.target_id);
          };
          const targetJson = parseJson(row.target_json, { onFailure: () => undefined });
          const profileJson = row.quote_profile_json
            ? parseJson(row.quote_profile_json, { onFailure: () => undefined })
            : null;
          if (!targetJson.ok || (row.quote_profile_json != null && !profileJson?.ok)) {
            recordIntegrityBarrier();
            continue;
          }
          const targetResult = DexMeasuredExecutionTargetSchema.safeParse(targetJson.value);
          const profileResult = profileJson?.ok
            ? DexMeasuredExecutionProfileSchema.safeParse(profileJson.value)
            : null;
          const profile = profileResult?.success ? profileResult.data : null;
          const quotedTarget = targetResult.success ? targetResult.data : null;
          if (quotedTarget === null || !isCoherentHistoricalQuoteRow(row, quotedTarget, profile)) {
            recordIntegrityBarrier();
            continue;
          }
          recordCycle({
            generationId: row.generation_id,
            publishedAt: row.quote_published_at,
            status: row.status,
            operationalFailure: row.status === "failed" && isOperationalDexMeasuredFailure(row.failure_reason),
            profile,
          });
          if (row.status === "failed" && !isOperationalDexMeasuredFailure(row.failure_reason)) {
            lkgBlockedTargetIds.add(row.target_id);
          }

          const latest = byTargetId.get(row.target_id);
          if (
            row.status !== "measured" ||
            profile === null ||
            lkgBlockedTargetIds.has(row.target_id) ||
            latest?.resolution === "last-known-good" ||
            (latest != null && (latest.status === "measured" || !isOperationalDexMeasuredFailure(latest.failureReason)))
          ) {
            continue;
          }
          byTargetId.set(row.target_id, {
            quotedTarget,
            status: "measured",
            failureReason: null,
            profile: options.deferProfiles ? null : profile,
            ...(options.deferProfiles && row.quote_profile_json
              ? { deferredProfileJson: row.quote_profile_json }
              : {}),
            quoteGenerationId: row.generation_id,
            targetGenerationId: row.target_generation_id,
            resolution: "last-known-good",
            latestFailureReason: latest?.failureReason ?? "quote-missing",
          });
        }
        historicalRows.length = 0;
        for (const targetId of targetIdBatch) {
          populateCurrentHistoryProfile(targetId);
          const entry = byTargetId.get(targetId);
          const profile = entry ? materializeDexMeasuredQuoteProfile(entry) : null;
          if (entry?.status === "measured" && profile !== null) {
            const observationHistory = summarizeDexMeasuredExecutionHistory({
              cycles: historyCyclesByTargetId.get(targetId) ?? [],
              nowSec: latestPublishedAt,
              freshnessMaxSec: getDexMeasuredHistoryFreshnessSec(profile.adapterProfileId),
            });
            if (observationHistory) {
              byTargetId.set(targetId, { ...entry, observationHistory });
            }
          }
          historyCyclesByTargetId.delete(targetId);
          historyFinalizedTargetIds.add(targetId);
        }
      }
    }
  } catch {
    // Current-generation evidence remains usable if the optional LKG read fails.
  }

  for (const [targetId, entry] of byTargetId) {
    if (historyFinalizedTargetIds.has(targetId)) continue;
    populateCurrentHistoryProfile(targetId);
    const profile = materializeDexMeasuredQuoteProfile(entry);
    if (entry.status !== "measured" || profile === null) {
      historyCyclesByTargetId.delete(targetId);
      continue;
    }
    const observationHistory = summarizeDexMeasuredExecutionHistory({
      cycles: historyCyclesByTargetId.get(targetId) ?? [],
      nowSec: latestPublishedAt,
      freshnessMaxSec: getDexMeasuredHistoryFreshnessSec(profile.adapterProfileId),
    });
    if (observationHistory) {
      byTargetId.set(targetId, { ...entry, observationHistory });
    }
    historyCyclesByTargetId.delete(targetId);
  }

  return {
    quoteGenerationId,
    targetGenerationId,
    publishedAt: latestPublishedAt,
    byTargetId,
  };
}
