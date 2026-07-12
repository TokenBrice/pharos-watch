import { z } from "zod";
import type { DeadStablecoin, StablecoinMeta } from "../../types";
import { LiveReservesConfigSchema } from "../live-reserve-adapters-config";
import { isActiveStablecoinMeta, isReadableStablecoinMeta } from "./status";
import { isCanonicalStablecoinId } from "../stablecoin-id";
import { DetailProviderSchema, PEG_CURRENCY_VALUES } from "../../types/core";
import { CAUSE_OF_DEATH_VALUES } from "../../types/cause-of-death";
import { FullReserveCompositionSchema } from "../../types/reserves";
import {
  CoinNoticeSchema,
  BlacklistabilityReviewSchema,
  BridgeRouteRiskProfileSchema,
  ContractDeploymentSchema,
  DateHistoryEntrySchema,
  DependencyReviewSchema,
  DependencyWeightSchema,
  FeaturedContentSchema,
  FuzzyDateSchema,
  GeniusProfileSchema,
  JurisdictionSchema,
  LaunchMilestoneSchema,
  MintAuthorityProfileSchema,
  MicaProfileSchema,
  OracleRiskProfileSchema,
  ProofOfReservesSchema,
  ReserveReviewSchema,
  StablecoinFlagsSchema,
  StablecoinLinkSchema,
  StablecoinMetaEnumSchemas,
  YieldConfigSchema,
} from "../../types/stablecoin-meta-schemas";

const CommodityOuncesSchema = z.number().finite().positive();

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

const obituarySchema = z.object({
  causeOfDeath: z.enum(CAUSE_OF_DEATH_VALUES),
  // eslint-disable-next-line security/detect-unsafe-regex -- anchored fixed-width date pattern; finite quantifiers, no backtracking risk.
  deathDate: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/),
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
  name: z.string(),
  symbol: z.string(),
  oneLiner: z.string().max(160).optional(),
  flags: StablecoinFlagsSchema,
  pegReferenceId: z.string().optional(),
  collateral: z.string().optional(),
  pegMechanism: z.string().optional(),
  mechanismArchetype: StablecoinMetaEnumSchemas.mechanismArchetype.optional(),
  commodityOunces: CommodityOuncesSchema.optional(),
  geckoId: z.string().optional(),
  cmcSlug: z.string().optional(),
  pythFeedId: z.string().optional(),
  protocolSlug: z.string().optional(),
  proofOfReserves: ProofOfReservesSchema.optional(),
  links: z.array(StablecoinLinkSchema).optional(),
  jurisdiction: JurisdictionSchema.optional(),
  mica: MicaProfileSchema.optional(),
  genius: GeniusProfileSchema.optional(),
  mintAuthority: MintAuthorityProfileSchema.optional(),
  contracts: z.array(ContractDeploymentSchema).optional(),
  tradedContracts: z.array(ContractDeploymentSchema).optional(),
  dependencies: z.array(DependencyWeightSchema).optional(),
  dependencyReview: DependencyReviewSchema.optional(),
  canBeBlacklisted: z.union([z.boolean(), z.literal("possible")]).optional(),
  blacklistabilityReview: BlacklistabilityReviewSchema.optional(),
  chainTier: StablecoinMetaEnumSchemas.chainTier.optional(),
  deploymentModel: StablecoinMetaEnumSchemas.deploymentModel.optional(),
  collateralQuality: StablecoinMetaEnumSchemas.collateralQuality.optional(),
  custodyModel: StablecoinMetaEnumSchemas.custodyModel.optional(),
  governanceQuality: StablecoinMetaEnumSchemas.governanceQuality.optional(),
  oracleRisk: OracleRiskProfileSchema.optional(),
  bridgeRouteRisk: BridgeRouteRiskProfileSchema.optional(),
  infrastructures: StablecoinMetaEnumSchemas.infrastructures.optional(),
  variantOf: z.string().optional(),
  variantKind: StablecoinMetaEnumSchemas.variantKind.optional(),
  archetypeOverride: z
    .boolean()
    .describe("When true, mechanismArchetype is an intentional departure from the parent's archetype.")
    .optional(),
  reserves: FullReserveCompositionSchema.optional(),
  reserveReview: ReserveReviewSchema.optional(),
  liveReservesConfig: LiveReservesConfigSchema.optional(),
  notices: z.array(CoinNoticeSchema).optional(),
  tags: z.array(z.string()).optional(),
  yieldConfig: YieldConfigSchema.optional(),
  status: StablecoinMetaEnumSchemas.status.optional(),
  frozenAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  obituary: obituarySchema.optional(),
  launchDate: FuzzyDateSchema.optional(),
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
export const StablecoinMetaSourceAssetSchema: z.ZodType<StablecoinMeta> = StablecoinMetaAssetRawSchema;

export const STABLECOIN_SOURCE_DOMAIN_VALUES = ["reserves", "mint-authority", "compliance", "risk-review"] as const;
export type StablecoinSourceDomain = (typeof STABLECOIN_SOURCE_DOMAIN_VALUES)[number];

export const StablecoinReservesSidecarSchema = z
  .object({
    id: StablecoinIdSchema,
    reserves: FullReserveCompositionSchema.optional(),
    reserveReview: ReserveReviewSchema.optional(),
  })
  .strict()
  .superRefine((sidecar, ctx) => {
    if (sidecar.reserves != null || sidecar.reserveReview != null) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "reserves sidecars require reserves or reserveReview",
      path: ["reserves"],
    });
  });

export const StablecoinMintAuthoritySidecarSchema = z
  .object({
    id: StablecoinIdSchema,
    mintAuthority: MintAuthorityProfileSchema,
  })
  .strict();

export const StablecoinComplianceSidecarSchema = z
  .object({
    id: StablecoinIdSchema,
    mica: MicaProfileSchema.optional(),
    genius: GeniusProfileSchema.optional(),
  })
  .strict()
  .superRefine((sidecar, ctx) => {
    if (sidecar.mica == null && sidecar.genius == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "compliance sidecars require mica or genius",
        path: ["mica"],
      });
    }
  });

export const StablecoinRiskReviewSidecarSchema = z
  .object({
    id: StablecoinIdSchema,
    canBeBlacklisted: z.union([z.boolean(), z.literal("possible")]).optional(),
    blacklistabilityReview: BlacklistabilityReviewSchema.optional(),
    oracleRisk: OracleRiskProfileSchema.optional(),
    bridgeRouteRisk: BridgeRouteRiskProfileSchema.optional(),
  })
  .strict()
  .superRefine((sidecar, ctx) => {
    if (
      sidecar.canBeBlacklisted === undefined &&
      sidecar.blacklistabilityReview == null &&
      sidecar.oracleRisk == null &&
      sidecar.bridgeRouteRisk == null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "risk-review sidecars require at least one reviewed risk field",
        path: ["blacklistabilityReview"],
      });
    }

    if (sidecar.canBeBlacklisted !== undefined && sidecar.blacklistabilityReview == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "explicit canBeBlacklisted overrides require blacklistabilityReview",
        path: ["blacklistabilityReview"],
      });
    }

    if (
      sidecar.canBeBlacklisted !== undefined &&
      sidecar.blacklistabilityReview?.reviewedStatus !== undefined &&
      sidecar.blacklistabilityReview.reviewedStatus !== sidecar.canBeBlacklisted
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "blacklistabilityReview.reviewedStatus must match canBeBlacklisted",
        path: ["blacklistabilityReview", "reviewedStatus"],
      });
    }
  });

export const STABLECOIN_SOURCE_DOMAIN_FIELDS = {
  reserves: ["reserves", "reserveReview"],
  "mint-authority": ["mintAuthority"],
  compliance: ["mica", "genius"],
  "risk-review": ["canBeBlacklisted", "blacklistabilityReview", "oracleRisk", "bridgeRouteRisk"],
} as const satisfies Record<StablecoinSourceDomain, readonly (keyof StablecoinMeta)[]>;

export const STABLECOIN_SOURCE_DOMAIN_SCHEMAS = {
  reserves: StablecoinReservesSidecarSchema,
  "mint-authority": StablecoinMintAuthoritySidecarSchema,
  compliance: StablecoinComplianceSidecarSchema,
  "risk-review": StablecoinRiskReviewSidecarSchema,
} as const satisfies Record<StablecoinSourceDomain, z.ZodTypeAny>;

const ORACLE_RISK_PROVENANCE_FIELDS = ["reviewedAt", "reviewer", "confidence"] as const;

export const StablecoinMetaAssetSchema: z.ZodType<StablecoinMeta> = StablecoinMetaAssetRawSchema.superRefine(
  (meta, ctx) => {
    for (let index = 0; index < (meta.dependencies ?? []).length; index += 1) {
      if (meta.dependencies?.[index]?.id !== meta.id) continue;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "stablecoin dependencies cannot reference the stablecoin itself",
        path: ["dependencies", index, "id"],
      });
    }
    for (let index = 0; index < (meta.reserves ?? []).length; index += 1) {
      if (meta.reserves?.[index]?.coinId !== meta.id) continue;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "reserve dependencies cannot reference the stablecoin itself",
        path: ["reserves", index, "coinId"],
      });
    }

    const linkedRelationshipKeys = new Set(
      (meta.reserves ?? [])
        .filter((reserve) => reserve.coinId != null)
        .map((reserve) => `${reserve.coinId}::${reserve.depType ?? "collateral"}`),
    );
    const manualDependencies = (meta.dependencies ?? []).filter(
      (dependency) => !linkedRelationshipKeys.has(`${dependency.id}::${dependency.type ?? "collateral"}`),
    );
    if (manualDependencies.length > 0 && meta.dependencyReview == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "manual-only dependencies require dependencyReview provenance",
        path: ["dependencyReview"],
      });
    }
    if (meta.dependencyReview != null) {
      const reviewedKeys = new Set<string>();
      for (let index = 0; index < meta.dependencyReview.relationships.length; index += 1) {
        const relationship = meta.dependencyReview.relationships[index];
        const key = `${relationship.id}::${relationship.type}`;
        if (!isCanonicalStablecoinId(relationship.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "dependencyReview relationship id must be canonical",
            path: ["dependencyReview", "relationships", index, "id"],
          });
        }
        if (reviewedKeys.has(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `duplicate dependencyReview relationship ${key}`,
            path: ["dependencyReview", "relationships", index],
          });
        }
        reviewedKeys.add(key);
      }

      const manualKeys = new Set<string>();
      for (let index = 0; index < manualDependencies.length; index += 1) {
        const dependency = manualDependencies[index];
        if (dependency.type == null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "manual-only dependencies require an explicit type",
            path: ["dependencies", (meta.dependencies ?? []).indexOf(dependency), "type"],
          });
        }
        manualKeys.add(`${dependency.id}::${dependency.type ?? "collateral"}`);
      }
      for (const key of manualKeys) {
        if (reviewedKeys.has(key)) continue;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `dependencyReview is missing manual relationship ${key}`,
          path: ["dependencyReview", "relationships"],
        });
      }
      for (const key of reviewedKeys) {
        if (manualKeys.has(key)) continue;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `dependencyReview relationship ${key} is not manual-only metadata`,
          path: ["dependencyReview", "relationships"],
        });
      }
    }

    if (meta.reserveReview != null && (meta.reserves?.length ?? 0) === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "reserveReview requires a reserve composition",
        path: ["reserveReview"],
      });
    }
    const reviewedReserveIndices = new Set<number>();
    for (let index = 0; index < (meta.reserveReview?.nonLinkDispositions ?? []).length; index += 1) {
      const disposition = meta.reserveReview!.nonLinkDispositions![index];
      const reserve = meta.reserves?.[disposition.reserveIndex];
      if (reviewedReserveIndices.has(disposition.reserveIndex)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate reserve review disposition for index ${disposition.reserveIndex}`,
          path: ["reserveReview", "nonLinkDispositions", index, "reserveIndex"],
        });
      }
      reviewedReserveIndices.add(disposition.reserveIndex);
      if (reserve == null || reserve.name !== disposition.reserveName) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "reserve review disposition must match the current reserve index and name",
          path: ["reserveReview", "nonLinkDispositions", index, "reserveName"],
        });
      } else if (reserve.coinId != null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "non-link dispositions cannot target an already linked reserve slice",
          path: ["reserveReview", "nonLinkDispositions", index],
        });
      }
      for (let candidateIndex = 0; candidateIndex < (disposition.candidateCoinIds ?? []).length; candidateIndex += 1) {
        if (isCanonicalStablecoinId(disposition.candidateCoinIds![candidateIndex])) continue;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "reserve review candidateCoinIds must be canonical",
          path: ["reserveReview", "nonLinkDispositions", index, "candidateCoinIds", candidateIndex],
        });
      }
    }

    if (meta.canBeBlacklisted !== undefined && meta.blacklistabilityReview == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "explicit canBeBlacklisted overrides require blacklistabilityReview",
        path: ["blacklistabilityReview"],
      });
    }

    if (
      meta.canBeBlacklisted !== undefined &&
      meta.blacklistabilityReview?.reviewedStatus !== undefined &&
      meta.blacklistabilityReview.reviewedStatus !== meta.canBeBlacklisted
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "blacklistabilityReview.reviewedStatus must match canBeBlacklisted",
        path: ["blacklistabilityReview", "reviewedStatus"],
      });
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

      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "score-active oracleRisk requires review provenance",
        path: ["oracleRisk", field],
      });
    }
  })
  .superRefine((meta, ctx) => {
    if ((meta.variantOf == null) === (meta.variantKind == null)) {
      return;
    }

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "variantOf and variantKind must both be set or both be absent",
      path: ["variantOf"],
    });
  })
  .superRefine((meta, ctx) => {
    if (meta.variantOf != null && meta.pegReferenceId != null && meta.variantOf !== meta.pegReferenceId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `pegReferenceId (${meta.pegReferenceId}) must equal variantOf (${meta.variantOf}) when both are present`,
        path: ["pegReferenceId"],
      });
    }
  })
  .superRefine((meta, ctx) => {
    if (meta.status === "frozen") {
      if (!meta.frozenAt) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "frozen coins require frozenAt", path: ["frozenAt"] });
      }
      if (!meta.obituary) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "frozen coins require obituary", path: ["obituary"] });
      }
    } else {
      if (meta.frozenAt) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "frozenAt is only allowed when status is frozen",
          path: ["frozenAt"],
        });
      }
      if (meta.obituary) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "obituary is only allowed when status is frozen",
          path: ["obituary"],
        });
      }
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
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "active variants require mintAuthority review so inherited mint risk cannot silently become NR",
        path: [index, "mintAuthority"],
      });
    }
    if (mintAuthority == null) {
      continue;
    }

    const inheritedFrom = mintAuthority.inheritedFrom;
    if (inheritedFrom != null) {
      const parent = catalogById.get(inheritedFrom);
      if ((parent == null && hasCatalogContext) || (parent != null && !isReadableStablecoinMeta(parent))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "mintAuthority.inheritedFrom must reference an active or frozen tracked stablecoin",
          path: [index, "mintAuthority", "inheritedFrom"],
        });
      }
      if (parent != null && isActiveStablecoinMeta(stablecoin) && !isActiveStablecoinMeta(parent)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "active mintAuthority.inheritedFrom must reference an active tracked stablecoin",
          path: [index, "mintAuthority", "inheritedFrom"],
        });
      }
    }

    if (mintAuthority.mintPath !== "wrapped-or-variant-inherited") {
      continue;
    }

    if (inheritedFrom == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "wrapped-or-variant-inherited mintAuthority requires inheritedFrom",
        path: [index, "mintAuthority", "inheritedFrom"],
      });
    }

    if (inheritedFrom != null && stablecoin.variantOf != null && inheritedFrom !== stablecoin.variantOf) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mintAuthority.inheritedFrom must match variantOf when both are present",
        path: [index, "mintAuthority", "inheritedFrom"],
      });
    }

    if (mintAuthority.authorityPosture !== "none-resolved") {
      continue;
    }

    const parentId = inheritedFrom ?? stablecoin.variantOf;
    const parent = parentId != null ? catalogById.get(parentId) : undefined;
    if (parent?.mintAuthority?.authorityPosture !== "none-resolved") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "wrapped mintAuthority can use authorityPosture none-resolved only when the parent is none-resolved",
        path: [index, "mintAuthority", "authorityPosture"],
      });
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
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "mintAuthority inheritance must not form a cycle",
          path: [index, "mintAuthority", "inheritedFrom"],
        });
        break;
      }
      if (depth >= 3) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "mintAuthority inheritance depth must stay within the runtime resolver limit",
          path: [index, "mintAuthority", "inheritedFrom"],
        });
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

export const StablecoinMetaAssetArraySchema: z.ZodType<StablecoinMeta[]> = z
  .array(StablecoinMetaAssetSchema)
  .superRefine(refineMintAuthorityCatalog);
export const CanonicalOrderAssetSchema = z.array(StablecoinIdSchema);

export const DeadStablecoinAssetSchema: z.ZodType<DeadStablecoin> = z
  .object({
    id: DeadStablecoinIdSchema,
    name: z.string(),
    symbol: z.string(),
    llamaId: z.string().optional(),
    geckoId: z.string().optional(),
    aliases: z.array(z.string()).optional(),
    logo: z.string().optional(),
    pegCurrency: z.enum(PEG_CURRENCY_VALUES),
    causeOfDeath: z.enum(CAUSE_OF_DEATH_VALUES),
    deathDate: z.string(),
    peakMcap: z.number().optional(),
    epitaph: z.string().optional(),
    obituary: z.string(),
    sourceUrl: z.string(),
    sourceLabel: z.string(),
    contracts: z
      .array(
        z
          .object({
            chain: z.string(),
            address: z.string(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export const DeadStablecoinAssetArraySchema: z.ZodType<DeadStablecoin[]> = z.array(DeadStablecoinAssetSchema);

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
