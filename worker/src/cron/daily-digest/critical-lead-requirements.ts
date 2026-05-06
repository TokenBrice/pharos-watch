import type { DigestInputData } from "@shared/types/digest";
import { isCriticalDepegRisk } from "@shared/lib/digest-risk";
import type { DigestLeadRequirement } from "./lead-requirements";

export function buildCriticalDailyLeadRequirements(inputData: DigestInputData): DigestLeadRequirement[] | undefined {
  const criticalDepeg = inputData.topDepegs
    .filter((depeg) => !depeg.suppressReason && isCriticalDepegRisk(depeg))
    .sort((a, b) => Math.abs(b.bps) - Math.abs(a.bps) || (b.impactScore ?? 0) - (a.impactScore ?? 0))[0];
  if (!criticalDepeg) return undefined;

  const symbol = criticalDepeg.symbol.toUpperCase();
  const candidate = (inputData.editorialCandidates ?? []).find((entry) =>
    entry.kind === "depeg" && !entry.suppressReason && entry.symbols.some((candidateSymbol) => candidateSymbol.toUpperCase() === symbol)
  );
  if (!candidate) return undefined;

  return [{
    candidateIds: [candidate.id],
    severity: "hard",
    mentionTokens: [symbol],
    reason: `${symbol} active depeg crossed the critical severity threshold`,
  }];
}
