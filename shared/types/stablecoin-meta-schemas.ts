import { z } from "zod";
import type {
  CoinNotice,
  ContractDeployment,
  DateHistoryEntry,
  DependencyWeight,
  FeaturedContent,
  Jurisdiction,
  LaunchMilestone,
  ProofOfReserves,
  StablecoinFlags,
  StablecoinLink,
  YieldConfig,
} from "./core";
import {
  BACKING_TYPE_VALUES,
  COIN_NOTICE_TYPE_VALUES,
  COLLATERAL_QUALITY_VALUES,
  CUSTODY_MODEL_VALUES,
  DEPENDENCY_TYPE_VALUES,
  DEPLOYMENT_MODEL_VALUES,
  FEATURED_CONTENT_TYPE_VALUES,
  GOVERNANCE_QUALITY_VALUES,
  GOVERNANCE_TYPE_VALUES,
  INFRASTRUCTURE_VALUES,
  LAUNCH_MILESTONE_TYPE_VALUES,
  LAUNCH_PHASE_VALUES,
  PEG_CURRENCY_VALUES,
  PROOF_OF_RESERVES_TYPE_VALUES,
  STABLECOIN_STATUS_VALUES,
  VARIANT_KIND_VALUES,
  YIELD_TYPE_VALUES,
  CHAIN_TIER_VALUES,
} from "./core";

const ContractDecimalsSchema = z.number().finite().int().min(0).max(255);
const DependencyWeightNumberSchema = z.number().finite().positive().max(1);

export const StablecoinFlagsSchema: z.ZodType<StablecoinFlags> = z.object({
  backing: z.enum(BACKING_TYPE_VALUES),
  pegCurrency: z.enum(PEG_CURRENCY_VALUES),
  governance: z.enum(GOVERNANCE_TYPE_VALUES),
  yieldBearing: z.boolean(),
  rwa: z.boolean(),
  navToken: z.boolean(),
}).strict();

export const ProofOfReservesSchema: z.ZodType<ProofOfReserves> = z.object({
  type: z.enum(PROOF_OF_RESERVES_TYPE_VALUES),
  url: z.string(),
  provider: z.string().optional(),
}).strict();

export const StablecoinLinkSchema: z.ZodType<StablecoinLink> = z.object({
  label: z.string(),
  url: z.string(),
}).strict();

export const JurisdictionSchema: z.ZodType<Jurisdiction> = z.object({
  country: z.string(),
  regulator: z.string().optional(),
  license: z.string().optional(),
}).strict();

export const ContractDeploymentSchema: z.ZodType<ContractDeployment> = z.object({
  chain: z.string(),
  address: z.string(),
  decimals: ContractDecimalsSchema,
}).strict();

export const DependencyWeightSchema: z.ZodType<DependencyWeight> = z.object({
  id: z.string(),
  weight: DependencyWeightNumberSchema,
  type: z.enum(DEPENDENCY_TYPE_VALUES).optional(),
}).strict();

export const CoinNoticeSchema: z.ZodType<CoinNotice> = z.object({
  type: z.enum(COIN_NOTICE_TYPE_VALUES),
  title: z.string(),
  message: z.string(),
}).strict();

export const YieldConfigSchema: z.ZodType<YieldConfig> = z.object({
  defiLlamaPoolId: z.string().optional(),
  yieldSource: z.string(),
  yieldType: z.enum(YIELD_TYPE_VALUES),
}).strict();

export const LaunchMilestoneSchema: z.ZodType<LaunchMilestone> = z.object({
  date: z.string(),
  type: z.enum(LAUNCH_MILESTONE_TYPE_VALUES),
  title: z.string(),
  description: z.string().optional(),
  sourceUrl: z.string().optional(),
}).strict();

export const DateHistoryEntrySchema: z.ZodType<DateHistoryEntry> = z.object({
  date: z.string(),
  setOn: z.string(),
}).strict();

export const FeaturedContentSchema: z.ZodType<FeaturedContent> = z.object({
  type: z.enum(FEATURED_CONTENT_TYPE_VALUES),
  url: z.string(),
  title: z.string(),
  description: z.string().optional(),
  image: z.string().optional(),
  source: z.string().optional(),
}).strict();

export const StablecoinMetaEnumSchemas = {
  chainTier: z.enum(CHAIN_TIER_VALUES),
  deploymentModel: z.enum(DEPLOYMENT_MODEL_VALUES),
  collateralQuality: z.enum(COLLATERAL_QUALITY_VALUES),
  custodyModel: z.enum(CUSTODY_MODEL_VALUES),
  governanceQuality: z.enum(GOVERNANCE_QUALITY_VALUES),
  infrastructures: z.array(z.enum(INFRASTRUCTURE_VALUES)),
  variantKind: z.enum(VARIANT_KIND_VALUES),
  launchPhase: z.enum(LAUNCH_PHASE_VALUES),
  status: z.enum(STABLECOIN_STATUS_VALUES),
} as const;
