import { z } from "zod";
import type { DeadStablecoin, StablecoinMeta } from "../../types";
import { LiveReservesConfigSchema } from "../live-reserve-adapters";
import {
  DEPENDENCY_TYPE_VALUES,
  GOVERNANCE_TYPE_VALUES,
  CHAIN_TIER_VALUES,
  DEPLOYMENT_MODEL_VALUES,
  COLLATERAL_QUALITY_VALUES,
  CUSTODY_MODEL_VALUES,
  GOVERNANCE_QUALITY_VALUES,
  YIELD_TYPE_VALUES,
} from "../../types/core";

const BACKING_TYPE_VALUES = ["rwa-backed", "crypto-backed", "algorithmic"] as const;
const PEG_CURRENCY_VALUES = [
  "USD",
  "EUR",
  "GBP",
  "CHF",
  "BRL",
  "RUB",
  "JPY",
  "IDR",
  "SGD",
  "TRY",
  "AUD",
  "ZAR",
  "CAD",
  "CNY",
  "CNH",
  "PHP",
  "MXN",
  "UAH",
  "ARS",
  "GOLD",
  "SILVER",
  "VAR",
  "OTHER",
] as const;
const DETAIL_PROVIDER_VALUES = ["defillama", "coingecko", "commodity"] as const;
const PROOF_OF_RESERVES_TYPE_VALUES = ["independent-audit", "real-time", "self-reported"] as const;
const RESERVE_RISK_VALUES = ["very-low", "low", "medium", "high", "very-high"] as const;
const PROTOCOL_FAMILY_VALUES = ["liquity"] as const;
const PROTOCOL_VARIANT_VALUES = ["v1", "v2", "style"] as const;
const COIN_NOTICE_TYPE_VALUES = ["danger", "warning", "info"] as const;
const LAUNCH_PHASE_VALUES = ["announced", "testnet", "auditing", "beta", "launching-soon"] as const;
const LAUNCH_MILESTONE_TYPE_VALUES = ["announcement", "milestone", "delay", "partnership", "regulatory", "audit", "testnet"] as const;
const FEATURED_CONTENT_TYPE_VALUES = ["tweet", "blog", "video", "article"] as const;
const STATUS_VALUES = ["pre-launch", "active"] as const;
const CAUSE_OF_DEATH_VALUES = [
  "algorithmic-failure",
  "counterparty-failure",
  "liquidity-drain",
  "regulatory",
  "abandoned",
] as const;

const StablecoinFlagsAssetSchema = z.object({
  backing: z.enum(BACKING_TYPE_VALUES),
  pegCurrency: z.enum(PEG_CURRENCY_VALUES),
  governance: z.enum(GOVERNANCE_TYPE_VALUES),
  yieldBearing: z.boolean(),
  rwa: z.boolean(),
  navToken: z.boolean(),
}).strict();

const ProofOfReservesAssetSchema = z.object({
  type: z.enum(PROOF_OF_RESERVES_TYPE_VALUES),
  url: z.string(),
  provider: z.string().optional(),
}).strict();

const StablecoinLinkAssetSchema = z.object({
  label: z.string(),
  url: z.string(),
}).strict();

const JurisdictionAssetSchema = z.object({
  country: z.string(),
  regulator: z.string().optional(),
  license: z.string().optional(),
}).strict();

const ContractDeploymentAssetSchema = z.object({
  chain: z.string(),
  address: z.string(),
  decimals: z.number(),
}).strict();

const DependencyWeightAssetSchema = z.object({
  id: z.string(),
  weight: z.number(),
  type: z.enum(DEPENDENCY_TYPE_VALUES).optional(),
}).strict();

const ReserveSliceAssetSchema = z.object({
  name: z.string(),
  pct: z.number(),
  risk: z.enum(RESERVE_RISK_VALUES),
  coinId: z.string().optional(),
  depType: z.enum(DEPENDENCY_TYPE_VALUES).optional(),
  blacklistable: z.boolean().optional(),
}).strict();

const CoinNoticeAssetSchema = z.object({
  type: z.enum(COIN_NOTICE_TYPE_VALUES),
  title: z.string(),
  message: z.string(),
}).strict();

const YieldConfigAssetSchema = z.object({
  defiLlamaPoolId: z.string().optional(),
  yieldSource: z.string(),
  yieldType: z.enum(YIELD_TYPE_VALUES),
}).strict();

const LaunchMilestoneAssetSchema = z.object({
  date: z.string(),
  type: z.enum(LAUNCH_MILESTONE_TYPE_VALUES),
  title: z.string(),
  description: z.string().optional(),
  sourceUrl: z.string().optional(),
}).strict();

const DateHistoryEntryAssetSchema = z.object({
  date: z.string(),
  setOn: z.string(),
}).strict();

const FeaturedContentAssetSchema = z.object({
  type: z.enum(FEATURED_CONTENT_TYPE_VALUES),
  url: z.string(),
  title: z.string(),
  description: z.string().optional(),
  image: z.string().optional(),
  source: z.string().optional(),
}).strict();

export const StablecoinMetaAssetSchema = z.object({
  id: z.string(),
  llamaId: z.string().optional(),
  detailProvider: z.enum(DETAIL_PROVIDER_VALUES).optional(),
  name: z.string(),
  symbol: z.string(),
  flags: StablecoinFlagsAssetSchema,
  pegReferenceId: z.string().optional(),
  collateral: z.string().optional(),
  pegMechanism: z.string().optional(),
  commodityOunces: z.number().optional(),
  geckoId: z.string().optional(),
  cmcSlug: z.string().optional(),
  pythFeedId: z.string().optional(),
  protocolSlug: z.string().optional(),
  proofOfReserves: ProofOfReservesAssetSchema.optional(),
  links: z.array(StablecoinLinkAssetSchema).optional(),
  jurisdiction: JurisdictionAssetSchema.optional(),
  contracts: z.array(ContractDeploymentAssetSchema).optional(),
  tradedContracts: z.array(ContractDeploymentAssetSchema).optional(),
  dependencies: z.array(DependencyWeightAssetSchema).optional(),
  canBeBlacklisted: z.union([z.boolean(), z.literal("possible")]).optional(),
  chainTier: z.enum(CHAIN_TIER_VALUES).optional(),
  deploymentModel: z.enum(DEPLOYMENT_MODEL_VALUES).optional(),
  collateralQuality: z.enum(COLLATERAL_QUALITY_VALUES).optional(),
  custodyModel: z.enum(CUSTODY_MODEL_VALUES).optional(),
  governanceQuality: z.enum(GOVERNANCE_QUALITY_VALUES).optional(),
  protocolFamily: z.enum(PROTOCOL_FAMILY_VALUES).optional(),
  protocolVariant: z.enum(PROTOCOL_VARIANT_VALUES).optional(),
  reserves: z.array(ReserveSliceAssetSchema).optional(),
  liveReservesConfig: LiveReservesConfigSchema.optional(),
  notices: z.array(CoinNoticeAssetSchema).optional(),
  tags: z.array(z.string()).optional(),
  yieldConfig: YieldConfigAssetSchema.optional(),
  status: z.enum(STATUS_VALUES).optional(),
  launchDate: z.string().optional(),
  announcedDate: z.string().optional(),
  expectedLaunchDate: z.string().optional(),
  launchPhase: z.enum(LAUNCH_PHASE_VALUES).optional(),
  launchPhaseDetail: z.string().optional(),
  featuredContent: z.array(FeaturedContentAssetSchema).optional(),
  milestones: z.array(LaunchMilestoneAssetSchema).optional(),
  dateHistory: z.array(DateHistoryEntryAssetSchema).optional(),
}).strict();

export const StablecoinMetaAssetArraySchema = z.array(StablecoinMetaAssetSchema);
export const CanonicalOrderAssetSchema = z.array(z.string());

export const DeadStablecoinAssetSchema = z.object({
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
