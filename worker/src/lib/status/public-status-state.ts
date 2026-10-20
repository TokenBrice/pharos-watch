import { z } from "zod";
import {
  getPublicComponentStateRank,
  headlineToStatusLevel,
  projectPublicStatus,
  toPublicTransitionComponents,
  type PublicComponentSinceMap,
  type PublicStatusProjection,
} from "@shared/lib/public-status-components";
import {
  PUBLIC_COMPONENT_STATES,
  PUBLIC_STATUS_COMPONENT_IDS,
  PublicStatusHeadlineSchema,
  PublicStatusTransitionComponentSchema,
  type HealthResponse,
  type PublicStatusHistoryBoundary,
  type PublicStatusTransition,
} from "@shared/types/status";
import { getStatusSeverity } from "@shared/lib/public-health";
import {
  buildStatusTransitionIdempotencyKey,
  persistStatusStateAtomically,
  reportStatusPersistenceIssue,
  type StatusPersistenceIssueReporter,
  type StatusStateRow,
} from "../status-reliability-shared";

/**
 * Persisted public projection (decision 2026-10-13: the public incident log
 * follows the public projection, not the operator state machine). Rows share
 * `status_state` / `status_transitions` under their own scope; every operator
 * reader filters on scope `global`, so the two streams never mix.
 */
const PUBLIC_STATUS_SCOPE = "public";

const PersistedComponentSchema = z.object({
  id: z.enum(PUBLIC_STATUS_COMPONENT_IDS),
  state: z.enum(PUBLIC_COMPONENT_STATES),
  since: z.number().nullable(),
  reasons: z.array(z.string()),
});

// Tolerant read: a component id or state this release does not know (added or
// retired by another release) is dropped, not allowed to void every `since`.
const PersistedStateSchema = z.object({
  version: z.literal(1),
  headline: z.unknown(),
  componentHistoryStartedAt: z.record(z.string(), z.number()).optional(),
  components: z.array(z.unknown()).transform((items) => items.flatMap((item) => {
    const parsed = PersistedComponentSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  })),
});

const PersistedTransitionSchema = z.object({
  version: z.literal(1),
  headline: PublicStatusHeadlineSchema,
  componentHistoryStartedAt: z.record(z.string(), z.number()).optional(),
  components: z.array(PublicStatusTransitionComponentSchema),
});

function parseJson(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export interface PublicStatusReconciliation {
  projection: PublicStatusProjection;
  persistenceSucceeded: boolean;
}

/** Only bounded forensic identities participate; ages, clocks and metric counts are not heartbeat events. */
function causeIdentity(reasons: readonly string[]): string {
  return reasons.filter((reason) => /^(?:upstream-circuits-open:|circuits-unavailable:|(?:heavy-)?scheduler:unavailable:)/.test(reason))
    .slice(0, 16).sort().join("|");
}

/**
 * Project the public health payload, carry each component's `since` forward,
 * and persist a public transition whenever any component or the headline
 * changes. A failed state read still returns a projection, without `since`.
 */
export async function reconcilePublicStatusState(
  db: D1Database,
  now: number,
  health: HealthResponse,
  onIssue?: StatusPersistenceIssueReporter,
): Promise<PublicStatusReconciliation> {
  let row: (Pick<StatusStateRow, "current_status" | "last_changed_at" | "causes_json"> & { history_started_at?: number | null }) | null;
  try {
    row = await db
      .prepare(`SELECT current_status, last_changed_at, causes_json,
        CASE WHEN CASE WHEN json_valid(causes_json)
          THEN json_type(causes_json, '$.componentHistoryStartedAt') = 'object' ELSE 0 END THEN NULL
          ELSE (SELECT MIN(created_at) FROM status_transitions WHERE scope = 'public') END AS history_started_at
        FROM status_state WHERE scope = ?`)
      .bind(PUBLIC_STATUS_SCOPE)
      .first();
  } catch (error) {
    reportStatusPersistenceIssue(onIssue, "public_status_state_read_failed", "load-public-status-state", error);
    return { projection: projectPublicStatus(health), persistenceSucceeded: false };
  }

  const parsed = row ? PersistedStateSchema.safeParse(parseJson(row.causes_json)) : null;
  const previous = parsed?.success ? parsed.data : null;
  const previousById = new Map(previous?.components.map((component) => [component.id, component]) ?? []);
  const sinceMap: PublicComponentSinceMap = Object.fromEntries(
    [...previousById].map(([id, component]) => [id, { state: component.state, since: component.since }]),
  );
  const projection = projectPublicStatus(health, sinceMap);
  const componentHistoryStartedAt = Object.fromEntries(projection.components.map((component) => [
    component.id,
    previous?.componentHistoryStartedAt?.[component.id]
      ?? (previousById.has(component.id) ? row?.history_started_at ?? now : now),
  ]));
  // A state change observed now starts now. An unchanged state keeps its
  // persisted start, which stays null when it was first seen at initialization.
  for (const component of projection.components) {
    const prior = previousById.get(component.id);
    if (prior && prior.state !== component.state) component.since = now;
  }

  const causesChanged = previous != null && projection.components.some((component) =>
    causeIdentity(component.reasons) !== causeIdentity(previousById.get(component.id)?.reasons ?? []));
  const changed = previous == null
    || PublicStatusHeadlineSchema.safeParse(previous.headline).data?.state !== projection.headline.state
    || projection.components.some((component) => previousById.get(component.id)?.state !== component.state)
    || causesChanged;
  const nextLevel = headlineToStatusLevel(projection.headline.state);
  const previousLevel = row?.current_status ?? null;
  const worsened = previous != null && projection.components.some((component) =>
    getPublicComponentStateRank(component.state)
      > getPublicComponentStateRank(previousById.get(component.id)?.state ?? "operational"));
  const transitionType = previous == null
    ? "init"
    : (previousLevel != null && getStatusSeverity(nextLevel) > getStatusSeverity(previousLevel)) || worsened
      || (causesChanged && nextLevel !== "healthy")
      ? "degrade"
      : "recover";
  const reason = previous == null ? "public-projection-initialized"
    : causesChanged ? "public-projection-causes-changed" : "public-projection-changed";

  const stateJson = JSON.stringify({
    version: 1,
    headline: projection.headline,
    componentHistoryStartedAt,
    components: projection.components.map((component) => ({
      id: component.id, state: component.state, since: component.since, reasons: component.reasons,
    })),
  });
  const transitionJson = JSON.stringify({
    version: 1,
    headline: projection.headline,
    componentHistoryStartedAt,
    components: toPublicTransitionComponents(projection.components),
  } satisfies z.input<typeof PersistedTransitionSchema>);

  const statements = [
    db.prepare(
      `INSERT INTO status_state
       (scope, current_status, raw_status, last_evaluated_at, last_changed_at,
        consecutive_healthy, consecutive_degraded, consecutive_stale, confidence, causes_json, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, 0, 0, 1, ?, ?)
       ON CONFLICT(scope) DO UPDATE SET
         current_status = excluded.current_status,
         raw_status = excluded.raw_status,
         last_evaluated_at = excluded.last_evaluated_at,
         last_changed_at = excluded.last_changed_at,
         causes_json = excluded.causes_json,
         updated_at = excluded.updated_at
       WHERE status_state.updated_at <= excluded.updated_at`,
    ).bind(
      PUBLIC_STATUS_SCOPE,
      nextLevel,
      health.status,
      now,
      changed ? now : row?.last_changed_at ?? now,
      stateJson,
      now,
    ),
    ...(changed
      ? [db.prepare(
        `INSERT OR IGNORE INTO status_transitions
         (scope, previous_status, next_status, raw_status, transition_type, reason, confidence, causes_json, created_at, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      ).bind(
        PUBLIC_STATUS_SCOPE,
        previousLevel,
        nextLevel,
        health.status,
        transitionType,
        reason,
        transitionJson,
        now,
        buildStatusTransitionIdempotencyKey({
          scope: PUBLIC_STATUS_SCOPE,
          previousStatus: previousLevel,
          nextStatus: nextLevel,
          rawStatus: health.status,
          transitionType,
          reason,
          confidence: 1,
          causesJson: transitionJson,
          createdAt: now,
        }),
      )]
      : []),
  ];
  const persistenceSucceeded = await persistStatusStateAtomically(db, statements, onIssue, "update_public_status_state");
  return { projection, persistenceSucceeded };
}

interface PublicTransitionRow {
  id: number;
  previous_status: PublicStatusTransition["from"];
  next_status: PublicStatusTransition["to"];
  transition_type: PublicStatusTransition["transitionType"];
  reason: string;
  causes_json: string | null;
  created_at: number;
}

/** Persisted public-projection transitions in a window, newest first. Throws on read failure. */
export async function listPublicStatusTransitions(
  db: D1Database,
  limit: number,
  from: number,
): Promise<{ transitions: PublicStatusTransition[]; startedAt: number | null; componentHistoryStartedAt: Record<string, number>; boundary: PublicStatusHistoryBoundary | null; hasMore: boolean }> {
  const [rows, first, boundaryRow] = await Promise.all([
    db.prepare(
      `/* pharos:public-status-transitions */ SELECT id, previous_status, next_status, transition_type, reason, causes_json, created_at
       FROM status_transitions
       WHERE scope = ? AND created_at >= ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    ).bind(PUBLIC_STATUS_SCOPE, from, limit + 1).all<PublicTransitionRow>(),
    db.prepare(`/* pharos:public-status-started-at */ SELECT MIN(created_at) AS started_at,
      (SELECT causes_json FROM status_state WHERE scope = 'public') AS state_json
      FROM status_transitions WHERE scope = ?`)
      .bind(PUBLIC_STATUS_SCOPE)
      .first<{ started_at: number | null; state_json?: string | null }>(),
    db.prepare(
      `/* pharos:public-status-boundary */ SELECT causes_json, created_at
       FROM status_transitions
       WHERE scope = ? AND created_at <= ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    ).bind(PUBLIC_STATUS_SCOPE, from).first<Pick<PublicTransitionRow, "causes_json" | "created_at">>(),
  ]);
  const results = rows.results ?? [];
  const transitions = results.slice(0, limit).map((row): PublicStatusTransition => {
    const parsed = PersistedTransitionSchema.safeParse(parseJson(row.causes_json));
    return {
      id: row.id,
      from: row.previous_status,
      to: row.next_status,
      transitionType: row.transition_type,
      reason: row.reason,
      at: row.created_at,
      source: "public",
      ...(parsed.success ? { headline: parsed.data.headline, components: parsed.data.components } : {}),
    };
  });
  const state = PersistedStateSchema.safeParse(parseJson(first?.state_json ?? null));
  const componentHistoryStartedAt = state.success
    ? state.data.componentHistoryStartedAt ?? Object.fromEntries(
      state.data.components.flatMap((component) => first?.started_at == null ? [] : [[component.id, first.started_at]]),
    )
    : {};
  const hasMore = results.length > limit;
  const boundaryState = PersistedTransitionSchema.safeParse(parseJson(boundaryRow?.causes_json ?? null));
  const boundary = !hasMore && boundaryState.success && boundaryRow != null
    && Number.isFinite(boundaryRow.created_at) && boundaryRow.created_at >= 0 && boundaryRow.created_at <= from
    ? { at: boundaryRow.created_at, components: boundaryState.data.components }
    : null;
  return { transitions, startedAt: first?.started_at ?? null, componentHistoryStartedAt, boundary, hasMore };
}
