import type { DexExecutionCapabilityGate } from "@shared/types/market";
import type { PoolEntry } from "../dex-liquidity/types";

export interface NativeMeasuredExecutionJoinDiagnostics {
  targetCount: number;
  measuredCount: number;
  gatedCount: number;
  failuresByReason: Record<string, number>;
  quoteGenerationId: string | null;
  targetGenerationId: string | null;
}

export interface NativeMeasuredExecutionJoinEvidenceMetadata {
  quoteGenerationId: string | null;
  targetGenerationId: string | null;
}

export interface NativeMeasuredExecutionJoinTarget {
  adapterProfileId: string;
  targetId: string;
  poolId: string;
}

export type NativeMeasuredExecutionJoinKind = "solana" | "tron";

type PoolExtra = NonNullable<PoolEntry["extra"]>;
type NativePublicProfile = NonNullable<PoolExtra["nativeMeasuredExecution"]>;

export function createNativeMeasuredExecutionJoinDiagnostics(
  evidence: NativeMeasuredExecutionJoinEvidenceMetadata | null,
): NativeMeasuredExecutionJoinDiagnostics {
  return {
    targetCount: 0,
    measuredCount: 0,
    gatedCount: 0,
    failuresByReason: {},
    quoteGenerationId: evidence?.quoteGenerationId ?? null,
    targetGenerationId: evidence?.targetGenerationId ?? null,
  };
}

export function mapNativeMeasuredExecutionValidationGate(
  issues: readonly string[],
): DexExecutionCapabilityGate["reason"] {
  if (issues.includes("stale-observation")) return "stale-observation";
  if (issues.some((issue) => issue.includes("generation-mismatch"))) return "generation-mismatch";
  return "invalid-observation";
}

function gate(reason: DexExecutionCapabilityGate["reason"]): DexExecutionCapabilityGate {
  return { family: "measured-execution", reason };
}

function increment(record: Record<string, number>, reason: string): void {
  record[reason] = (record[reason] ?? 0) + 1;
}

function ensurePoolExtra(pool: PoolEntry): PoolExtra {
  pool.extra = { ...(pool.extra ?? {}) };
  return pool.extra;
}

export function resetNativeMeasuredExecutionJoinFields(
  pool: PoolEntry,
  kind: NativeMeasuredExecutionJoinKind,
  target: NativeMeasuredExecutionJoinTarget,
): PoolExtra {
  const extra = ensurePoolExtra(pool);
  if (kind === "solana") {
    delete extra.solanaMeasuredExecution;
    delete extra.solanaMeasuredExecutionProfile;
    extra.solanaMeasuredExecutionPhysicalPoolId = target.poolId;
  } else {
    delete extra.tronMeasuredExecution;
    delete extra.tronMeasuredExecutionProfile;
    extra.tronMeasuredExecutionPhysicalPoolId = target.poolId;
  }
  delete extra.nativeMeasuredExecution;
  delete extra.nativeMeasuredExecutionPhysicalPoolId;
  return extra;
}

export function recordNativeMeasuredExecutionFailure(params: {
  pool: PoolEntry;
  kind: NativeMeasuredExecutionJoinKind;
  target: NativeMeasuredExecutionJoinTarget;
  diagnostics: NativeMeasuredExecutionJoinDiagnostics;
  reason: DexExecutionCapabilityGate["reason"];
  detail?: string;
}): void {
  const extra = ensurePoolExtra(params.pool);
  extra.executionCapabilityGate = gate(params.reason);
  const diagnostic = {
    adapterProfileId: params.target.adapterProfileId,
    targetId: params.target.targetId,
    ...(params.detail ? { detail: params.detail.slice(0, 300) } : {}),
  };
  if (params.kind === "solana") {
    extra.solanaMeasuredExecutionDiagnostic = diagnostic;
  } else {
    extra.tronMeasuredExecutionDiagnostic = diagnostic;
  }
  params.diagnostics.gatedCount++;
  increment(params.diagnostics.failuresByReason, `${params.target.adapterProfileId}:${params.reason}`);
}

export function promoteNativeMeasuredExecutionProfile(params: {
  pool: PoolEntry;
  kind: NativeMeasuredExecutionJoinKind;
  target: NativeMeasuredExecutionJoinTarget;
  publicProfile: NativePublicProfile;
  detail?: string;
}): void {
  const extra = ensurePoolExtra(params.pool);
  if (params.kind === "solana") {
    extra.solanaMeasuredExecution = params.publicProfile as PoolExtra["solanaMeasuredExecution"];
  } else {
    extra.tronMeasuredExecution = params.publicProfile as PoolExtra["tronMeasuredExecution"];
  }
  extra.nativeMeasuredExecution = params.publicProfile;
  extra.nativeMeasuredExecutionPhysicalPoolId = params.target.poolId;
  if (extra.executionCapabilityGate?.family === "measured-execution") {
    delete extra.executionCapabilityGate;
  }
  const diagnostic = {
    adapterProfileId: params.target.adapterProfileId,
    targetId: params.target.targetId,
    ...(params.detail ? { detail: params.detail } : {}),
  };
  if (params.kind === "solana") {
    extra.solanaMeasuredExecutionDiagnostic = diagnostic;
  } else {
    extra.tronMeasuredExecutionDiagnostic = diagnostic;
  }
}
