import type { LiveReserveEvidenceClass, ReserveDisplayBadgeKind } from "../types/live-reserve-core";
import type { ReserveDisplayBadgeView } from "../types/live-reserves";
import {
  LIVE_RESERVE_ADAPTER_DEFINITIONS,
  inferReserveDisplayBadgeKindFromEvidenceClass as inferBadgeKindFromEvidenceClass,
  type LiveReserveAdapterKey,
} from "./live-reserve-adapter-descriptors";

const RESERVE_DISPLAY_BADGE_LABELS: Record<ReserveDisplayBadgeKind, string> = {
  live: "Live",
  "curated-validated": "Curated-Validated",
  proof: "Proof",
};

export function getReserveDisplayBadgeKindForAdapter(adapterKey: LiveReserveAdapterKey): ReserveDisplayBadgeKind {
  return LIVE_RESERVE_ADAPTER_DEFINITIONS[adapterKey].displayBadgeKind;
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
  return inferBadgeKindFromEvidenceClass(evidenceClass);
}

export function hasReserveDisplayBadgeForAdapter(adapterKey: string): adapterKey is LiveReserveAdapterKey {
  return Object.prototype.hasOwnProperty.call(LIVE_RESERVE_ADAPTER_DEFINITIONS, adapterKey);
}
