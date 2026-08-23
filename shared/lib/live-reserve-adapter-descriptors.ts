import type { LiveReserveEvidenceClass, ReserveDisplayBadgeKind } from "../types/live-reserve-core";
import type { ReserveEvidenceSourceOriginClass } from "../types/report-card-evidence-journal";
import {
  LIVE_RESERVE_ADAPTER_DESCRIPTOR_DECLARATIONS,
  LIVE_RESERVE_ADAPTER_KEYS,
  type LiveReserveAdapterKey,
  type LiveReserveAdapterProvenance,
} from "../types/live-reserve-adapter-declarations";
import { LIVE_RESERVE_PARAM_SCHEMAS } from "./live-reserve-adapter-param-schemas";

export { LIVE_RESERVE_ADAPTER_STATUS_VALUES } from "../types/live-reserve-adapter-declarations";
export type {
  LiveReserveAdapterKey,
  LiveReserveAdapterProvenance,
  LiveReserveAdapterStatus,
} from "../types/live-reserve-adapter-declarations";

const ACTIVE_PROVENANCE = {
  status: "active",
  rationale: "Bound by at least one active stablecoin liveReservesConfig.",
} as const satisfies LiveReserveAdapterProvenance;

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
      throw new Error(`Unsupported live-reserve evidence class: ${String(evidenceClass)}`);
  }
}

type LiveReserveAdapterDeclarationMap = typeof LIVE_RESERVE_ADAPTER_DESCRIPTOR_DECLARATIONS;

export type LiveReserveAdapterDescriptorMap = {
  [K in LiveReserveAdapterKey]: LiveReserveAdapterDeclarationMap[K] & {
    key: K;
    params: (typeof LIVE_RESERVE_PARAM_SCHEMAS)[LiveReserveAdapterDeclarationMap[K]["paramsSchema"]];
    sourceOriginClass: ReserveEvidenceSourceOriginClass;
    displayBadgeKind: ReserveDisplayBadgeKind;
    provenance: LiveReserveAdapterProvenance;
  };
};

export const LIVE_RESERVE_ADAPTER_DESCRIPTORS = Object.fromEntries(
  Object.entries(LIVE_RESERVE_ADAPTER_DESCRIPTOR_DECLARATIONS).map(([key, declaration]) => {
    const provenance = "provenance" in declaration ? declaration.provenance : ACTIVE_PROVENANCE;
    const sourceOriginClass =
      "sourceOriginClass" in declaration ? declaration.sourceOriginClass : "unknown";
    const displayBadgeKind =
      "displayBadgeKind" in declaration
        ? declaration.displayBadgeKind
        : inferReserveDisplayBadgeKindFromEvidenceClass(declaration.evidenceClass);
    return [
      key,
      {
        ...declaration,
        key,
        params: LIVE_RESERVE_PARAM_SCHEMAS[declaration.paramsSchema],
        sourceOriginClass,
        provenance,
        displayBadgeKind,
      },
    ];
  }),
) as LiveReserveAdapterDescriptorMap;

export const LIVE_RESERVE_ADAPTER_DEFINITIONS = LIVE_RESERVE_ADAPTER_DESCRIPTORS;

export const LIVE_RESERVE_ADAPTER_PRIMARY_INPUT_KINDS = Object.fromEntries(
  LIVE_RESERVE_ADAPTER_KEYS.map((key) => [key, LIVE_RESERVE_ADAPTER_DESCRIPTORS[key].primaryInputKinds]),
) as {
  [K in LiveReserveAdapterKey]: LiveReserveAdapterDeclarationMap[K]["primaryInputKinds"];
};

export const adapterParamsSchemas = Object.fromEntries(
  LIVE_RESERVE_ADAPTER_KEYS.map((key) => [key, LIVE_RESERVE_ADAPTER_DESCRIPTORS[key].params]),
) as {
  [K in LiveReserveAdapterKey]: LiveReserveAdapterDescriptorMap[K]["params"];
};
