import {
  buildReserveDisplayBadge,
  getReserveDisplayBadgeKindForAdapter,
  hasReserveDisplayBadgeForAdapter,
  inferReserveDisplayBadgeKindFromEvidenceClass,
} from "@shared/lib/live-reserve-display";
import type {
  ReserveDisplayBadgeView,
  ReserveProvenanceView,
} from "@shared/types/live-reserves";
import type { ReserveCompositionRecord, ReserveSyncStateRecord } from "./live-reserves-store-shared";
import { hasScoringEligibleLiveReserveFreshness } from "./live-reserves-store-legacy";

export function buildReserveProvenanceView(
  record: Pick<ReserveCompositionRecord, "adapterEvidenceClass" | "adapterSourceModel" | "metadata">,
  syncState: ReserveSyncStateRecord | null,
  stale: boolean,
): ReserveProvenanceView {
  const freshnessMode = record.metadata.freshnessMode;
  return {
    evidenceClass: record.adapterEvidenceClass,
    sourceModel: record.adapterSourceModel,
    ...(freshnessMode ? { freshnessMode } : {}),
    scoringEligible: record.adapterEvidenceClass === "independent"
      && !stale
      && syncState?.lastStatus === "ok"
      && hasScoringEligibleLiveReserveFreshness(record.metadata),
  };
}

export function buildReserveDisplayBadgeView(
  record: Pick<ReserveCompositionRecord, "source" | "adapterEvidenceClass">,
): ReserveDisplayBadgeView {
  const kind = hasReserveDisplayBadgeForAdapter(record.source)
    ? getReserveDisplayBadgeKindForAdapter(record.source)
    : inferReserveDisplayBadgeKindFromEvidenceClass(record.adapterEvidenceClass);
  return buildReserveDisplayBadge(kind);
}
