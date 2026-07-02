import { DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC } from "@shared/lib/depeg-resolver-version";

export type DdrLockTrigger = "scheduled_24h" | "forecast_readiness" | "readiness_backstop";

export interface DdrStoreLockMetadataInput {
  lockTrigger?: DdrLockTrigger | null;
  forecastReadinessScore?: number | null;
  forecastReadinessVersion?: string | null;
  readinessThreshold?: number | null;
  backstopAt?: number | null;
  backstopDelaySec?: number | null;
}

export const DDR_LOCK_METADATA_COLUMNS_SQL = `lock_trigger, forecast_readiness_score, forecast_readiness_version, readiness_threshold,
          backstop_at, backstop_delay_sec`;
export const DDR_LOCK_METADATA_PLACEHOLDERS_SQL = "?, ?, ?, ?, ?, ?";

export const DDR_LOCK_STATE_INSERT_COLUMNS_SQL = `incident_key, event_id, prediction_policy_version, eligible_at, first_eligible_seen_at,
          last_attempted_at, deferral_count, last_deferral_reason, last_state, created_at, updated_at,
          ${DDR_LOCK_METADATA_COLUMNS_SQL}`;

export const DDR_LOCK_AUDIT_INSERT_COLUMNS_SQL = `incident_key, event_id, run_id, run_at, eligible_at, health_status, action,
          confirmation_at, outcome_at, reason, created_at, ${DDR_LOCK_METADATA_COLUMNS_SQL}`;

export function lockStateInsertValuesSql(
  deferralCountSql: "0" | "1",
  lastDeferralReasonSql: "?" | "NULL",
  lastStateSql: "?" | "'lock_deferred'",
): string {
  return `?, ?, ?, ?, ?, ?, ${deferralCountSql}, ${lastDeferralReasonSql}, ${lastStateSql}, ?, ?, ${DDR_LOCK_METADATA_PLACEHOLDERS_SQL}`;
}

export interface LockStateOnConflictOptions {
  incrementDeferralCount: boolean;
  preserveDeferralReason: boolean;
  preserveMetadata: boolean;
  lastStateSql: "excluded.last_state" | "'lock_deferred'";
}

function lockMetadataAssignment(column: string, preserve: boolean): string {
  return preserve
    ? `${column} = COALESCE(depeg_resolver_prediction_lock_state.${column}, excluded.${column})`
    : `${column} = excluded.${column}`;
}

export function lockStateOnConflictUpdateSql(options: LockStateOnConflictOptions): string {
  const assignments = [
    "last_attempted_at = excluded.last_attempted_at",
    ...(options.incrementDeferralCount
      ? ["deferral_count = depeg_resolver_prediction_lock_state.deferral_count + 1"]
      : []),
    options.preserveDeferralReason
      ? "last_deferral_reason = depeg_resolver_prediction_lock_state.last_deferral_reason"
      : "last_deferral_reason = excluded.last_deferral_reason",
    `last_state = ${options.lastStateSql}`,
    lockMetadataAssignment("lock_trigger", options.preserveMetadata),
    lockMetadataAssignment("forecast_readiness_score", options.preserveMetadata),
    lockMetadataAssignment("forecast_readiness_version", options.preserveMetadata),
    lockMetadataAssignment("readiness_threshold", options.preserveMetadata),
    lockMetadataAssignment("backstop_at", options.preserveMetadata),
    lockMetadataAssignment("backstop_delay_sec", options.preserveMetadata),
    "updated_at = excluded.updated_at",
  ];
  return `ON CONFLICT(incident_key) DO UPDATE SET
           ${assignments.join(",\n           ")}`;
}

export function lockAuditInsertValuesSql(
  confirmationAtSql: "?" | "NULL",
  outcomeAtSql: "?" | "NULL",
  reasonSql: "?" | "NULL",
): string {
  return `?, ?, ?, ?, ?, ?, ?, ${confirmationAtSql}, ${outcomeAtSql}, ${reasonSql}, ?, ${DDR_LOCK_METADATA_PLACEHOLDERS_SQL}`;
}

export function bindLockMetadata(
  input: DdrStoreLockMetadataInput,
): [DdrLockTrigger | null, number | null, string | null, number | null, number | null, number | null] {
  return [
    input.lockTrigger ?? null,
    input.forecastReadinessScore ?? null,
    input.forecastReadinessVersion ?? null,
    input.readinessThreshold ?? null,
    input.backstopAt ?? null,
    input.backstopDelaySec ?? null,
  ];
}

export function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

export function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

function assertUnitIntervalNumber(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a finite number in [0, 1]`);
  }
}

export function assertNonEmpty(value: string, name: string): void {
  if (value.trim().length === 0) throw new Error(`${name} must be non-empty`);
}

export function assertHash(value: string, name: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`${name} must be a 64-character lowercase hex hash`);
}

export function assertLockMetadata(input: DdrStoreLockMetadataInput): void {
  if (input.forecastReadinessScore != null) {
    assertUnitIntervalNumber(input.forecastReadinessScore, "forecastReadinessScore");
  }
  if (input.forecastReadinessVersion != null) {
    assertNonEmpty(input.forecastReadinessVersion, "forecastReadinessVersion");
  }
  if (input.readinessThreshold != null) {
    assertUnitIntervalNumber(input.readinessThreshold, "readinessThreshold");
  }
  if (input.backstopAt != null) {
    assertPositiveInteger(input.backstopAt, "backstopAt");
  }
  if (input.backstopDelaySec != null) {
    assertNonNegativeInteger(input.backstopDelaySec, "backstopDelaySec");
    if (input.backstopDelaySec !== DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC) {
      throw new Error("backstop metadata requires the readiness-72h backstop delay");
    }
  }
  if (input.lockTrigger === "forecast_readiness") {
    if (input.forecastReadinessScore == null) throw new Error("readiness lock requires forecastReadinessScore");
    if (input.forecastReadinessVersion == null) throw new Error("readiness lock requires forecastReadinessVersion");
    if (input.readinessThreshold == null) throw new Error("readiness lock requires readinessThreshold");
  }
  if (input.lockTrigger === "readiness_backstop") {
    if (input.backstopAt == null) throw new Error("backstop lock requires backstopAt");
    if (input.backstopDelaySec == null) throw new Error("backstop lock requires backstopDelaySec");
  }
}
