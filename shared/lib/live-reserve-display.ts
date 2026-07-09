import type { LiveReserveEvidenceClass, ReserveDisplayBadgeKind } from "../types/live-reserve-core";
import type { ReserveDisplayBadgeView } from "../types/live-reserves";
import { LIVE_RESERVE_ADAPTER_DESCRIPTORS, type LiveReserveAdapterKey } from "./live-reserve-adapter-descriptors";

const RESERVE_DISPLAY_BADGE_LABELS: Record<ReserveDisplayBadgeKind, string> = {
  live: "Live",
  "curated-validated": "Curated-Validated",
  proof: "Proof",
};

export function getReserveDisplayBadgeKindForAdapter(adapterKey: LiveReserveAdapterKey): ReserveDisplayBadgeKind {
  return LIVE_RESERVE_ADAPTER_DESCRIPTORS[adapterKey].displayBadgeKind;
}

function getReserveDisplayBadgeLabel(kind: ReserveDisplayBadgeKind): string {
  return RESERVE_DISPLAY_BADGE_LABELS[kind];
}

export function buildReserveDisplayBadge(kind: ReserveDisplayBadgeKind): ReserveDisplayBadgeView {
  return {
    kind,
    label: getReserveDisplayBadgeLabel(kind),
  };
}

export function inferReserveDisplayBadgeKindFromEvidenceClass(
  evidenceClass: LiveReserveEvidenceClass,
): ReserveDisplayBadgeKind {
  switch (evidenceClass) {
    case "independent":
      return "live";
    case "static-validated":
      return "curated-validated";
    case "weak-live-probe":
      return "proof";
    default:
      return "live";
  }
}

export function hasReserveDisplayBadgeForAdapter(adapterKey: string): adapterKey is LiveReserveAdapterKey {
  return Object.prototype.hasOwnProperty.call(LIVE_RESERVE_ADAPTER_DESCRIPTORS, adapterKey);
}
