import { z } from "zod";

/** One verdict per claim group, evaluated on that group's latest appended decision. */
export const SENTINEL_VERDICTS = ["closed", "still-open", "replaced-adversely", "unverifiable"] as const;
export type SentinelVerdict = (typeof SENTINEL_VERDICTS)[number];

/**
 * Machine-readable verdict reasons. `closed` reasons state how much of the claim
 * group remains; the others name the exact condition that blocked closure.
 */
export const SENTINEL_VERDICT_REASONS = [
  "sentinels-absent",
  "sentinels-absent-group-clear",
  "sentinels-still-present",
  "sentinels-partially-absent",
  "measured-adverse-successor",
  "sibling-sentinel-successor",
  "no-sentinels",
  "narrative-only-sentinels",
  "sentinel-unresolvable",
  "uncheckable-sentinel",
  "registry-binding-unavailable",
  "capture-predates-decision",
  "asset-absent-from-registry",
  "asset-not-rated",
  "work-type-retired",
] as const;
export type SentinelVerdictReason = (typeof SENTINEL_VERDICT_REASONS)[number];

/**
 * `structured-pending-production` admission axis required by the plan. Only a
 * clean closure verifies admission; `unverifiable` never becomes `failed`, and
 * `failed` never becomes `verified`.
 */
export const SENTINEL_ADMISSIONS = ["verified", "failed", "not-applicable", "unverifiable"] as const;
export type SentinelAdmission = (typeof SENTINEL_ADMISSIONS)[number];

const nonEmptyText = z.string().refine((value) => value.trim().length > 0, "must not be blank");
const sha256Text = z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase SHA-256 hex digest");
const clockSec = z.number().int().nonnegative();

const SentinelResolutionRowSchema = z
  .object({
    claimGroupId: nonEmptyText,
    verdict: z.enum(SENTINEL_VERDICTS),
    reason: nonEmptyText,
    admission: z.enum(SENTINEL_ADMISSIONS),
    /** Position of the evaluated decision in the ledger this run read. */
    ledgerDecisionIndex: z.number().int().nonnegative(),
    registryFingerprint: sha256Text.optional(),
    asOfSec: clockSec.nullable().optional(),
    openItemCount: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export const SentinelResolutionsArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    inputs: z
      .object({
        registry: z
          .object({
            missingDataRegistryFingerprint: sha256Text,
            registrySha256: sha256Text,
            binding: z.object({ asOfSec: clockSec }).passthrough().nullable().optional(),
          })
          .passthrough(),
        ledger: z.object({ decisionCount: z.number().int().nonnegative() }).passthrough(),
        closureEvidence: nonEmptyText,
      })
      .passthrough(),
    groups: z.array(SentinelResolutionRowSchema).min(1),
  })
  .passthrough();

export type SentinelResolutionFields = Pick<z.output<typeof SentinelResolutionRowSchema>,
  "claimGroupId" | "verdict" | "reason" | "admission" | "ledgerDecisionIndex" | "openItemCount">;

export interface RegistryBinding {
  schemaVersion: number;
  asOfSec: number;
  asOfIso: string;
  candidateId: string;
  publicationGenerationId: string;
  baseInputGenerationId: string | null;
  factSetDigest: string | null;
  resultDigest: string | null;
  queueDigest: string | null;
  policyId: string | null;
  policyDigest: string | null;
  evaluationBuildDigest: string | null;
}

export interface SentinelMatch {
  kind: "gap" | "reason";
  /** Gap id, or `${reasonCode}|${path}`; `|*` marks a path-agnostic reason sentinel. */
  identity: string;
  status: "absent" | "present" | "adverse" | "successor";
  openItems: number;
  causes: string[];
}

export interface SentinelResolutionRow extends Omit<SentinelResolutionFields, "reason"> {
  workType: string;
  assetId: string;
  decision: string;
  deferState: string | null;
  reviewedAt: string;
  reviewedAtSec: number;
  reason: SentinelVerdictReason;
  registryFingerprint: string;
  asOfSec: number | null;
  groupState: "open-items" | "no-open-items";
  openItemCount: number;
  openTaskCount: number;
  taskIds: { total: number; open: number; closed: number };
  sentinels: {
    total: number;
    machineCheckable: number;
    gap: number;
    reason: number;
    narrative: number;
    unresolvable: number;
    absent: number;
    present: number;
    adverse: number;
    successor: number;
  };
  matches: SentinelMatch[];
  residualReasonCodes: string[];
  blocks: SentinelVerdictReason[];
}

export interface SentinelResolutionReport {
  schemaVersion: 1;
  title: string;
  purpose: string;
  contract: {
    evaluatedDecision: "latest-appended-decision-per-claim-group";
    closureRequires: string;
    admissionAxis: string;
  };
  inputs: {
    registryPath: string;
    ledgerPath: string;
    registry: {
      schemaVersion: number;
      stablecoinCount: number;
      openItemCount: number;
      missingDataRegistryFingerprint: string;
      /** SHA-256 of the exact registry file bytes this run parsed; null for programmatic callers without bytes. */
      registrySha256: string | null;
      binding: RegistryBinding | null;
    };
    ledger: {
      schemaVersion: number;
      decisionCount: number;
      claimGroupCount: number;
      latestReviewedAt: string | null;
    };
    replay: { path: string; candidateId: string; asOfSec: number; publicationGenerationId: string } | null;
    closureEvidence: "replay-verified" | "registry-snapshot" | "unavailable";
  };
  summary: {
    claimGroupCount: number;
    decisionCount: number;
    supersededDecisionCount: number;
    verdictCounts: Record<SentinelVerdict, number>;
    reasonCounts: Array<{ reason: SentinelVerdictReason; count: number }>;
    admissionCounts: Record<SentinelAdmission, number>;
    deferStateCounts: Array<{ key: string; count: number }>;
    groupStateCounts: { openItems: number; noOpenItems: number };
    closure: {
      groups: number;
      groupsWithOpenItems: number;
      openItemsInClosedGroups: number;
      derivedFactsClosed: number;
    };
    taskIds: { evaluated: number; open: number; closed: number };
    sentinels: {
      total: number;
      machineCheckable: number;
      absent: number;
      present: number;
      adverse: number;
      successor: number;
      narrative: number;
      unresolvable: number;
    };
    workTypeVerdictCounts: Array<{ workType: string; verdicts: Record<SentinelVerdict, number> }>;
  };
  groups: SentinelResolutionRow[];
}

