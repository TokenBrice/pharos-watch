import { z } from "zod";
import type { DeadStablecoin, StablecoinMeta } from "../../types";
import { LiveReservesConfigSchema } from "../live-reserve-adapters";
import {
  PEG_CURRENCY_VALUES,
} from "../../types/core";
import { CAUSE_OF_DEATH_VALUES } from "../../types/market";
import { ReserveSliceSchema } from "../../types/reserves";
import {
  CoinNoticeSchema,
  ContractDeploymentSchema,
  DateHistoryEntrySchema,
  DependencyWeightSchema,
  FeaturedContentSchema,
  JurisdictionSchema,
  LaunchMilestoneSchema,
  ProofOfReservesSchema,
  StablecoinFlagsSchema,
  StablecoinLinkSchema,
  StablecoinMetaEnumSchemas,
  YieldConfigSchema,
} from "../../types/stablecoin-meta-schemas";

const DETAIL_PROVIDER_VALUES = ["defillama", "coingecko", "commodity"] as const;

const CommodityOuncesSchema = z.number().finite().positive();

function isSlugLikeId(value: string): boolean {
  if (!value) return false;
  if (value.startsWith("-") || value.endsWith("-")) return false;

  let previousWasHyphen = false;
  for (const char of value) {
    const isLowerAlpha = char >= "a" && char <= "z";
    const isDigit = char >= "0" && char <= "9";
    const isHyphen = char === "-";

    if (!isLowerAlpha && !isDigit && !isHyphen) {
      return false;
    }
    if (isHyphen && previousWasHyphen) {
      return false;
    }
    previousWasHyphen = isHyphen;
  }

  return true;
}

const DeadStablecoinIdSchema = z.string().refine(isSlugLikeId, {
  message: "Invalid dead stablecoin id",
});

const StablecoinIdSchema = z.string().refine(isSlugLikeId, {
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

export const StablecoinMetaAssetSchema = z.object({
  id: StablecoinIdSchema,
  llamaId: z.string().optional(),
  detailProvider: z.enum(DETAIL_PROVIDER_VALUES).optional(),
  name: z.string(),
  symbol: z.string(),
  flags: StablecoinFlagsSchema,
  pegReferenceId: z.string().optional(),
  collateral: z.string().optional(),
  pegMechanism: z.string().optional(),
  commodityOunces: CommodityOuncesSchema.optional(),
  geckoId: z.string().optional(),
  cmcSlug: z.string().optional(),
  pythFeedId: z.string().optional(),
  protocolSlug: z.string().optional(),
  proofOfReserves: ProofOfReservesSchema.optional(),
  links: z.array(StablecoinLinkSchema).optional(),
  jurisdiction: JurisdictionSchema.optional(),
  contracts: z.array(ContractDeploymentSchema).optional(),
  tradedContracts: z.array(ContractDeploymentSchema).optional(),
  dependencies: z.array(DependencyWeightSchema).optional(),
  canBeBlacklisted: z.union([z.boolean(), z.literal("possible")]).optional(),
  chainTier: StablecoinMetaEnumSchemas.chainTier.optional(),
  deploymentModel: StablecoinMetaEnumSchemas.deploymentModel.optional(),
  collateralQuality: StablecoinMetaEnumSchemas.collateralQuality.optional(),
  custodyModel: StablecoinMetaEnumSchemas.custodyModel.optional(),
  governanceQuality: StablecoinMetaEnumSchemas.governanceQuality.optional(),
  infrastructures: StablecoinMetaEnumSchemas.infrastructures.optional(),
  variantOf: z.string().optional(),
  variantKind: StablecoinMetaEnumSchemas.variantKind.optional(),
  reserves: z.array(ReserveSliceSchema).optional(),
  liveReservesConfig: LiveReservesConfigSchema.optional(),
  notices: z.array(CoinNoticeSchema).optional(),
  tags: z.array(z.string()).optional(),
  yieldConfig: YieldConfigSchema.optional(),
  status: StablecoinMetaEnumSchemas.status.optional(),
  frozenAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  obituary: obituarySchema.optional(),
  launchDate: z.string().optional(),
  announcedDate: z.string().optional(),
  expectedLaunchDate: z.string().optional(),
  launchPhase: StablecoinMetaEnumSchemas.launchPhase.optional(),
  launchPhaseDetail: z.string().optional(),
  featuredContent: z.array(FeaturedContentSchema).optional(),
  milestones: z.array(LaunchMilestoneSchema).optional(),
  dateHistory: z.array(DateHistoryEntrySchema).optional(),
}).strict().superRefine((meta, ctx) => {
  if ((meta.variantOf == null) === (meta.variantKind == null)) {
    return;
  }

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: "variantOf and variantKind must both be set or both be absent",
    path: ["variantOf"],
  });
}).superRefine((meta, ctx) => {
  if (meta.status === "frozen") {
    if (!meta.frozenAt) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "frozen coins require frozenAt", path: ["frozenAt"] });
    }
    if (!meta.obituary) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "frozen coins require obituary", path: ["obituary"] });
    }
  } else {
    if (meta.frozenAt) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "frozenAt is only allowed when status is frozen", path: ["frozenAt"] });
    }
    if (meta.obituary) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "obituary is only allowed when status is frozen", path: ["obituary"] });
    }
  }
});

export const StablecoinMetaAssetArraySchema = z.array(StablecoinMetaAssetSchema);
export const CanonicalOrderAssetSchema = z.array(StablecoinIdSchema);

export const DeadStablecoinAssetSchema = z.object({
  id: DeadStablecoinIdSchema,
  name: z.string(),
  symbol: z.string(),
  llamaId: z.string().optional(),
  logo: z.string().optional(),
  pegCurrency: z.enum(PEG_CURRENCY_VALUES),
  causeOfDeath: z.enum(CAUSE_OF_DEATH_VALUES),
  deathDate: z.string(),
  peakMcap: z.number().optional(),
  epitaph: z.string().optional(),
  obituary: z.string(),
  sourceUrl: z.string(),
  sourceLabel: z.string(),
  contracts: z.array(z.object({
    chain: z.string(),
    address: z.string(),
  }).strict()).optional(),
}).strict();

export const DeadStablecoinAssetArraySchema = z.array(DeadStablecoinAssetSchema);

function formatSchemaIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

function parseWithSchema<T>(
  schema: z.ZodType<T>,
  input: unknown,
  label: string,
): T {
  const result = schema.safeParse(input);
  if (result.success) {
    return result.data;
  }

  throw new Error(`[stablecoin-assets] Invalid ${label}: ${formatSchemaIssues(result.error)}`);
}

export function parseStablecoinMetaAssets(input: unknown, label: string): StablecoinMeta[] {
  return parseWithSchema(StablecoinMetaAssetArraySchema, input, label) as StablecoinMeta[];
}

export function parseCanonicalOrderAsset(input: unknown, label: string): string[] {
  return parseWithSchema(CanonicalOrderAssetSchema, input, label);
}

export function parseDeadStablecoinAssets(input: unknown, label: string): DeadStablecoin[] {
  return parseWithSchema(DeadStablecoinAssetArraySchema, input, label) as DeadStablecoin[];
}
