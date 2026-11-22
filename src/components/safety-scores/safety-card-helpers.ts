import { PEG_METADATA } from "@shared/lib/classification";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import type { SafetyScoreTopDriverProps } from "@/components/safety-scores/safety-score-top-driver";
import { humanizeSafetyScoreReason } from "@/lib/safety-score-reason-labels";
import type { V9TableConsumerCard as V9ConsumerCard } from "@/lib/safety-score-v9-consumers";

export type V9SortKey = "overall" | "backing" | "exit" | "control" | "mcap" | "coin";

interface SafetyCardMeta {
  name: string;
  symbol: string;
  pegLabel: string;
}

export function resolveSafetyCardMeta(card: Pick<V9ConsumerCard, "id">): SafetyCardMeta {
  const meta = CLIENT_TRACKED_META_BY_ID.get(card.id);
  const pegCurrency = meta?.flags.pegCurrency;
  const pegLabel = pegCurrency ? (PEG_METADATA[pegCurrency]?.filterLabel ?? pegCurrency) : "—";
  return {
    name: meta?.name ?? card.id,
    symbol: meta?.symbol ?? card.id,
    pegLabel,
  };
}

/**
 * The table projection names a binding cap or a withheld score, but not the
 * peg multiplier, so an uncapped card shows no driver rather than a weakest
 * pillar that may not have set its grade (docs/report-cards.md#consumers).
 */
export function resolveSafetyCardTopDriver(
  card: V9ConsumerCard,
): SafetyScoreTopDriverProps["driver"] {
  if (card.ratingStatus === "not-rated") {
    const rawReason = card.nrReasons[0]?.message;
    return {
      kind: "withheld",
      label: null,
      value: null,
      reason: rawReason ? humanizeSafetyScoreReason(rawReason) : "Required evidence is withheld.",
    };
  }
  if (card.bindingCap !== null) {
    return {
      kind: "cap-bound",
      label: card.bindingCap.kind,
      value: card.bindingCap.limit,
      reason: humanizeSafetyScoreReason(card.bindingCap.reason),
    };
  }
  return null;
}
