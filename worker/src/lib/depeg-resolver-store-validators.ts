import { DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC } from "@shared/lib/depeg-resolver-version";

type DdrStoreLockTrigger = "scheduled_24h" | "forecast_readiness" | "readiness_backstop";

export interface DdrStoreLockMetadataInput {
  lockTrigger?: DdrStoreLockTrigger | null;
  forecastReadinessScore?: number | null;
  forecastReadinessVersion?: string | null;
  readinessThreshold?: number | null;
  backstopAt?: number | null;
  backstopDelaySec?: number | null;
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

export function assertOptionalHash(value: string | null | undefined, name: string): void {
  if (value == null) return;
  assertHash(value, name);
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
