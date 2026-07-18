import type {
  DigestEditorialAudit,
  DigestInputData,
} from "@shared/types/digest";
import { selectMomentumCandidates } from "./editorial-candidates";
import type { DigestLeadRequirement } from "./lead-requirements";
import { buildCalmNarrativeFrame } from "./digest-calm-frame";
import { buildChangeSummary } from "./digest-change-summary";
import { buildForwardLookOutcomes, buildNextTriggers } from "./digest-next-triggers";
import { buildRiskTape } from "./digest-risk-tape";
import { normalizeStringArray, unique } from "./digest-intelligence-utils";

interface DigestMetaLike {
  leadSignalId?: unknown;
  usedCandidateIds?: unknown;
  suppressedCandidateIds?: unknown;
}

export function parseStoredDigestInput(value: string | null | undefined): DigestInputData | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const candidate = parsed as Partial<DigestInputData>;
    if (!Array.isArray(candidate.topDepegs)) return null;
    if (typeof candidate.totalMcapUsd !== "number") return null;
    return candidate as DigestInputData;
  } catch {
    return null;
  }
}

export function buildDigestIntelligence(
  data: DigestInputData,
  previousData: DigestInputData | null,
): Pick<
  DigestInputData,
  "changeSummary" | "nextTriggers" | "forwardLookOutcomes" | "riskTape" | "calmNarrativeFrame"
> {
  return {
    changeSummary: buildChangeSummary(data, previousData),
    nextTriggers: buildNextTriggers(data, previousData),
    forwardLookOutcomes: buildForwardLookOutcomes(data, previousData),
    riskTape: buildRiskTape(data),
    calmNarrativeFrame: buildCalmNarrativeFrame(data),
  };
}

export function attachDigestEditorialAudit(params: {
  inputData: DigestInputData;
  digestMeta: string | null;
  qualityIssues: Array<{ code: string }>;
  leadRequirements?: DigestLeadRequirement[];
}): DigestInputData {
  return {
    ...params.inputData,
    editorialAudit: buildEditorialAudit(params),
  };
}

function buildEditorialAudit(params: {
  inputData: DigestInputData;
  digestMeta: string | null;
  qualityIssues: Array<{ code: string }>;
  leadRequirements?: DigestLeadRequirement[];
}): DigestEditorialAudit {
  const candidates = params.inputData.editorialCandidates ?? [];
  const usable = candidates.filter((candidate) => !candidate.suppressReason);
  const suppressed = candidates.filter((candidate) => candidate.suppressReason);
  const momentum = selectMomentumCandidates(candidates);
  const meta = parseDigestMeta(params.digestMeta);
  const leadCandidateId = typeof meta?.leadSignalId === "string" ? meta.leadSignalId : null;
  const leadCandidate = leadCandidateId
    ? candidates.find((candidate) => candidate.id === leadCandidateId)
    : null;
  const qualityIssueCodes = unique(params.qualityIssues.map((issue) => issue.code).filter(Boolean));
  // dedup: LLM-emitted meta can repeat ids; the shared normalizeStringArray no longer
  // dedups (response.ts intentionally keeps duplicates), so dedup here for editorialAudit.
  const usedCandidateIds = unique(normalizeStringArray(meta?.usedCandidateIds) ?? []);
  const modelSuppressedCandidateIds = unique(normalizeStringArray(meta?.suppressedCandidateIds) ?? []);
  const requiredLeadCandidateIds = unique((params.leadRequirements ?? []).flatMap((requirement) => requirement.candidateIds));
  const leadRequirementReasons = unique(
    (params.leadRequirements ?? []).map((requirement) => `${requirement.severity}: ${requirement.reason}`),
  );
  const demotedLeadMentionTokens = unique(
    (params.leadRequirements ?? [])
      .filter((requirement) => requirement.severity === "soft" && requirement.candidateIds.length === 0)
      .flatMap((requirement) => requirement.mentionTokens ?? []),
  );

  return {
    topCandidateIds: candidates.slice(0, 8).map((candidate) => candidate.id),
    usableCandidateIds: usable.slice(0, 8).map((candidate) => candidate.id),
    suppressedCandidateIds: suppressed.slice(0, 8).map((candidate) => candidate.id),
    momentumCandidateIds: momentum.map((candidate) => candidate.id),
    ...(requiredLeadCandidateIds.length > 0 ? { requiredLeadCandidateIds } : {}),
    ...(leadRequirementReasons.length > 0 ? { leadRequirementReasons } : {}),
    ...(demotedLeadMentionTokens.length > 0 ? { demotedLeadMentionTokens } : {}),
    leadCandidateId,
    leadCandidateTitle: leadCandidate?.title ?? null,
    ...(usedCandidateIds.length > 0 ? { usedCandidateIds } : {}),
    ...(modelSuppressedCandidateIds.length > 0 ? { modelSuppressedCandidateIds } : {}),
    ...(qualityIssueCodes.length > 0 ? { qualityIssueCodes } : {}),
  };
}

function parseDigestMeta(value: string | null): DigestMetaLike | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null ? parsed as DigestMetaLike : null;
  } catch {
    return null;
  }
}

