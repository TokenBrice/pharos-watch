import type { DigestInputData } from "@shared/types/digest";
import { isCriticalDepegRisk } from "@shared/lib/digest-risk";
import { computeLeadStreak, decideCriticalLeadSeverity } from "@shared/lib/digest-lead-policy";
import type { DigestLeadRequirement } from "./lead-requirements";

function severityBpsOf(depeg: DigestInputData["topDepegs"][number]): number {
  return depeg.currentBps ?? depeg.bps;
}

function depegKeyOf(depeg: DigestInputData["topDepegs"][number]): string {
  return depeg.stablecoinId ?? `symbol:${depeg.symbol.toUpperCase()}`;
}

export interface CriticalLeadContext {
  /** Parsed input of the previous edition, for the re-escalation test. */
  previousInputData?: DigestInputData | null;
  /** leadSignalIds of recent editions, newest first, for the lead quota. */
  recentLeadSignalIds?: readonly (string | null | undefined)[];
}

export function buildCriticalDailyLeadRequirements(
  inputData: DigestInputData,
  context: CriticalLeadContext = {},
): DigestLeadRequirement[] | undefined {
  // Criticality runs on the live deviation (currentBps) when available; the
  // stored peak is only a fallback for rows captured before the live price
  // was collected. Ranking is by impact (deviation × mcap), not raw bps, so
  // a small coin at huge bps cannot outrank a much larger broken coin.
  const criticalDepeg = inputData.topDepegs
    .filter(
      (depeg) => !depeg.suppressReason && isCriticalDepegRisk({ bps: severityBpsOf(depeg), mcapUsd: depeg.mcapUsd }),
    )
    .sort(
      (a, b) =>
        (b.impactScore ?? 0) - (a.impactScore ?? 0) ||
        Math.abs(severityBpsOf(b)) - Math.abs(severityBpsOf(a)),
    )[0];
  if (!criticalDepeg) return undefined;

  const symbol = criticalDepeg.symbol.toUpperCase();
  const candidate = (inputData.editorialCandidates ?? []).find((entry) =>
    entry.kind === "depeg" && !entry.suppressReason && entry.symbols.some((candidateSymbol) => candidateSymbol.toUpperCase() === symbol)
  );
  if (!candidate) return undefined;

  const previousDepeg = (context.previousInputData?.topDepegs ?? []).find(
    (entry) => depegKeyOf(entry) === depegKeyOf(criticalDepeg),
  );
  const decision = decideCriticalLeadSeverity({
    symbol,
    ageHours: criticalDepeg.ageHours,
    severityBps: severityBpsOf(criticalDepeg),
    previousSeverityBps: previousDepeg != null ? severityBpsOf(previousDepeg) : null,
    streak: computeLeadStreak(context.recentLeadSignalIds ?? [], candidate.id),
  });

  if (decision.severity === "hard") {
    return [{
      candidateIds: [candidate.id],
      severity: "hard",
      mentionTokens: [symbol],
      reason: decision.reason,
    }];
  }
  // Demoted ongoing story: mention-only. The coin must still appear somewhere
  // in the copy (readers tracking the event must not lose it), but no lead is
  // pinned and the variety machinery is free to rotate the headline.
  return [{
    candidateIds: [],
    severity: "soft",
    mentionTokens: [symbol],
    reason: decision.reason,
  }];
}
