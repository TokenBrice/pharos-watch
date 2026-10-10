import { z } from "zod";
import type { DeadStablecoin, StablecoinMeta } from "../../types";
import { DeadStablecoinSchema } from "../../types/market";
import { issue, StrictIsoDateSchema } from "../../types/safety-schema-primitives";
import { LiveReservesConfigSchema } from "../live-reserve-adapters";
import { isActiveStablecoinMeta, isReadableStablecoinMeta } from "./status";
import { isCanonicalStablecoinId } from "../stablecoin-id";
import { fuzzyDateRange } from "../classification/resolve-implementation-launch-date";
import { DetailProviderSchema } from "../../types/core";
import { CAUSE_OF_DEATH_VALUES } from "../../types/cause-of-death";
import { FullAuthoredReserveCompositionSchema } from "../../types/reserves";
import { defaultV9DependencyEconomicRole } from "../../types/dependency-types";
import { validateMintBridgeOwnership } from "./mint-bridge-ownership";
import { hasIndependentLiveCompositionDates, hasIndependentReserveObservationDates } from "../report-card-policy";
import { normalizeDeploymentId } from "../../types/deployment-id";
import { resolveV10ReserveObservationDeploymentRefs } from "../safety-score-v9/reserve-scope";
import { findSummaryBudgetViolations } from "../summary-budget";
import { parseCemeteryDeathDate } from "../cemetery";
import {
  CoinNoticeSchema,
  ContractDeploymentSchema,
  CustodyProfileSchema,
  DateHistoryEntrySchema,
  DependencyReviewSchema,
  DependencyWeightSchema,
  FeaturedContentSchema,
  FuzzyDateSchema,
  LaunchMilestoneSchema,
  MechanismArchetypeReviewSchema,
  ParentBackingInheritanceSchema,
  ProofOfReservesSchema,
  ReserveReviewSchema,
  StablecoinFlagsSchema,
  StablecoinLinkSchema,
  StablecoinMetaEnumSchemas,
  YieldConfigSchema,
} from "../../types/stablecoin-meta-schemas";
import {
  BridgeRouteRiskProfileSchema,
  MintAuthorityProfileSchema,
  OracleRiskProfileSchema,
} from "../../types/stablecoin-meta-control-schemas";
import {
  BlacklistabilityReviewSchema,
  GeniusProfileSchema,
  JurisdictionSchema,
  MicaProfileSchema,
} from "../../types/stablecoin-meta-compliance-schemas";
const CommodityOuncesSchema = z.number().finite().positive();
const REVIEW_QUANTITATIVE_TOLERANCE = 1e-6;
const UNRESOLVED_RESERVE_DISPOSITIONS = new Set(["basket-needs-split", "insufficient-evidence"]);

function canonicalDeploymentPart(value: string): string {
  const trimmed = value.trim();
  return /^0x[0-9a-f]+$/i.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

export interface StablecoinCatalogIdEntry {
  id: string;
}

export interface StablecoinCatalogInvariantIssues {
  duplicateStablecoinIds: string[];
  duplicateCanonicalOrderIds: string[];
  missingCanonicalOrderIds: string[];
  unknownCanonicalOrderIds: string[];
}

function uniqueInOrder(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const uniqueValues: string[] = [];

  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    uniqueValues.push(value);
  }

  return uniqueValues;
}

export function findDuplicateStablecoinCatalogIds(entries: readonly StablecoinCatalogIdEntry[]): string[] {
  const seen = new Set<string>();
  const duplicateIds: string[] = [];
  const duplicateSeen = new Set<string>();

  for (const entry of entries) {
    if (seen.has(entry.id)) {
      if (!duplicateSeen.has(entry.id)) {
        duplicateIds.push(entry.id);
        duplicateSeen.add(entry.id);
      }
      continue;
    }

    seen.add(entry.id);
  }

  return duplicateIds;
}

export function findStablecoinCatalogInvariantIssues({
  canonicalOrder,
  stablecoins,
}: {
  canonicalOrder: readonly string[];
  stablecoins: readonly StablecoinCatalogIdEntry[];
}): StablecoinCatalogInvariantIssues {
  const canonicalOrderEntries = canonicalOrder.map((id) => ({ id }));
  const stablecoinIds = stablecoins.map((stablecoin) => stablecoin.id);
  const knownIds = new Set(stablecoinIds);
  const canonicalIds = new Set(canonicalOrder);

  return {
    duplicateStablecoinIds: findDuplicateStablecoinCatalogIds(stablecoins),
    duplicateCanonicalOrderIds: findDuplicateStablecoinCatalogIds(canonicalOrderEntries),
    missingCanonicalOrderIds: uniqueInOrder(stablecoinIds.filter((id) => !canonicalIds.has(id))),
    unknownCanonicalOrderIds: uniqueInOrder(canonicalOrder.filter((id) => !knownIds.has(id))),
  };
}

const DeadStablecoinIdSchema = z.string().refine(isCanonicalStablecoinId, {
  message: "Invalid dead stablecoin id",
});

const StablecoinIdSchema = z.string().refine(isCanonicalStablecoinId, {
  message: "Invalid stablecoin id",
});

const CemeteryAuthoredDeathDateSchema = z.string().refine((value) => {
  const parsed = parseCemeteryDeathDate(value);
  return parsed !== null && parsed.month !== null;
}, { message: "Invalid cemetery death date: expected YYYY-MM or a valid YYYY-MM-DD" });

const obituarySchema = z.object({
  causeOfDeath: z.enum(CAUSE_OF_DEATH_VALUES),
  deathDate: CemeteryAuthoredDeathDateSchema,
  recordedAt: StrictIsoDateSchema.optional(),
  epitaph: z.string().min(1),
  obituary: z.string().min(1),
  peakMcap: z.number().positive().optional(),
  sourceUrl: z.string().url(),
  sourceLabel: z.string().min(1),
});
const StablecoinMetaAssetSchemaShape = {
  id: StablecoinIdSchema,
  llamaId: z.string().optional(),
  detailProvider: DetailProviderSchema.optional(),
  marketAvailability: StablecoinMetaEnumSchemas.marketAvailability.optional(),
  priceBasis: StablecoinMetaEnumSchemas.priceBasis.optional(),
  exitMechanism: StablecoinMetaEnumSchemas.exitMechanism.optional(),
  name: z.string(),
  symbol: z.string(),
  oneLiner: z.string().max(160).optional(),
  flags: StablecoinFlagsSchema,
  pegReferenceId: z.string().optional(),
  collateral: z.string().optional(),
  pegMechanism: z.string().optional(),
  mechanismArchetype: StablecoinMetaEnumSchemas.mechanismArchetype.optional(),
  mechanismArchetypeReview: MechanismArchetypeReviewSchema.optional(),
  implementationLaunchDate: FuzzyDateSchema.optional(),
  commodityOunces: CommodityOuncesSchema.optional(),
  geckoId: z.string().optional(),
  cmcSlug: z.string().optional(),
  protocolSlug: z.string().optional(),
  proofOfReserves: ProofOfReservesSchema.optional(),
  links: z.array(StablecoinLinkSchema).optional(),
  jurisdiction: JurisdictionSchema.optional(),
  mica: MicaProfileSchema.optional(),
  genius: GeniusProfileSchema.optional(),
  mintAuthority: MintAuthorityProfileSchema.optional(),
  // The deployment schema owns token-contract versus native bank-denom identity.
  contracts: z.array(ContractDeploymentSchema).optional(),
  tradedContracts: z.array(ContractDeploymentSchema).optional(),
  dependencies: z.array(DependencyWeightSchema).optional(),
  dependencyReview: DependencyReviewSchema.optional(),
  blacklistabilityReview: BlacklistabilityReviewSchema.optional(),
  collateralQuality: StablecoinMetaEnumSchemas.collateralQuality.optional(),
  custodyModel: StablecoinMetaEnumSchemas.custodyModel.optional(),
  governanceQuality: StablecoinMetaEnumSchemas.governanceQuality.optional(),
  oracleRisk: OracleRiskProfileSchema.optional(),
  bridgeRouteRisk: BridgeRouteRiskProfileSchema.optional(),
  infrastructures: StablecoinMetaEnumSchemas.infrastructures.optional(),
  variantOf: z.string().optional(),
  variantKind: StablecoinMetaEnumSchemas.variantKind.optional(),
  wrapperOperator: StablecoinMetaEnumSchemas.wrapperOperator.optional(),
  parentBackingInheritance: ParentBackingInheritanceSchema.optional(),
  archetypeOverride: z
    .boolean()
    .describe("When true, mechanismArchetype is an intentional departure from the parent's archetype.")
    .optional(),
  reserves: FullAuthoredReserveCompositionSchema.optional(),
  reserveReview: ReserveReviewSchema.optional(),
  custodyProfile: CustodyProfileSchema.optional(),
  liveReservesConfig: LiveReservesConfigSchema.optional(),
  notices: z.array(CoinNoticeSchema).optional(),
  tags: z.array(z.string()).optional(),
  yieldConfig: YieldConfigSchema.optional(),
  status: StablecoinMetaEnumSchemas.status.optional(),
  listingStatusReview: z.object({
    changedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    reason: z.string().trim().min(1).max(280),
    reviewBy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    source: StablecoinLinkSchema.optional(),
  }).strict().optional(),
  windDownAnnouncedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  windDownSourceUrl: z.string().url().optional(),
  frozenAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  obituary: obituarySchema.optional(),
  launchDate: FuzzyDateSchema.optional(),
  pegScoreCoverage: z.object({
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    basis: z.literal("audited-replay-and-live"),
    reviewedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    replayRunId: z.string().trim().min(1).optional(),
    notes: z.string().trim().min(1),
  }).strict().optional(),
  announcedDate: FuzzyDateSchema.optional(),
  expectedLaunchDate: FuzzyDateSchema.optional(),
  launchPhase: StablecoinMetaEnumSchemas.launchPhase.optional(),
  launchPhaseDetail: z.string().optional(),
  featuredContent: z.array(FeaturedContentSchema).optional(),
  milestones: z.array(LaunchMilestoneSchema).optional(),
  dateHistory: z.array(DateHistoryEntrySchema).optional(),
} satisfies Record<keyof StablecoinMeta, z.ZodTypeAny>;

export const STABLECOIN_META_ASSET_FIELD_ORDER = Object.keys(StablecoinMetaAssetSchemaShape) as Array<
  keyof StablecoinMeta
>;

const StablecoinMetaAssetRawSchema = z.object(StablecoinMetaAssetSchemaShape).strict();

/**
 * Strict source-file shape validation before domain sidecars are merged.
 * Cross-field/catalog invariants run on `StablecoinMetaAssetSchema` after merge.
 */
export const StablecoinMetaSourceAssetSchema: z.ZodType<StablecoinMeta, unknown> = StablecoinMetaAssetRawSchema;

type StablecoinSourceDomainField = Exclude<keyof StablecoinMeta, "id">;
type StablecoinSourceDomainFieldSchemas = Partial<Record<StablecoinSourceDomainField, z.ZodTypeAny>>;

function defineStablecoinSourceDomain<const TFieldSchemas extends StablecoinSourceDomainFieldSchemas>(
  fieldSchemas: TFieldSchemas,
  superRefine?: (
    sidecar: z.output<z.ZodObject<{ id: typeof StablecoinIdSchema } & TFieldSchemas>>,
    ctx: z.RefinementCtx,
  ) => void,
) {
  const baseSchema = z.object({ id: StablecoinIdSchema, ...fieldSchemas }).strict();
  return {
    fields: Object.freeze(Object.keys(fieldSchemas)) as readonly (keyof TFieldSchemas & StablecoinSourceDomainField)[],
    schema: superRefine == null ? baseSchema : baseSchema.superRefine(superRefine),
  } as const;
}

const STABLECOIN_SOURCE_DOMAIN_DESCRIPTORS = {
  reserves: defineStablecoinSourceDomain({
    reserves: FullAuthoredReserveCompositionSchema.optional(),
    reserveReview: ReserveReviewSchema.optional(),
    custodyProfile: CustodyProfileSchema.optional(),
  }, (sidecar, ctx) => {
    if (sidecar.reserves != null || sidecar.reserveReview != null || sidecar.custodyProfile != null) return;
    issue(ctx, ["reserves"], "reserves sidecars require reserves, reserveReview, or custodyProfile");
  }),
  "mint-authority": defineStablecoinSourceDomain({
    mintAuthority: MintAuthorityProfileSchema,
  }),
  compliance: defineStablecoinSourceDomain({
    mica: MicaProfileSchema.optional(),
    genius: GeniusProfileSchema.optional(),
  }, (sidecar, ctx) => {
    if (sidecar.mica == null && sidecar.genius == null) {
      issue(ctx, ["mica"], "compliance sidecars require mica or genius");
    }
  }),
  "risk-review": defineStablecoinSourceDomain({
    blacklistabilityReview: BlacklistabilityReviewSchema.optional(),
    oracleRisk: OracleRiskProfileSchema.optional(),
    bridgeRouteRisk: BridgeRouteRiskProfileSchema.optional(),
  }, (sidecar, ctx) => {
    if (
      sidecar.blacklistabilityReview == null &&
      sidecar.oracleRisk == null &&
      sidecar.bridgeRouteRisk == null
    ) {
      issue(ctx, ["blacklistabilityReview"], "risk-review sidecars require at least one reviewed risk field");
    }
  }),
} as const;

export type StablecoinSourceDomain = keyof typeof STABLECOIN_SOURCE_DOMAIN_DESCRIPTORS;

export const STABLECOIN_SOURCE_DOMAIN_VALUES = Object.freeze(
  Object.keys(STABLECOIN_SOURCE_DOMAIN_DESCRIPTORS) as StablecoinSourceDomain[],
);

export const STABLECOIN_SOURCE_DOMAIN_FIELDS = Object.fromEntries(
  STABLECOIN_SOURCE_DOMAIN_VALUES.map((domain) => [domain, STABLECOIN_SOURCE_DOMAIN_DESCRIPTORS[domain].fields]),
) as {
  [TDomain in StablecoinSourceDomain]: (typeof STABLECOIN_SOURCE_DOMAIN_DESCRIPTORS)[TDomain]["fields"];
};

export const STABLECOIN_SOURCE_DOMAIN_SCHEMAS = Object.fromEntries(
  STABLECOIN_SOURCE_DOMAIN_VALUES.map((domain) => [domain, STABLECOIN_SOURCE_DOMAIN_DESCRIPTORS[domain].schema]),
) as {
  [TDomain in StablecoinSourceDomain]: (typeof STABLECOIN_SOURCE_DOMAIN_DESCRIPTORS)[TDomain]["schema"];
};

export const StablecoinMintAuthoritySidecarSchema = STABLECOIN_SOURCE_DOMAIN_SCHEMAS["mint-authority"];
export const StablecoinComplianceSidecarSchema = STABLECOIN_SOURCE_DOMAIN_SCHEMAS.compliance;
export const StablecoinRiskReviewSidecarSchema = STABLECOIN_SOURCE_DOMAIN_SCHEMAS["risk-review"];

const ORACLE_RISK_PROVENANCE_FIELDS = ["reviewedAt", "reviewer", "confidence"] as const;

export const StablecoinMetaAssetSchema: z.ZodType<StablecoinMeta, unknown> = StablecoinMetaAssetRawSchema.superRefine(
  (meta, ctx) => {
    const bridgeRoutes = meta.bridgeRouteRisk?.routes ?? [];
    const contractKeys = new Set(
      (meta.contracts ?? []).map(
        (contract) => `${contract.chain.trim().toLowerCase()}:${canonicalDeploymentPart(contract.address)}`,
      ),
    );
    for (let index = 0; index < bridgeRoutes.length; index += 1) {
      const route = bridgeRoutes[index]!;
      const routeKey = `${route.destinationChain.trim().toLowerCase()}:${canonicalDeploymentPart(route.contractAddress)}`;
      if (contractKeys.has(routeKey)) continue;
      issue(ctx, ["bridgeRouteRisk", "routes", index, "contractAddress"], "bridge route must match an authored contract deployment exactly");
    }
    if (
      isActiveStablecoinMeta(meta) &&
      (meta.contracts?.length ?? 0) > 1 &&
      (meta.bridgeRouteRisk?.routes?.length ?? 0) === 0
    ) {
      issue(ctx, ["bridgeRouteRisk", "routes"], "active multi-deployment stablecoins require reviewed bridge route deployment rows");
    }
    if (meta.mechanismArchetypeReview?.disposition === "resolved" && meta.mechanismArchetype == null) {
      issue(ctx, ["mechanismArchetype"], "resolved mechanismArchetypeReview requires mechanismArchetype");
    }
    if (meta.mechanismArchetypeReview?.disposition === "unresolved" && meta.mechanismArchetype != null) {
      issue(ctx, ["mechanismArchetypeReview", "disposition"], "unresolved mechanismArchetypeReview cannot declare mechanismArchetype");
    }
    if (meta.implementationLaunchDate != null && meta.mechanismArchetypeReview == null) {
      issue(ctx, ["mechanismArchetypeReview"], "implementationLaunchDate requires a sourced mechanismArchetypeReview");
    }
    if (meta.implementationLaunchDate != null) {
      const implementationRange = fuzzyDateRange(meta.implementationLaunchDate);
      const projectRange = meta.launchDate ? fuzzyDateRange(meta.launchDate) : null;
      if (implementationRange && projectRange && implementationRange.end < projectRange.start) {
        issue(ctx, ["implementationLaunchDate"], "implementationLaunchDate cannot unambiguously precede launchDate");
      }
      if (
        implementationRange &&
        meta.mechanismArchetypeReview?.reviewedAt != null &&
        meta.mechanismArchetypeReview.reviewedAt < implementationRange.start
      ) {
        issue(ctx, ["mechanismArchetypeReview", "reviewedAt"], "mechanism review cannot predate the implementation launch period");
      }
    }
    if (meta.archetypeOverride === true && meta.mechanismArchetypeReview?.disposition !== "resolved") {
      issue(ctx, ["mechanismArchetypeReview"], "archetypeOverride requires a resolved mechanismArchetypeReview");
    }
    for (let index = 0; index < (meta.dependencies ?? []).length; index += 1) {
      if (meta.dependencies?.[index]?.id !== meta.id) continue;
      issue(ctx, ["dependencies", index, "id"], "stablecoin dependencies cannot reference the stablecoin itself");
    }
    for (let index = 0; index < (meta.reserves ?? []).length; index += 1) {
      if (meta.reserves?.[index]?.coinId !== meta.id) continue;
      issue(ctx, ["reserves", index, "coinId"], "reserve dependencies cannot reference the stablecoin itself");
    }
    if (
      meta.liveReservesConfig?.adapter === "curated-validated" &&
      (meta.reserves?.length ?? 0) === 0
    ) {
      issue(ctx, ["liveReservesConfig", "adapter"], "curated-validated live reserve configs require a non-empty reserve composition");
    }

    const linkedRelationshipKeys = new Set(
      (meta.reserves ?? [])
        .filter((reserve) => reserve.coinId != null && reserve.pct > 0)
        .map((reserve) => `${reserve.coinId}::${reserve.depType ?? "collateral"}`),
    );
    const reviewedNonDefaultRoleKeys = new Set(
      (meta.dependencyReview?.relationships ?? [])
        .filter((relationship) =>
          relationship.economicRole != null &&
          relationship.economicRole !== defaultV9DependencyEconomicRole(relationship.type),
        )
        .map((relationship) => `${relationship.id}::${relationship.type}`),
    );
    const manualDependencies = (meta.dependencies ?? []).filter(
      (dependency) => {
        const key = `${dependency.id}::${dependency.type ?? "collateral"}`;
        return !linkedRelationshipKeys.has(key) || reviewedNonDefaultRoleKeys.has(key);
      },
    );
    const linkedReserveIds = new Set(
      (meta.reserves ?? []).filter((reserve) => reserve.coinId && reserve.pct > 0).map((reserve) => reserve.coinId),
    );
    if (linkedReserveIds.size > 0) {
      for (let index = 0; index < (meta.dependencies ?? []).length; index += 1) {
        const dependency = meta.dependencies![index]!;
        if ((dependency.type ?? "collateral") !== "collateral" || linkedReserveIds.has(dependency.id)) continue;
        issue(ctx, ["dependencies", index], `manual-collateral-not-in-reserves: ${dependency.id} must be represented by a linked reserve identity`);
      }
    }
    if (manualDependencies.length > 0 && meta.dependencyReview == null) {
      issue(ctx, ["dependencyReview"], "manual-only dependencies require dependencyReview provenance");
    }
    if (meta.dependencyReview != null) {
      const reviewedRelationships = new Map<string, { index: number; weight: number }[]>();
      const reviewedRoleKeys = new Set<string>();
      for (let index = 0; index < meta.dependencyReview.relationships.length; index += 1) {
        const relationship = meta.dependencyReview.relationships[index];
        const key = `${relationship.id}::${relationship.type}`;
        const roleKey = `${key}::${relationship.economicRole ?? defaultV9DependencyEconomicRole(relationship.type)}`;
        if (
          relationship.type === "collateral" &&
          linkedRelationshipKeys.has(key) &&
          (relationship.economicRole ?? defaultV9DependencyEconomicRole(relationship.type)) ===
            defaultV9DependencyEconomicRole(relationship.type)
        ) {
          issue(ctx, ["dependencyReview", "relationships", index], `dependencyReview relationship ${key} is redundant reserve metadata`);
        }
        if (!isCanonicalStablecoinId(relationship.id)) {
          issue(ctx, ["dependencyReview", "relationships", index, "id"], "dependencyReview relationship id must be canonical");
        }
        if (reviewedRoleKeys.has(roleKey)) {
          issue(ctx, ["dependencyReview", "relationships", index], `duplicate dependencyReview relationship role ${roleKey}`);
        }
        reviewedRoleKeys.add(roleKey);
        reviewedRelationships.set(key, [
          ...(reviewedRelationships.get(key) ?? []),
          { index, weight: relationship.weight },
        ]);
      }

      const reviewableDependencies = [
        ...manualDependencies,
        ...(meta.variantOf
          ? [{ id: meta.variantOf, weight: 1, type: "wrapper" as const }]
          : []),
      ];
      const reviewedWeights = new Map<string, number>();
      for (let index = 0; index < reviewableDependencies.length; index += 1) {
        const dependency = reviewableDependencies[index];
        if (dependency.type == null) {
          issue(ctx, ["dependencies", (meta.dependencies ?? []).indexOf(dependency), "type"], "manual-only dependencies require an explicit type");
        }
        const key = `${dependency.id}::${dependency.type ?? "collateral"}`;
        reviewedWeights.set(key, (reviewedWeights.get(key) ?? 0) + dependency.weight);
      }
      for (const [key, authoredWeight] of reviewedWeights) {
        const relationships = reviewedRelationships.get(key);
        if (relationships == null) {
          issue(ctx, ["dependencyReview", "relationships"], `dependencyReview is missing manual relationship ${key}`);
          continue;
        }
        for (const relationship of relationships) {
          if (Math.abs(relationship.weight - authoredWeight) > REVIEW_QUANTITATIVE_TOLERANCE) {
            issue(ctx, ["dependencyReview", "relationships", relationship.index, "weight"], `dependencyReview relationship ${key} weight must match the authored dependency weight`);
          }
        }
      }
      for (const key of reviewedRelationships.keys()) {
        if (reviewedWeights.has(key)) continue;
        issue(ctx, ["dependencyReview", "relationships"], `dependencyReview relationship ${key} is not manual-only metadata`);
      }
    }

    if (meta.reserveReview != null && (meta.reserves?.length ?? 0) === 0) {
      issue(ctx, ["reserveReview"], "reserveReview requires a reserve composition");
    }

    // Curated rows remain tied to the report's period. Adapter-owned rows may
    // retain their own evidenced date without borrowing the report's assurance.
    if (meta.reserveReview?.compositionSource === "live-adapter" && meta.liveReservesConfig == null) {
      issue(ctx, ["reserveReview", "compositionSource"], "live-adapter compositionSource requires liveReservesConfig");
    }
    const latestReportPeriodEnd = meta.proofOfReserves?.latestReport?.periodEnd;
    const compositionAsOf = meta.reserveReview?.compositionAsOf;
    const coverage = meta.proofOfReserves?.latestReport?.coverage;
    const deployedRefs = (meta.contracts ?? []).map(row => normalizeDeploymentId(`${row.chain}:${row.address}`));
    const observationRefs = meta.reserveReview?.observations?.length ? resolveV10ReserveObservationDeploymentRefs(meta) : [];
    for (const [field, refs, allowedRefs] of [
      ["proofOfReserves.latestReport.coverage", coverage?.deploymentRefs ?? [], [...deployedRefs, ...(coverage?.nativeLiabilityRef ? [coverage.nativeLiabilityRef] : [])]],
      ...((meta.reserveReview?.observations ?? []).map(row => ["reserveReview.observations", row.deploymentRefs, observationRefs] as const)),
    ] as const) {
      for (const ref of refs) {
        if (!allowedRefs.includes(ref)) {
          issue(ctx, field.split("."), `Unresolved reserve deployment ${ref}`);
        }
      }
    }
    if (meta.reserveReview?.reportScopeId != null &&
      (coverage?.scopeId !== meta.reserveReview.reportScopeId || coverage.denominator.periodEnd !== compositionAsOf)) {
      issue(ctx, ["reserveReview", "reportScopeId"], "Report-derived composition must link its exact scope and period");
    }
    if (meta.reserveReview?.reportScopeId != null &&
      meta.reserveReview.observations?.some(row => row.kind === "portfolio-observation")) {
      issue(ctx, ["reserveReview"], "Composition cannot be both report-derived and independently observed");
    }
    // liabilityReconciliation retains the report's legacy authored conclusion.
    // Coverage is diagnostic until joined to an admitted captured economic/book
    // partition; catalog deployments may include escrow-backed representations,
    // not additional root liabilities. Runtime admission, not this roster,
    // decides whole-token scope and applies explicit still-owed exclusions.
    if (
      latestReportPeriodEnd != null &&
      compositionAsOf != null &&
      latestReportPeriodEnd !== compositionAsOf &&
      !hasIndependentLiveCompositionDates(meta) &&
      !hasIndependentReserveObservationDates(meta)
    ) {
      issue(ctx, ["reserveReview", "compositionAsOf"], `PoR lockstep: reserveReview.compositionAsOf (${compositionAsOf}) must equal ` +
      `proofOfReserves.latestReport.periodEnd (${latestReportPeriodEnd}) unless compositionSource is ` +
      `"live-adapter", liveReservesConfig is present, and both dates have separate verified composition ` +
      `and known report evidence. Curated-only compositions must describe the report's period.`);
    }
    const reviewedReserveIndices = new Set<number>();
    let unresolvedDispositionPct = 0;
    for (let index = 0; index < (meta.reserveReview?.nonLinkDispositions ?? []).length; index += 1) {
      const disposition = meta.reserveReview!.nonLinkDispositions![index];
      const reserve = meta.reserves?.[disposition.reserveIndex];
      if (reviewedReserveIndices.has(disposition.reserveIndex)) {
        issue(ctx, ["reserveReview", "nonLinkDispositions", index, "reserveIndex"], `duplicate reserve review disposition for index ${disposition.reserveIndex}`);
      }
      reviewedReserveIndices.add(disposition.reserveIndex);
      if (reserve == null || reserve.name !== disposition.reserveName) {
        issue(ctx, ["reserveReview", "nonLinkDispositions", index, "reserveName"], "reserve review disposition must match the current reserve index and name");
      } else if (reserve.coinId != null) {
        issue(ctx, ["reserveReview", "nonLinkDispositions", index], "non-link dispositions cannot target an already linked reserve slice");
      } else if (Math.abs(reserve.pct - disposition.pct) > REVIEW_QUANTITATIVE_TOLERANCE) {
        issue(ctx, ["reserveReview", "nonLinkDispositions", index, "pct"], "reserve review disposition pct must match the current reserve slice");
      }
      if (UNRESOLVED_RESERVE_DISPOSITIONS.has(disposition.disposition)) {
        unresolvedDispositionPct += disposition.pct;
      }
      for (let candidateIndex = 0; candidateIndex < (disposition.candidateCoinIds ?? []).length; candidateIndex += 1) {
        if (isCanonicalStablecoinId(disposition.candidateCoinIds![candidateIndex])) continue;
        issue(ctx, ["reserveReview", "nonLinkDispositions", index, "candidateCoinIds", candidateIndex], "reserve review candidateCoinIds must be canonical");
      }
    }
    if (
      meta.reserveReview != null &&
      Math.abs(meta.reserveReview.knownUnknownExposurePct - unresolvedDispositionPct) > REVIEW_QUANTITATIVE_TOLERANCE
    ) {
      issue(ctx, ["reserveReview", "knownUnknownExposurePct"], "reserveReview knownUnknownExposurePct must equal the total pct of unresolved dispositions");
    }

  },
)
  .superRefine((meta, ctx) => {
    if (
      !meta.oracleRisk ||
      meta.variantOf ||
      meta.flags.backing !== "crypto-backed" ||
      meta.mechanismArchetype !== "cdp"
    ) {
      return;
    }

    for (const field of ORACLE_RISK_PROVENANCE_FIELDS) {
      if (meta.oracleRisk[field]) {
        continue;
      }

      issue(ctx, ["oracleRisk", field], "score-active oracleRisk requires review provenance");
    }
  })
  .superRefine((meta, ctx) => {
    if ((meta.variantOf == null) === (meta.variantKind == null)) {
      return;
    }

    issue(ctx, ["variantOf"], "variantOf and variantKind must both be set or both be absent");
  })
  .superRefine((meta, ctx) => {
    if (meta.variantKind === "risk-absorption" && meta.wrapperOperator == null) {
      issue(ctx, ["wrapperOperator"], "risk-absorption variants require wrapperOperator");
    } else if (meta.variantKind !== "risk-absorption" && meta.wrapperOperator != null) {
      issue(ctx, ["wrapperOperator"], "wrapperOperator is only valid for risk-absorption variants");
    }
  })
  .superRefine((meta, ctx) => {
    if (meta.pegReferenceId != null && meta.variantOf == null) {
      issue(ctx, ["variantOf"], "pegReferenceId requires variantOf");
    }
  })
  .superRefine((meta, ctx) => {
    if (meta.variantOf != null && meta.pegReferenceId != null && meta.variantOf !== meta.pegReferenceId) {
      issue(ctx, ["pegReferenceId"], `pegReferenceId (${meta.pegReferenceId}) must equal variantOf (${meta.variantOf}) when both are present`);
    }
  })
  .superRefine((meta, ctx) => {
    const listingStatus = meta.status === "quarantined" || meta.status === "delisted";
    if (listingStatus && !meta.listingStatusReview) {
      issue(ctx, ["listingStatusReview"], `${meta.status} coins require listingStatusReview`);
    } else if (!listingStatus && meta.listingStatusReview) {
      issue(ctx, ["listingStatusReview"], "listingStatusReview is only allowed when status is quarantined or delisted");
    }
    if (meta.status === "quarantined" && !meta.listingStatusReview?.reviewBy) {
      issue(ctx, ["listingStatusReview", "reviewBy"], "quarantined coins require listingStatusReview.reviewBy");
    }
    if (meta.status === "delisted" && !meta.listingStatusReview?.source) {
      issue(ctx, ["listingStatusReview", "source"], "delisted coins require listingStatusReview.source");
    }
  })
  .superRefine((meta, ctx) => {
    if (meta.status === "frozen") {
      if (!meta.frozenAt) {
        issue(ctx, ["frozenAt"], "frozen coins require frozenAt");
      }
      if (!meta.obituary) {
        issue(ctx, ["obituary"], "frozen coins require obituary");
      }
    } else {
      if (meta.frozenAt) {
        issue(ctx, ["frozenAt"], "frozenAt is only allowed when status is frozen");
      }
      if (meta.obituary) {
        issue(ctx, ["obituary"], "obituary is only allowed when status is frozen");
      }
    }
  })
  .superRefine((meta, ctx) => {
    for (const violation of validateMintBridgeOwnership(meta, { enforce: true })) {
      if (violation.severity !== "error") continue;
      const path = violation.path
        .split(/[.\[\]]/)
        .filter(Boolean)
        .map((segment) => (/^\d+$/.test(segment) ? Number(segment) : segment));
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `[mint-bridge-ownership:${violation.code}] ${violation.message}`,
        path,
      });
    }
  })
  .superRefine((meta, ctx) => {
    // The authored mint headline renders as the detail card's summary-layer
    // verdict, so it carries the same budget as the generated one.
    const headline = meta.mintAuthority?.headline;
    if (headline == null) return;
    for (const violation of findSummaryBudgetViolations(headline)) {
      issue(ctx, ["mintAuthority", "headline"], violation.kind === "word-count"
        ? `mintAuthority.headline has ${violation.words} words; the summary-layer verdict budget is ${violation.max}`
        : `mintAuthority.headline contains a raw identifier (${violation.id}: "${violation.match}"); keep identifiers in the review notes`);
    }
  });

function refineMintAuthorityCatalog(stablecoins: StablecoinMeta[], ctx: z.RefinementCtx): void {
  const catalogById = new Map(stablecoins.map((stablecoin) => [stablecoin.id, stablecoin]));
  const catalogIndexById = new Map(stablecoins.map((stablecoin, index) => [stablecoin.id, index]));
  const hasCatalogContext = stablecoins.length > 1;

  for (let index = 0; index < stablecoins.length; index += 1) {
    const stablecoin = stablecoins[index]!;
    const mintAuthority = stablecoin.mintAuthority;
    if (mintAuthority == null && isActiveStablecoinMeta(stablecoin) && stablecoin.variantOf != null) {
      issue(ctx, [index, "mintAuthority"], "active variants require mintAuthority review so inherited mint risk cannot silently become NR");
    }
    if (mintAuthority == null) {
      continue;
    }

    const inheritedFrom = mintAuthority.inheritedFrom;
    if (inheritedFrom != null) {
      const parent = catalogById.get(inheritedFrom);
      if ((parent == null && hasCatalogContext) || (parent != null && !isReadableStablecoinMeta(parent))) {
        issue(ctx, [index, "mintAuthority", "inheritedFrom"], "mintAuthority.inheritedFrom must reference a readable post-launch tracked stablecoin");
      }
      if (parent != null && isActiveStablecoinMeta(stablecoin) && !isActiveStablecoinMeta(parent)) {
        issue(ctx, [index, "mintAuthority", "inheritedFrom"], "active mintAuthority.inheritedFrom must reference an active tracked stablecoin");
      }
    }

    if (mintAuthority.mintPath !== "wrapped-or-variant-inherited") {
      continue;
    }

    if (inheritedFrom == null) {
      issue(ctx, [index, "mintAuthority", "inheritedFrom"], "wrapped-or-variant-inherited mintAuthority requires inheritedFrom");
    }

    if (inheritedFrom != null && stablecoin.variantOf != null && inheritedFrom !== stablecoin.variantOf) {
      issue(ctx, [index, "mintAuthority", "inheritedFrom"], "mintAuthority.inheritedFrom must match variantOf when both are present");
    }

    // Whole-of-chain only. `none-resolved-mint` is deliberately exempt: it
    // claims nothing about the parent, which is the reason a share wrapper over
    // a governed parent can carry it at all.
    if (mintAuthority.authorityPosture !== "none-resolved") {
      continue;
    }

    const parentId = inheritedFrom ?? stablecoin.variantOf;
    const parent = parentId != null ? catalogById.get(parentId) : undefined;
    if (hasCatalogContext && parent?.mintAuthority?.authorityPosture !== "none-resolved") {
      issue(ctx, [index, "mintAuthority", "authorityPosture"], "wrapped mintAuthority can use authorityPosture none-resolved only when the parent is none-resolved");
    }
  }

  for (let index = 0; index < stablecoins.length; index += 1) {
    const stablecoin = stablecoins[index]!;
    if (stablecoin.mintAuthority?.mintPath !== "wrapped-or-variant-inherited") {
      continue;
    }

    const seen = new Set<string>();
    let current: StablecoinMeta | undefined = stablecoin;
    let depth = 0;
    while (current?.mintAuthority?.mintPath === "wrapped-or-variant-inherited") {
      if (seen.has(current.id)) {
        issue(ctx, [index, "mintAuthority", "inheritedFrom"], "mintAuthority inheritance must not form a cycle");
        break;
      }
      if (depth >= 3) {
        issue(ctx, [index, "mintAuthority", "inheritedFrom"], "mintAuthority inheritance depth must stay within the runtime resolver limit");
        break;
      }

      seen.add(current.id);
      const parentId = current.mintAuthority.inheritedFrom;
      if (parentId == null) {
        break;
      }
      const parentIndex = catalogIndexById.get(parentId);
      current = parentIndex != null ? stablecoins[parentIndex] : undefined;
      depth += 1;
    }
  }
}

export const StablecoinMetaAssetArraySchema: z.ZodType<StablecoinMeta[], unknown> = z
  .array(StablecoinMetaAssetSchema)
  .superRefine(refineMintAuthorityCatalog);

/**
 * Catalog-level invariants only. Use when every record has already been parsed
 * through `StablecoinMetaAssetSchema`, so the cross-record checks run without a
 * second per-record pass.
 */
export const StablecoinMetaCatalogInvariantsSchema: z.ZodType<StablecoinMeta[], unknown> = z
  .array(z.custom<StablecoinMeta>())
  .superRefine(refineMintAuthorityCatalog);
export const CanonicalOrderAssetSchema = z.array(StablecoinIdSchema);

const DeadStablecoinAssetSchema: z.ZodType<DeadStablecoin> = DeadStablecoinSchema.extend({
  id: DeadStablecoinIdSchema,
  deathDate: CemeteryAuthoredDeathDateSchema,
  recordedAt: StrictIsoDateSchema,
});

const DeadStablecoinAssetArraySchema: z.ZodType<DeadStablecoin[]> = z.array(DeadStablecoinAssetSchema);

function formatSchemaIssues(error: z.ZodError): string {
  const issues = error.issues;
  const shown = issues
    .slice(0, 8)
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
  return issues.length > 8 ? `${shown} … (+${issues.length - 8} more)` : shown;
}

function parseWithSchema<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const result = schema.safeParse(input);
  if (result.success) {
    return result.data;
  }

  throw new Error(`[stablecoin-assets] Invalid ${label}: ${formatSchemaIssues(result.error)}`);
}

export function parseStablecoinMetaAssets(input: unknown, label: string): StablecoinMeta[] {
  return parseWithSchema(StablecoinMetaAssetArraySchema, input, label);
}

export function parseCanonicalOrderAsset(input: unknown, label: string): string[] {
  return parseWithSchema(CanonicalOrderAssetSchema, input, label);
}

export function parseDeadStablecoinAssets(input: unknown, label: string): DeadStablecoin[] {
  return parseWithSchema(DeadStablecoinAssetArraySchema, input, label);
}
