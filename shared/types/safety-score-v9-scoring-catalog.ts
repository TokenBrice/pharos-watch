import type { StablecoinMeta } from "./core";

/** Complete nested evidence is retained; only unrelated top-level fields are omitted. */
export const SAFETY_SCORE_V9_SCORING_FIELDS = [
  "id", "status", "variantOf", "variantKind", "wrapperOperator",
  "parentBackingInheritance", "archetypeOverride", "mechanismArchetype",
  "mechanismArchetypeReview", "implementationLaunchDate", "launchDate",
  "reserves", "reserveReview", "custodyProfile", "liveReservesConfig",
  "dependencies", "dependencyReview", "custodyModel", "proofOfReserves",
  "genius", "mintAuthority", "oracleRisk", "bridgeRouteRisk",
  "blacklistabilityReview", "contracts", "detailProvider", "llamaId",
  "tradedContracts", "flags", "pegReferenceId",
] as const satisfies readonly (keyof StablecoinMeta)[];

export type SafetyScoreV9ScoringMeta = Pick<
  StablecoinMeta,
  Exclude<(typeof SAFETY_SCORE_V9_SCORING_FIELDS)[number], "flags">
> & Partial<Pick<StablecoinMeta, "flags">>;

export interface SafetyScoreV9ScoringCatalog {
  schemaVersion: 1;
  /** Identity of the complete source registry, never a hash of projected rows. */
  registryFingerprint: string;
  /** All tracked source rows, including non-active lifecycle states. */
  catalogCount: number;
  activeAssetIds: string[];
  rows: SafetyScoreV9ScoringMeta[];
}
