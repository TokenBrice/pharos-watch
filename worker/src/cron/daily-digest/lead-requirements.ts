import { getMetaString } from "./digest-intelligence-utils";

export interface DigestLeadRequirement {
  candidateIds: string[];
  severity: "hard" | "soft";
  reason: string;
  mentionTokens?: string[];
}

function normalizeCandidateIds(ids: readonly string[]): string[] {
  return ids.map((id) => id.trim()).filter(Boolean);
}

function mentionsAnyToken(haystack: string, tokens: readonly string[]): boolean {
  const normalized = haystack.toLowerCase();
  return tokens
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean)
    .some((token) => normalized.includes(token));
}

export function validateDigestLeadRequirements(params: {
  parsedMeta: Record<string, unknown> | null;
  digestTitle: string;
  digestText: string;
  digestExtended: string;
  leadRequirements: readonly DigestLeadRequirement[] | undefined;
}): Array<{ code: string; severity: "hard" | "soft"; message: string }> {
  const issues: Array<{ code: string; severity: "hard" | "soft"; message: string }> = [];
  const leadSignalId = getMetaString(params.parsedMeta, "leadSignalId");
  const outputForMentionChecks = `${params.digestTitle}\n${params.digestText}\n${params.digestExtended}`;

  for (const requirement of params.leadRequirements ?? []) {
    const candidateIds = normalizeCandidateIds(requirement.candidateIds);
    // A requirement with no candidateIds is mention-only (a demoted ongoing
    // story): the coin must appear, but no lead is pinned.
    if (candidateIds.length > 0 && (!leadSignalId || !candidateIds.includes(leadSignalId))) {
      issues.push({
        code: "lead-candidate-mismatch",
        severity: requirement.severity,
        message: `Lead signal '${leadSignalId ?? "missing"}' did not match required candidate ${candidateIds.join(", ")}: ${requirement.reason}.`,
      });
    }
    if (requirement.mentionTokens && requirement.mentionTokens.length > 0 && !mentionsAnyToken(outputForMentionChecks, requirement.mentionTokens)) {
      issues.push({
        code: "required-lead-missing",
        severity: requirement.severity,
        message: `Digest omitted required lead token(s) ${requirement.mentionTokens.join(", ")}: ${requirement.reason}.`,
      });
    }
  }

  return issues;
}
