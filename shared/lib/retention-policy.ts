import { REQUEST_ATTRIBUTION_RETENTION_DAYS } from "./request-attribution";
import { SAFETY_SCORE_CAPTURE_ARCHIVE_RETENTION_SEC } from "./safety-score-capture-archive";

const DAY = 86_400;
export const WORKER_CANARY_RUN_RETENTION_SEC = 14 * DAY;
/** Oldest cron run clock retained by housekeeping and offline gap diagnostics. */
export const CRON_RUNS_RETENTION_SEC = 7 * DAY;

/** Limits are injected from worker/src/lib/bounded-prune.ts, never duplicated here. */
export interface RetentionLimits {
  batchLimit: number;
  runLimit: number;
}

export interface WindowedRetentionPolicy extends RetentionLimits {
  table: string;
  timestampColumn: string;
  windowSec: number;
  predicate: string;
  owner: string;
  permanent: false;
  clockFormat?: "utc-date";
  orderBy?: string;
  /** Multiple disjoint windows share ONE table budget. */
  windows?: readonly { windowSec: number; predicate: string }[];
  /** Sequential tables can share a single historical run ceiling. */
  budgetGroup?: string;
}

export interface PermanentRetentionPolicy {
  table: string;
  timestampColumn: string;
  windowSec: null;
  predicate: string;
  batchLimit: null;
  runLimit: null;
  owner: string;
  permanent: true;
}

export type RetentionPolicy = WindowedRetentionPolicy | PermanentRetentionPolicy | OwnerManagedRetentionPolicy;

const PRODUCER_HISTORY_WINDOWS = [
  { windowSec: 550 * DAY, predicate: "calendar_period IS NOT NULL" },
  { windowSec: 90 * DAY, predicate: "calendar_period IS NULL AND producer_kind = 'budget-only'" },
  { windowSec: 30 * DAY, predicate: "calendar_period IS NULL AND producer_kind != 'budget-only'" },
] as const;

export function producerHistoryRetentionPolicy(limits: RetentionLimits): WindowedRetentionPolicy {
  return {
    table: "worker_producer_history", timestampColumn: "completed_at", windowSec: 30 * DAY,
    predicate: "1 = 1", owner: "prune-cron-history", permanent: false,
    windows: PRODUCER_HISTORY_WINDOWS, ...limits,
  };
}

/** Worker-local evidence-window authorities are passed in without crossing runtimes. */
export function cronHistoryRetentionPolicies(
  limits: RetentionLimits & { smallBatchLimit: number; smallRunLimit: number },
  evidence: { safetyScoreJournalSec: number },
): Record<string, WindowedRetentionPolicy> {
  const policy = (
    table: string, timestampColumn: string, windowSec: number,
    options: Partial<WindowedRetentionPolicy> = {},
  ): WindowedRetentionPolicy => ({
    table, timestampColumn, windowSec, predicate: "1 = 1", owner: "prune-cron-history",
    permanent: false, ...limits, ...options,
  });
  return {
    cronRuns: policy("cron_runs", "started_at", CRON_RUNS_RETENTION_SEC),
    producerHistory: producerHistoryRetentionPolicy(limits),
    repairTasks: policy("worker_repair_tasks", "updated_at", 7 * DAY, {
      predicate: "state = 'closed'", batchLimit: limits.smallBatchLimit, runLimit: limits.smallRunLimit,
    }),
    canaryRuns: policy("worker_canary_runs", "observed_at", WORKER_CANARY_RUN_RETENTION_SEC, { batchLimit: limits.smallBatchLimit, runLimit: limits.smallRunLimit }),
    recoveryCheckpoints: policy("worker_scheduled_checkpoints", "updated_at", 14 * DAY, {
      predicate: "state IN ('completed', 'failed', 'platform_abandoned')", batchLimit: limits.smallBatchLimit, runLimit: limits.smallRunLimit,
    }),
    selectorSnapshotDailyQuota: policy("selector_snapshot_daily_quota", "quota_date", 2 * DAY, { clockFormat: "utc-date" }),
    blockTimestampCache: policy("block_timestamp_cache", "updated_at", 14 * DAY),
    slotExecutions: policy("cron_slot_executions", "slot_started_at", 14 * DAY),
    reserveContinuationExecutions: policy("reserve_continuation_executions", "finished_at", 14 * DAY, {
      predicate: "state = 'finished'", batchLimit: limits.smallBatchLimit, runLimit: limits.smallRunLimit,
    }),
    apiRequestConsumerStats: policy("api_request_consumer_stats", "bucket_start", REQUEST_ATTRIBUTION_RETENTION_DAYS * DAY),
    siteDataRequestStats: policy("site_data_request_stats", "bucket_start", REQUEST_ATTRIBUTION_RETENTION_DAYS * DAY),
    apiKeyRequestStats: policy("api_key_request_stats", "bucket_start", REQUEST_ATTRIBUTION_RETENTION_DAYS * DAY),
    safetyScoreJournal: policy("safety_score_publication_journal", "published_at", evidence.safetyScoreJournalSec),
    safetyScoreAttempts: policy("safety_score_publication_attempts", "attempted_at", evidence.safetyScoreJournalSec),
    safetyScoreCaptureArchive: policy("safety_score_capture_archive", "published_at", SAFETY_SCORE_CAPTURE_ARCHIVE_RETENTION_SEC, {
      orderBy: "published_at ASC, generation_id ASC",
    }),
    // Keep the historical 100k shared run ceiling; only statements use the
    // smaller 5k batch size. These are not 20k small-run retention families.
    selfServeRequestRateLimits: policy("api_key_request_rate_limit_v2", "bucket_start", 2 * DAY, {
      batchLimit: limits.smallBatchLimit, runLimit: limits.runLimit, budgetGroup: "selfServeRateLimits",
    }),
    selfServeIssuanceRateLimits: policy("api_key_self_serve_issuance_limits", "bucket_start", 2 * DAY, {
      batchLimit: limits.smallBatchLimit, runLimit: limits.runLimit, budgetGroup: "selfServeRateLimits",
    }),
    apiRequestSourceSamples: policy("api_request_source_samples", "bucket_start", REQUEST_ATTRIBUTION_RETENTION_DAYS * DAY, {
      batchLimit: limits.smallBatchLimit, runLimit: limits.smallRunLimit,
    }),
    siteDataRequestSamples: policy("site_data_request_samples", "bucket_start", REQUEST_ATTRIBUTION_RETENTION_DAYS * DAY, {
      batchLimit: limits.smallBatchLimit, runLimit: limits.smallRunLimit,
    }),
  };
}

/** Only registry-owned identifiers/fragments may reach this builder; values stay bound. */
export function retentionDeleteStatement(policy: WindowedRetentionPolicy, nowSec: number): {
  sql: string;
  bindsForLimit: (limit: number) => unknown[];
  batchLimit: number;
  runLimit: number;
} {
  const windows = policy.windows ?? [{ windowSec: policy.windowSec, predicate: policy.predicate }];
  const cutoffs = windows.map(({ windowSec }) => {
    const cutoff = nowSec - windowSec;
    return policy.clockFormat === "utc-date" ? new Date(cutoff * 1000).toISOString().slice(0, 10) : cutoff;
  });
  const where = windows.map(({ predicate }) => `(${predicate} AND ${policy.timestampColumn} < ?)`).join(" OR ");
  return {
    sql: `DELETE FROM ${policy.table} WHERE rowid IN (SELECT rowid FROM ${policy.table} WHERE ${where} ORDER BY ${policy.orderBy ?? `${policy.timestampColumn} ASC`} LIMIT ?)`,
    bindsForLimit: (limit) => [...cutoffs, limit],
    batchLimit: policy.batchLimit,
    runLimit: policy.runLimit,
  };
}

export const TELEGRAM_RETENTION_WINDOWS = {
  alertAudit: 90 * DAY,
  authoritativeWorkflow: DAY,
  authoritativeReplay: 14 * DAY,
  staleUnresolved: 30 * DAY,
  usageDaily: 400 * DAY,
  chatDiagnostics: 90 * DAY,
  shortLivedChatCache: 7 * DAY,
  reEngagementWarningCache: 30 * DAY,
} as const;

export interface CacheRetentionPolicy {
  name: string;
  match: "prefix" | "exact";
  key: string;
  /** NULL means a reviewed retired namespace, independent of last write time. */
  windowSec: number | null;
  owner: "prune-detail-cache";
}

// No global cache TTL: product snapshots, provider ledgers and frozen detail
// rows must not be swept. These are telemetry-only namespaces and exact ops keys.
export const CACHE_RETENTION_POLICIES: readonly CacheRetentionPolicy[] = [
  { name: "cronEvents", match: "prefix", key: "cron:event:", windowSec: 30 * DAY, owner: "prune-detail-cache" },
  { name: "budgetSurfaceTelemetry", match: "prefix", key: "cron:budget-surface:", windowSec: 30 * DAY, owner: "prune-detail-cache" },
  { name: "d1CapacityTelemetry", match: "exact", key: "ops:d1-capacity:v1", windowSec: 30 * DAY, owner: "prune-detail-cache" },
  { name: "d1GrowthTelemetry", match: "exact", key: "ops:d1-table-growth:v1", windowSec: 30 * DAY, owner: "prune-detail-cache" },
  { name: "retiredMintBurnV1", match: "prefix", key: "mint-burn-flows:v1:", windowSec: null, owner: "prune-detail-cache" },
  { name: "retiredMintBurnV2", match: "prefix", key: "mint-burn-flows:v2:", windowSec: null, owner: "prune-detail-cache" },
  { name: "retiredMintBurnV3", match: "prefix", key: "mint-burn-flows:v3:", windowSec: null, owner: "prune-detail-cache" },
  { name: "retiredBlacklistSummaryV1", match: "exact", key: "blacklist:summary:producer:v1", windowSec: null, owner: "prune-detail-cache" },
  { name: "retiredBlacklistSummaryV2", match: "exact", key: "blacklist:summary:producer:v2", windowSec: null, owner: "prune-detail-cache" },
];

/** Domain owners remain the sole executable authority for specialized policies. */
export interface OwnerManagedRetentionPolicy {
  table: string;
  timestampColumn: string;
  windowSec: { authority: string; description: string };
  predicate: { authority: string; description: string };
  batchLimit: { authority: string };
  runLimit: { authority: string };
  owner: string;
  permanent: false;
  execution: "owner";
}

const PERMANENT_TABLE_CLOCKS = [
  ["admin_action_audit", "created_at", "admin audit"],
  ["api_key_audit_log", "created_at", "credential audit"],
  ["api_key_donor_claims", "claimed_at", "supporter claims"],
  ["blacklist_events", "timestamp", "blacklist event ledger"],
  ["blacklist_reconciliation_runs", "started_at", "blacklist reconciliation audit"],
  ["chain_supply_history", "snapshot_date", "chain supply archive"],
  ["daily_digest", "generated_at", "digest archive"],
  ["depeg_backfill_runs", "started_at", "depeg backfill audit"],
  ["depeg_events", "started_at", "depeg event archive"],
  ["depeg_pending_outcomes", "outcome_at", "depeg candidate audit"],
  ["depeg_resolver_event_repair_authorizations", "created_at", "DDR repair authorization"],
  ["depeg_resolver_event_repair_authorization_uses", "used_at", "DDR repair audit"],
  ["depeg_resolver_event_repair_authorization_consumptions", "consumed_at", "DDR repair audit"],
  ["depeg_resolver_first_publications_v2", "published_at", "DDR first publication"],
  ["depeg_resolver_incident_event_links", "linked_at", "DDR identity audit"],
  ["depeg_resolver_incident_lineage", "created_at", "DDR identity audit"],
  ["depeg_resolver_incident_policy_membership", "created_at", "DDR policy audit"],
  ["depeg_resolver_incident_revisions", "created_at", "DDR identity audit"],
  ["depeg_resolver_lock_opportunity_audit", "run_at", "DDR lock audit"],
  ["depeg_resolver_prediction_errata", "created_at", "DDR errata"],
  ["depeg_resolver_public_predictions", "created_at", "DDR public predictions"],
  ["depeg_resolver_publication_snapshot_errata", "created_at", "DDR publication audit"],
  ["depeg_resolver_publication_snapshot_finalizations", "finalized_at", "DDR publication audit"],
  ["depeg_resolver_publication_snapshot_refs", "published_at", "DDR publication audit"],
  ["depeg_resolver_publication_snapshots", "published_at", "DDR publication audit"],
  ["depeg_resolver_publication_snapshots_v2", "published_at", "DDR publication audit"],
  ["dex_native_shadow_quotes", "quoted_at", "stopped diagnostics; separately gated cleanup"],
  ["dex_native_shadow_quotes_v2", "quoted_at", "stopped diagnostics; separately gated cleanup"],
  ["dex_meteora_dlmm_shadow_quotes", "quoted_at", "stopped diagnostics; separately gated cleanup"],
  ["mint_burn_scan_coverage", "accepted_at", "finalized scan proof; lossless compaction, no age delete"],
  ["public_snapshots", "created_at", "public snapshot archive"],
  ["safety_grade_history", "recorded_at", "legacy Safety history"],
  ["safety_score_history_v2", "recorded_at", "versioned Safety history"],
  ["stability_index", "computed_at", "legacy stability history"],
  ["status_transitions", "created_at", "status incident archive"],
  ["supply_history", "snapshot_date", "supply product history (D15)"],
  ["tape_events", "ts", "Tape product archive (D15)"],
] as const;

const PERMANENT_RETENTION_POLICIES: readonly PermanentRetentionPolicy[] = PERMANENT_TABLE_CLOCKS.map(
  ([table, timestampColumn, owner]) => ({
    table, timestampColumn, owner, permanent: true,
    windowSec: null, predicate: "no automatic age delete", batchLimit: null, runLimit: null,
  }),
);

// References document the existing rule; descriptions never build SQL or caps.
const OWNER_MANAGED_TABLES = [
  ["status_probe_runs", "created_at", "worker/src/cron/prune-status-probe-runs.ts", "90 days", "strict cutoff; 10,000 rows per invocation"],
  ["d1_capacity_observations", "observed_at", "worker/src/lib/status/d1-capacity-store.ts", "180 days", "hourly observation age"],
  ["stability_index_samples", "stored_at", "worker/src/cron/stability-index.ts", "90 days", "strict sample age"],
  ["reserve_composition_history", "fetched_at", "worker/src/lib/live-reserves/store-write.ts", "LIVE_RESERVE_HISTORY_RETENTION_SEC (30 days)", "protect frozen IDs and current/referenced attempts; bounded batches"],
  ["reserve_sync_attempt_history", "attempted_at", "worker/src/lib/live-reserves/store-write.ts", "LIVE_RESERVE_HISTORY_RETENTION_SEC (30 days)", "protect frozen IDs and current/referenced attempts; bounded batches"],
  ["mint_burn_events", "timestamp", "worker/src/cron/mint-burn/retention.ts", "8 days", "finalized pricing, Tape cursor and aggregate/frontier guards"],
  ["mint_burn_hourly", "hour_ts", "worker/src/cron/mint-burn/retention.ts", "95 days", "only once corresponding source rows are gone"],
  ["report_card_evidence_journal", "recorded_at", "worker/src/lib/bounded-journal-store.ts", "BOUNDED_JOURNAL_RETENTION_SEC (45 days)", "age plus 32 rows per asset"],
  ["safety_score_v9_supply_attribution_journal", "recorded_at", "worker/src/lib/bounded-journal-store.ts", "BOUNDED_JOURNAL_RETENTION_SEC (45 days)", "age plus 32 rows per asset"],
  ["dependency_scenario_payload_chunks", "created_at", "worker/scripts/compute-dependency-scenarios.ts", "DEPENDENCY_SCENARIO_ORPHAN_GRACE_SEC (24 hours)", "protect latest/recent payloads, live writers and cached manifests; 500 chunks per run"],
  ["dex_liquidity_history", "snapshot_date", "worker/src/cron/dex-liquidity/persistence.ts", "DEX_LIQUIDITY_HISTORY_RETENTION_SEC (365 days)", "strict snapshot cutoff"],
  ["dex_price_challenger_publications_v2", "published_at", "worker/src/cron/dex-liquidity/challenger-publish.ts", "superseded sealed or abandoned beyond twice the scheduled wall-clock ceiling", "accepted-head protected; bounded child-before-parent cleanup"],
  ["yield_history", "recorded_at", "worker/src/cron/yield-sync/history.ts", "YIELD_HISTORY_RAW_DAYS (30 days)", "non-frozen IDs; matching daily close at least as new as raw row"],
  ["yield_history_daily", "snapshot_date", "worker/src/cron/yield-sync/history.ts", "YIELD_HISTORY_MAX_DAYS (365 days)", "non-frozen IDs; strict snapshot cutoff"],
  ["yield_source_decisions", "created_at", "worker/src/cron/yield-sync/history.ts", "AUDIT_DECISION_RETENTION_DAYS (30 days)", "DECISION_RETENTION_DELETE_PREDICATE: retention_reason = 'audit' AND COALESCE(source_switch, 0) != 1; bounded drain"],
  ["yield_source_decision_alternatives", "recorded_at", "worker/src/cron/yield-sync/history.ts", "AUDIT_DECISION_RETENTION_DAYS (30 days)", "only orphan alternatives with no matching selected decision"],
  ["scheduled_child_attempts", "slot_started_at", "worker/migrations/0260_scheduled_child_attempts.sql", "parent cron slot window (14 days)", "ON DELETE CASCADE from executing cron_slot_executions identity"],
  ["reserve_continuation_child_attempts", "terminal_at", "worker/migrations/0276_reserve_continuation_executions.sql", "parent Queue execution window (14 days after terminal)", "ON DELETE CASCADE from reserve_continuation_executions; active events are retained"],
  ["telegram_webhook_operation_mutations", "applied_at", "worker/migrations/0000_baseline.sql", "parent processed-update window (7 days)", "ON DELETE CASCADE from telegram_processed_updates"],
  ["telegram_processed_updates", "received_at", "worker/src/cron/telegram/maintenance/telegram-retention-cleanup.ts", "7 days", "processed-update eligibility; 5,000 rows and time budget"],
  ["telegram_recap_targets", "updated_at", "worker/src/cron/telegram/maintenance/telegram-retention-cleanup.ts", "30-day settled / 90-day terminal audit", "retired recap audit; schema cleanup separately gated"],
  ["telegram_alert_dead_letters", "expired_at", "worker/src/cron/telegram/maintenance/telegram-retention-cleanup.ts", "TELEGRAM_RETENTION_WINDOWS.alertAudit", "strict audit cutoff"],
  ["telegram_alert_job_target_items", "created_at", "worker/src/cron/telegram/maintenance/telegram-retention-cleanup.ts", "14-day replay / 90-day audit", "terminal legacy/replay eligibility; child-before-parent; own cap per phase"],
  ["telegram_alert_job_targets", "created_at", "worker/src/cron/telegram/maintenance/telegram-retention-cleanup.ts", "14-day replay / 90-day audit", "terminal delivery/effect state; no active pending evidence"],
  ["telegram_alert_jobs", "created_at", "worker/src/cron/telegram/maintenance/telegram-retention-cleanup.ts", "14-day terminal / 30-day unresolved / 90-day audit", "protect referenced source/target workflow evidence"],
  ["telegram_alert_source_events", "detected_at", "worker/src/cron/telegram/maintenance/telegram-retention-cleanup.ts", "14-day replay / 30-day unresolved / 90-day audit", "terminal or expired unresolved with no child references"],
  ["telegram_alert_target_plan_items", "created_at", "worker/src/cron/telegram/maintenance/telegram-retention-cleanup.ts", "1-day terminal workflow", "source completed_at cutoff; complete/expired source"],
  ["telegram_alert_target_plan_pages", "created_at", "worker/src/cron/telegram/maintenance/telegram-retention-cleanup.ts", "1-day terminal workflow", "source completed_at cutoff; complete/expired source"],
  ["telegram_alert_planning_subscribers", "captured_at", "worker/src/cron/telegram/maintenance/telegram-retention-cleanup.ts", "1-day terminal workflow", "source completed_at cutoff; complete/expired source"],
  ["telegram_alert_target_expiry_progress", "updated_at", "worker/src/cron/telegram/maintenance/telegram-retention-cleanup.ts", "1-day terminal workflow", "source completed_at cutoff; child.state = 'complete'"],
  ["telegram_alert_target_plans", "created_at", "worker/src/cron/telegram/maintenance/telegram-retention-cleanup.ts", "14-day replay", "complete/expired source and no referencing target"],
  ["telegram_alert_source_resolution_targets", "created_at", "worker/src/cron/telegram/maintenance/telegram-retention-cleanup.ts", "14-day replay / 90-day audit", "terminal source completed_at or audit created_at"],
  ["telegram_alert_source_resolution_memberships", "created_at", "worker/src/cron/telegram/maintenance/telegram-retention-cleanup.ts", "14-day replay / 90-day audit", "terminal source completed_at or audit created_at"],
  ["telegram_alert_source_resolution_pages", "created_at", "worker/src/cron/telegram/maintenance/telegram-retention-cleanup.ts", "14-day replay / 90-day audit", "terminal source completed_at or audit created_at"],
  ["telegram_freeze_alert_targets", "created_at", "worker/src/cron/telegram/maintenance/telegram-retention-cleanup.ts", "90-day audit", "strict created_at cutoff"],
  ["telegram_freeze_alert_events", "detected_at", "worker/src/cron/telegram/maintenance/telegram-retention-cleanup.ts", "90-day audit", "strict detected_at cutoff"],
  ["telegram_usage_daily", "day", "worker/src/cron/telegram/maintenance/telegram-retention-cleanup.ts", "400 days", "UTC date-string cutoff"],
  ["telegram_watcher_lifecycle_daily", "day", "worker/src/cron/telegram/maintenance/telegram-retention-cleanup.ts", "400 days", "UTC date-string cutoff"],
  ["telegram_adoption_daily", "day", "worker/src/cron/telegram/maintenance/telegram-retention-cleanup.ts", "400 days", "UTC date-string cutoff"],
  ["telegram_adoption_retention_daily", "measurement_day", "worker/src/cron/telegram/maintenance/telegram-retention-cleanup.ts", "400 days", "UTC date-string cutoff"],
  ["telegram_adoption_ingress_quota", "updated_at", "worker/src/cron/telegram/maintenance/telegram-retention-cleanup.ts", "2 days", "strict updated_at cutoff"],
  ["telegram_adoption_client_quota", "updated_at", "worker/src/cron/telegram/maintenance/telegram-retention-cleanup.ts", "2 days", "strict updated_at cutoff"],
  ["telegram_chat_delivery_diagnostics", "updated_at", "worker/src/cron/telegram/maintenance/telegram-retention-cleanup.ts", "90 days", "strict updated_at cutoff"],
  ["telegram_change_log", "observed_at", "worker/src/cron/telegram/rollup/change-log.ts", "TELEGRAM_ALERT_POLICY.rollup.changeLogRetentionSec (8 days)", "strict observed_at cutoff; pruned by the roll-up scan"],
] as const;

const OWNER_MANAGED_RETENTION_POLICIES: readonly OwnerManagedRetentionPolicy[] = OWNER_MANAGED_TABLES.map(
  ([table, timestampColumn, owner, window, predicate]) => ({
    table, timestampColumn, owner, permanent: false, execution: "owner",
    windowSec: { authority: owner, description: window },
    predicate: { authority: owner, description: predicate },
    batchLimit: { authority: owner }, runLimit: { authority: owner },
  }),
);

export function retentionPolicyRegistry(
  limits: Parameters<typeof cronHistoryRetentionPolicies>[0],
  evidence: Parameters<typeof cronHistoryRetentionPolicies>[1],
): readonly RetentionPolicy[] {
  return [
    ...Object.values(cronHistoryRetentionPolicies(limits, evidence)),
    ...PERMANENT_RETENTION_POLICIES,
    ...OWNER_MANAGED_RETENTION_POLICIES,
  ];
}

/** Explicit non-append classifications; a newly clocked table must be reviewed. */
export const RETENTION_NON_APPEND_TABLES: Readonly<Record<string, string>> = {
  admin_idempotency_keys: "mutable request reservations",
  api_key_rate_limit: "request-owned rolling rate buckets",
  api_key_requests: "retired mutable request workflow; separately gated cleanup",
  api_key_self_serve_email_claims: "retired keyed claims; separately gated cleanup",
  api_key_self_serve_revocations: "credential revocation state",
  api_keys: "mutable credential state",
  authoritative_vault_rates: "last-good per-asset state",
  blacklist_amount_repair_queue: "mutable repair queue",
  blacklist_current_balances: "current address balance state",
  blacklist_sync_state: "per-config cursors",
  cache: "mixed keyed cache; separately allowlisted namespace policies",
  cron_leases: "current lease state",
  cron_run_progress: "latest per-job progress",
  depeg_event_provenance: "one mutable provenance projection per event",
  depeg_pending: "in-flight candidate state",
  depeg_resolver_assessments: "updateable event/checkpoint/methodology identity",
  depeg_resolver_training_corpus: "trigger-maintained replaceable event/assessment rollup; source-owned lifetime",
  depeg_resolver_incidents: "mutable canonical incident lifecycle",
  depeg_resolver_prediction_lock_state: "mutable incident lock state",
  depeg_resolver_publication_snapshot_rows: "parent-owned publication projection; no independent clock",
  detail_cache_write_generations: "current per-asset write fence",
  dex_deployment_outcomes: "current per-deployment crawl evidence",
  dex_discovery_meta: "current discovery cursor",
  dex_liquidity: "current published per-asset rows",
  dex_liquidity_publication_generations: "generation/pointer-aware domain retention",
  dex_liquidity_run_rows: "generation-owned staging rows",
  dex_liquidity_scoring_stage_chunks: "generation-owned stage chunks",
  dex_liquidity_scoring_stages: "mutable stage lifecycle",
  dex_measured_execution_quotes: "generation-owned quote outcomes",
  dex_measured_execution_targets: "generation-owned captured targets",
  dex_native_generation_quotes: "generation-owned quote outcomes",
  dex_native_generations: "generation/pointer-aware domain retention",
  dex_native_publication_pointers: "current publication pointers",
  dex_pool_registry: "current source pool state",
  dex_pool_staging: "retired mutable staging; separately gated cleanup",
  dex_price_challenger_heads_v2: "current per-asset challenger publication pointers",
  dex_price_challenger_payloads_v2: "publication-owned payload rows; challenger-publish.ts bounds pointer-aware and abandoned-generation cleanup",
  dex_price_challenger_snapshots: "current per-asset challenger snapshot",
  dex_price_challengers: "current challenger snapshot rows",
  dex_price_run_rows: "generation-owned price staging",
  dex_prices: "current per-asset price state",
  dex_source_pagination_state: "current source cursor",
  feedback_rate_limit: "request-owned rolling rate buckets",
  kv_config: "keyed configuration without a history clock",
  mint_burn_config_deferral: "current config admission state",
  mint_burn_dirty_hours: "mutable materialization debt; only atomic rebuild settles each key",
  mint_burn_run_state: "current per-job cursor",
  mint_burn_sync_state: "current per-config cursor",
  onchain_supply: "current per-chain supply state",
  price_cache: "current per-asset price state",
  pricing_provider_negative_cache: "retired current provider response state",
  pricing_provider_runtime_state: "current provider availability",
  redemption_backstop: "current per-asset publication",
  redemption_backstop_history: "replaceable daily close; redemption owner retains 90 days",
  redemption_backstop_run_rows: "generation-owned staging",
  redemption_backstop_runs: "mutable generation lifecycle",
  reserve_composition: "current per-asset reserve state",
  reserve_sync_state: "current per-asset attempt state",
  safety_score_public_manifests: "generation/version-owned derived representation; writer retires replaced selection with in-flight read grace",
  safety_score_public_fragments: "manifest-owned immutable fragments; cascade retirement from safety_score_public_manifests",
  safety_score_site_manifests: "generation/version/representation-owned derived website response; writer retires replaced selection with in-flight read grace",
  safety_score_site_fragments: "manifest-owned immutable website fragments; cascade retirement from safety_score_site_manifests",
  status_discrepancy_state: "current discrepancy counters",
  status_state: "current status hysteresis state",
  stress_signal_history: "replaceable daily DEWS materialization",
  stress_signal_publication_rows: "generation-owned publication buffer",
  stress_signals: "bounded rolling DEWS computation buffer",
  stress_signals_latest: "current per-asset DEWS publication",
  surface_publication_generations: "mutable generation/pointer lifecycle",
  telegram_delivery_pauses: "current transport admission state",
  telegram_digest_outbox: "mutable delivery lifecycle; dedicated outbox owner",
  telegram_pending_alerts: "mutable pending delivery queue; dedicated cleanup owner",
  telegram_jobs: "mutable delivery v2 job state (planning/ready/done); telegram-retention-cleanup prunes completed jobs with no rows after 30 days",
  telegram_deliveries: "mutable delivery v2 rows (claim, attempts, terminal state); telegram-retention-cleanup prunes terminal rows by done_at after 30 days",
  telegram_pending_disambiguation: "expiring interaction state",
  telegram_rollup_state: "one upserted last-roll-up marker per chat; removed by /forget",
  telegram_preset_subscriptions: "current subscriber preferences",
  telegram_recap_preferences: "retired recap audit pending separate schema cleanup",
  telegram_subscribers: "mutable subscriber lifecycle",
  telegram_subscriptions: "current subscriber preferences",
  telegram_transport_circuit: "current outage control state",
  telegram_transport_failure_observations: "five-minute keyed/upserted outage observations",
  telegram_watcher_lifecycle_events_daily: "upserted daily transition counters",
  worker_producer_heads: "current producer summaries",
  worker_producer_retained_counts: "trigger-maintained current retained-history counters per producer identity; zero rows persist with heads, no independent age delete",
  yield_coverage_review_dispositions: "mutable reviewed evidence dispositions",
  yield_data: "current selected-source yield state",
  yield_publication_generations: "mutable generation/pointer lifecycle",
};
