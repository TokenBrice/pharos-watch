import type {
  RedemptionCapacityConfidence,
  RedemptionCapacitySemantics,
  RedemptionSourceMode,
} from "../types";

export const REDEMPTION_BACKSTOP_PROVIDER_IDS = {
  SUPPLY_FULL_MODEL: "supply-full-model",
  SUPPLY_RATIO_MODEL: "supply-ratio-model",
  RESERVE_SYNC_METADATA: "reserve-sync-metadata",
  RESERVE_SYNC_FALLBACK: "reserve-sync-fallback",
  SYNC_ERROR: "sync-error",
} as const;

export type RedemptionBackstopProviderId =
  (typeof REDEMPTION_BACKSTOP_PROVIDER_IDS)[keyof typeof REDEMPTION_BACKSTOP_PROVIDER_IDS];

export type RedemptionBackstopProviderCapability =
  | "capacity-source"
  | "failure-sentinel";

export type RedemptionBackstopProviderCapacitySource =
  | "supply-full"
  | "supply-ratio"
  | "live-reserve-metadata"
  | "configured-fallback-ratio"
  | "none";

export type RedemptionBackstopProviderProvenanceClass =
  | "static-supply-model"
  | "live-reserve-adapter"
  | "reviewed-config-fallback"
  | "runtime-error";

export type RedemptionBackstopProviderSevereDepegScoreability =
  | "not-scoreable"
  | "requires-strong-live-direct-route";

export interface RedemptionBackstopProviderDefinition {
  id: RedemptionBackstopProviderId;
  capability: RedemptionBackstopProviderCapability;
  capacitySource: RedemptionBackstopProviderCapacitySource;
  defaultSourceMode: RedemptionSourceMode;
  provenanceClass: RedemptionBackstopProviderProvenanceClass;
  defaultCapacityConfidence: RedemptionCapacityConfidence;
  defaultCapacitySemantics: RedemptionCapacitySemantics;
  severeDepegScoreability: RedemptionBackstopProviderSevereDepegScoreability;
  readbackCapacityConfidenceBySourceMode?: Partial<
    Record<RedemptionSourceMode, RedemptionCapacityConfidence>
  >;
}

export const REDEMPTION_BACKSTOP_PROVIDER_DEFINITIONS: Record<
  RedemptionBackstopProviderId,
  RedemptionBackstopProviderDefinition
> = {
  [REDEMPTION_BACKSTOP_PROVIDER_IDS.SUPPLY_FULL_MODEL]: {
    id: REDEMPTION_BACKSTOP_PROVIDER_IDS.SUPPLY_FULL_MODEL,
    capability: "capacity-source",
    capacitySource: "supply-full",
    defaultSourceMode: "estimated",
    provenanceClass: "static-supply-model",
    defaultCapacityConfidence: "heuristic",
    defaultCapacitySemantics: "eventual-only",
    severeDepegScoreability: "not-scoreable",
  },
  [REDEMPTION_BACKSTOP_PROVIDER_IDS.SUPPLY_RATIO_MODEL]: {
    id: REDEMPTION_BACKSTOP_PROVIDER_IDS.SUPPLY_RATIO_MODEL,
    capability: "capacity-source",
    capacitySource: "supply-ratio",
    defaultSourceMode: "estimated",
    provenanceClass: "static-supply-model",
    defaultCapacityConfidence: "heuristic",
    defaultCapacitySemantics: "immediate-bounded",
    severeDepegScoreability: "not-scoreable",
  },
  [REDEMPTION_BACKSTOP_PROVIDER_IDS.RESERVE_SYNC_METADATA]: {
    id: REDEMPTION_BACKSTOP_PROVIDER_IDS.RESERVE_SYNC_METADATA,
    capability: "capacity-source",
    capacitySource: "live-reserve-metadata",
    defaultSourceMode: "dynamic",
    provenanceClass: "live-reserve-adapter",
    defaultCapacityConfidence: "dynamic",
    defaultCapacitySemantics: "immediate-bounded",
    severeDepegScoreability: "requires-strong-live-direct-route",
    readbackCapacityConfidenceBySourceMode: {
      dynamic: "dynamic",
      estimated: "heuristic",
      static: "heuristic",
    },
  },
  [REDEMPTION_BACKSTOP_PROVIDER_IDS.RESERVE_SYNC_FALLBACK]: {
    id: REDEMPTION_BACKSTOP_PROVIDER_IDS.RESERVE_SYNC_FALLBACK,
    capability: "capacity-source",
    capacitySource: "configured-fallback-ratio",
    defaultSourceMode: "estimated",
    provenanceClass: "reviewed-config-fallback",
    defaultCapacityConfidence: "heuristic",
    defaultCapacitySemantics: "immediate-bounded",
    severeDepegScoreability: "not-scoreable",
  },
  [REDEMPTION_BACKSTOP_PROVIDER_IDS.SYNC_ERROR]: {
    id: REDEMPTION_BACKSTOP_PROVIDER_IDS.SYNC_ERROR,
    capability: "failure-sentinel",
    capacitySource: "none",
    defaultSourceMode: "static",
    provenanceClass: "runtime-error",
    defaultCapacityConfidence: "heuristic",
    defaultCapacitySemantics: "immediate-bounded",
    severeDepegScoreability: "not-scoreable",
  },
};

export type RedemptionCapacityModelProviderKind =
  | "supply-full"
  | "supply-ratio"
  | "reserve-sync-metadata";

export function getRedemptionBackstopProviderDefinition(
  provider: string,
): RedemptionBackstopProviderDefinition | null {
  if (Object.prototype.hasOwnProperty.call(REDEMPTION_BACKSTOP_PROVIDER_DEFINITIONS, provider)) {
    return REDEMPTION_BACKSTOP_PROVIDER_DEFINITIONS[provider as RedemptionBackstopProviderId];
  }
  return null;
}

export function getProviderIdForCapacityModelKind(
  kind: RedemptionCapacityModelProviderKind,
): RedemptionBackstopProviderId {
  switch (kind) {
    case "supply-full":
      return REDEMPTION_BACKSTOP_PROVIDER_IDS.SUPPLY_FULL_MODEL;
    case "supply-ratio":
      return REDEMPTION_BACKSTOP_PROVIDER_IDS.SUPPLY_RATIO_MODEL;
    case "reserve-sync-metadata":
      return REDEMPTION_BACKSTOP_PROVIDER_IDS.RESERVE_SYNC_METADATA;
  }
}

export function inferProviderCapacityConfidence(args: {
  provider: string;
  sourceMode: RedemptionSourceMode;
}): RedemptionCapacityConfidence {
  const definition = getRedemptionBackstopProviderDefinition(args.provider);
  if (!definition) return "heuristic";
  return (
    definition.readbackCapacityConfidenceBySourceMode?.[args.sourceMode] ??
    definition.defaultCapacityConfidence
  );
}

export function inferProviderCapacitySemantics(args: {
  provider: string;
}): RedemptionCapacitySemantics {
  return (
    getRedemptionBackstopProviderDefinition(args.provider)?.defaultCapacitySemantics ??
    "immediate-bounded"
  );
}
