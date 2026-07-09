import { formatSignedPercent } from "@shared/lib/format";
import type { YieldPublicDecisionLedger } from "@shared/types";
import { YIELD_DECISION_REASON_LABELS, YIELD_DECISION_REJECTION_REASON_LABELS } from "@/lib/yield-presentation";

export interface YieldDecisionAlternativeDisplay {
  sourceKey: string;
  yieldSource: string;
  rejectionLabel: string;
  apy30dDeltaLabel: string;
}

export interface YieldDecisionLedgerDisplay {
  reasonLabel: string;
  summary: string;
  sourceSwitchLabel: string | null;
  previousSourceKey: string | null;
  rejectedCountLabel: string | null;
  alternatives: YieldDecisionAlternativeDisplay[];
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

function formatApy30dDelta(delta: number | null | undefined): string | null {
  if (typeof delta !== "number" || !Number.isFinite(delta)) return null;
  return `${formatSignedPercent(delta, 2)} APY30d`;
}

function buildSourceSwitchLabel(ledger: YieldPublicDecisionLedger): string | null {
  if (!ledger.sourceSwitch) return null;
  const deltaLabel = formatApy30dDelta(ledger.apy30dDeltaFromPrevious);
  return deltaLabel ? `Source changed (${deltaLabel})` : "Source changed";
}

export function buildYieldDecisionLedgerDisplay(
  ledger: YieldPublicDecisionLedger | null | undefined,
): YieldDecisionLedgerDisplay | null {
  if (!ledger) return null;

  const reasonLabel = YIELD_DECISION_REASON_LABELS[ledger.selectedReasonCode];
  if (!reasonLabel) return null;

  const rejectedCount = Number.isFinite(ledger.rejectedCount) ? ledger.rejectedCount : 0;
  const rejectedCountLabel =
    rejectedCount > 0 ? `${rejectedCount} ${pluralize(rejectedCount, "alternate")} rejected` : null;
  const sourceSwitchLabel = buildSourceSwitchLabel(ledger);
  const summary = [reasonLabel, sourceSwitchLabel, rejectedCountLabel].filter(Boolean).join(" | ");

  return {
    reasonLabel,
    summary,
    sourceSwitchLabel,
    previousSourceKey: ledger.previousBestSourceKey ?? null,
    rejectedCountLabel,
    alternatives: ledger.alternatives.map((alternative) => ({
      sourceKey: alternative.sourceKey,
      yieldSource: alternative.yieldSource,
      rejectionLabel: YIELD_DECISION_REJECTION_REASON_LABELS[alternative.rejectionReasonCode],
      apy30dDeltaLabel: formatApy30dDelta(alternative.apy30dDelta) ?? "APY30d delta unavailable",
    })),
  };
}

export function formatYieldDecisionReasonLine(ledger: YieldPublicDecisionLedger | null | undefined): string | null {
  return buildYieldDecisionLedgerDisplay(ledger)?.summary ?? null;
}
