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
export type NativeMeasuredExecutionPublicProfile = NonNullable<PoolExtra["nativeMeasuredExecution"]>;

export interface NativeMeasuredExecutionJoinQuote<
  TTarget extends NativeMeasuredExecutionJoinTarget,
  TProfile extends { adapterProfileId: string },
> {
  quotedTarget: TTarget;
  status: "measured" | "failed";
  failureReason: string | null;
  profile: TProfile | null;
}

export interface NativeMeasuredExecutionJoinEvidence<
  TTarget extends NativeMeasuredExecutionJoinTarget,
  TProfile extends { adapterProfileId: string },
> extends NativeMeasuredExecutionJoinEvidenceMetadata {
  byTargetId: Map<string, NativeMeasuredExecutionJoinQuote<TTarget, TProfile>>;
}

export interface NativeMeasuredExecutionJoinAdapter<
  TTarget extends NativeMeasuredExecutionJoinTarget,
  TProfile extends { adapterProfileId: string },
  TPublicProfile extends NativeMeasuredExecutionPublicProfile,
  TPolicy,
  TQuote extends NativeMeasuredExecutionJoinQuote<TTarget, TProfile>,
  TEvidence extends NativeMeasuredExecutionJoinEvidenceMetadata & { byTargetId: Map<string, TQuote> },
  TDiagnostics extends NativeMeasuredExecutionJoinDiagnostics,
> {
  kind: NativeMeasuredExecutionJoinKind;
  getTarget(pool: PoolEntry): TTarget | undefined;
  createDiagnostics(evidence: TEvidence | null): TDiagnostics;
  resolvePolicy(adapterProfileId: string): TPolicy | null;
  policyMatchesProfile(policy: TPolicy, profile: TProfile): boolean;
  validateProfile(input: {
    profile: TProfile;
    quote: TQuote;
    evidence: TEvidence;
    target: TTarget;
    nowSec: number;
  }): readonly string[];
  toPublicProfile(profile: TProfile): TPublicProfile;
  setPublicProfile(pool: PoolEntry, profile: TPublicProfile): void;
  getActivationFailure(input: {
    policy: TPolicy;
    profile: TProfile;
    quote: TQuote;
    target: TTarget;
  }): { reason: DexExecutionCapabilityGate["reason"]; detail?: string } | null;
  getProofFailure?(input: {
    policy: TPolicy;
    profile: TProfile;
    quote: TQuote;
    target: TTarget;
  }): { reason: DexExecutionCapabilityGate["reason"]; detail?: string } | null;
  getPromotionDetail?(quote: TQuote): string | undefined;
  onPromoted?(diagnostics: TDiagnostics, quote: TQuote): void;
}

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
  publicProfile: NativeMeasuredExecutionPublicProfile;
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

export function joinNativeMeasuredExecutionEvidence<
  TTarget extends NativeMeasuredExecutionJoinTarget,
  TProfile extends { adapterProfileId: string },
  TPublicProfile extends NativeMeasuredExecutionPublicProfile,
  TPolicy,
  TQuote extends NativeMeasuredExecutionJoinQuote<TTarget, TProfile>,
  TEvidence extends NativeMeasuredExecutionJoinEvidenceMetadata & { byTargetId: Map<string, TQuote> },
  TDiagnostics extends NativeMeasuredExecutionJoinDiagnostics,
>(input: {
  poolsByStablecoin: Map<string, PoolEntry[]>;
  evidence: TEvidence | null;
  nowSec: number;
  adapter: NativeMeasuredExecutionJoinAdapter<
    TTarget,
    TProfile,
    TPublicProfile,
    TPolicy,
    TQuote,
    TEvidence,
    TDiagnostics
  >;
}): TDiagnostics {
  const diagnostics = input.adapter.createDiagnostics(input.evidence);
  for (const pools of input.poolsByStablecoin.values()) {
    for (const pool of pools) {
      const target = input.adapter.getTarget(pool);
      if (!target) continue;
      diagnostics.targetCount++;
      resetNativeMeasuredExecutionJoinFields(pool, input.adapter.kind, target);
      const fail = (reason: DexExecutionCapabilityGate["reason"], detail?: string) => {
        recordNativeMeasuredExecutionFailure({
          pool,
          kind: input.adapter.kind,
          target,
          diagnostics,
          reason,
          detail,
        });
      };
      if (!input.evidence) {
        fail("quote-missing");
        continue;
      }
      const quote = input.evidence.byTargetId.get(target.targetId);
      if (!quote) {
        fail("quote-missing");
        continue;
      }
      if (quote.status !== "measured" || !quote.profile) {
        fail(
          quote.failureReason === "budget-deferred" ? "budget-deferred" : "quote-failed",
          quote.failureReason ?? undefined,
        );
        continue;
      }
      const policy = input.adapter.resolvePolicy(quote.profile.adapterProfileId);
      if (!policy || !input.adapter.policyMatchesProfile(policy, quote.profile)) {
        fail("invalid-observation", "adapter-registration-mismatch");
        continue;
      }
      const issues = input.adapter.validateProfile({
        profile: quote.profile,
        quote,
        evidence: input.evidence,
        target,
        nowSec: input.nowSec,
      });
      if (issues.length > 0) {
        fail(mapNativeMeasuredExecutionValidationGate(issues), issues.join(","));
        continue;
      }
      const publicProfile = input.adapter.toPublicProfile(quote.profile);
      input.adapter.setPublicProfile(pool, publicProfile);
      const activationFailure = input.adapter.getActivationFailure({
        policy,
        profile: quote.profile,
        quote,
        target,
      });
      if (activationFailure) {
        fail(activationFailure.reason, activationFailure.detail);
        diagnostics.measuredCount++;
        continue;
      }
      const proofFailure = input.adapter.getProofFailure?.({
        policy,
        profile: quote.profile,
        quote,
        target,
      });
      if (proofFailure) {
        fail(proofFailure.reason, proofFailure.detail);
        continue;
      }
      promoteNativeMeasuredExecutionProfile({
        pool,
        kind: input.adapter.kind,
        target,
        publicProfile,
        detail: input.adapter.getPromotionDetail?.(quote),
      });
      input.adapter.onPromoted?.(diagnostics, quote);
      diagnostics.measuredCount++;
    }
  }
  return diagnostics;
}
