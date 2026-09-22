import type {
  RedemptionCapacityConfidence,
  RedemptionCapacitySemantics,
  RedemptionSourceMode,
} from "../types";

export const REDEMPTION_BACKSTOP_PROVIDER_IDS = {
  SUPPLY_FULL_MODEL: "supply-full-model",
  SUPPLY_RATIO_MODEL: "supply-ratio-model",
  FIXED_USD_MODEL: "fixed-usd-model",
  RESERVE_SYNC_METADATA: "reserve-sync-metadata",
  RESERVE_SYNC_FALLBACK: "reserve-sync-fallback",
  SYNC_ERROR: "sync-error",
} as const;

export type RedemptionBackstopProviderId =
  (typeof REDEMPTION_BACKSTOP_PROVIDER_IDS)[keyof typeof REDEMPTION_BACKSTOP_PROVIDER_IDS];


export interface RedemptionBackstopProviderDefinition {
  id: RedemptionBackstopProviderId;
  defaultSourceMode: RedemptionSourceMode;
  defaultCapacityConfidence: RedemptionCapacityConfidence;
  defaultCapacitySemantics: RedemptionCapacitySemantics;
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
    defaultSourceMode: "estimated",
    defaultCapacityConfidence: "heuristic",
    defaultCapacitySemantics: "eventual-only",
  },
  [REDEMPTION_BACKSTOP_PROVIDER_IDS.SUPPLY_RATIO_MODEL]: {
    id: REDEMPTION_BACKSTOP_PROVIDER_IDS.SUPPLY_RATIO_MODEL,
    defaultSourceMode: "estimated",
    defaultCapacityConfidence: "heuristic",
    defaultCapacitySemantics: "immediate-bounded",
  },
  [REDEMPTION_BACKSTOP_PROVIDER_IDS.FIXED_USD_MODEL]: {
    id: REDEMPTION_BACKSTOP_PROVIDER_IDS.FIXED_USD_MODEL,
    defaultSourceMode: "static",
    defaultCapacityConfidence: "documented-bound",
    defaultCapacitySemantics: "immediate-bounded",
  },
  [REDEMPTION_BACKSTOP_PROVIDER_IDS.RESERVE_SYNC_METADATA]: {
    id: REDEMPTION_BACKSTOP_PROVIDER_IDS.RESERVE_SYNC_METADATA,
    defaultSourceMode: "dynamic",
    defaultCapacityConfidence: "dynamic",
    defaultCapacitySemantics: "immediate-bounded",
    readbackCapacityConfidenceBySourceMode: {
      dynamic: "dynamic",
      estimated: "heuristic",
      static: "heuristic",
    },
  },
  [REDEMPTION_BACKSTOP_PROVIDER_IDS.RESERVE_SYNC_FALLBACK]: {
    id: REDEMPTION_BACKSTOP_PROVIDER_IDS.RESERVE_SYNC_FALLBACK,
    defaultSourceMode: "estimated",
    defaultCapacityConfidence: "heuristic",
    defaultCapacitySemantics: "immediate-bounded",
  },
  [REDEMPTION_BACKSTOP_PROVIDER_IDS.SYNC_ERROR]: {
    id: REDEMPTION_BACKSTOP_PROVIDER_IDS.SYNC_ERROR,
    defaultSourceMode: "static",
    defaultCapacityConfidence: "heuristic",
    defaultCapacitySemantics: "immediate-bounded",
  },
};

export type RedemptionCapacityModelProviderKind =
  | "supply-full"
  | "supply-ratio"
  | "fixed-usd"
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
    case "fixed-usd":
      return REDEMPTION_BACKSTOP_PROVIDER_IDS.FIXED_USD_MODEL;
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
    "eventual-only"
  );
}
