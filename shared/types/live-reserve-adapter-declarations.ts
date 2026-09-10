import { z } from "zod";
import { DEPENDENCY_TYPE_VALUES } from "./dependency-types";
import { LIVE_RESERVE_RPC_MODE_VALUES } from "./live-reserve-core";
import type {
  LiveReserveAdapterValidationPolicy,
  LiveReserveEvidenceClass,
  LiveReserveInput,
  LiveReserveSemantics,
  LiveReserveSourceModel,
  LiveReserveSourceSharingMode,
  ReserveDisplayBadgeKind,
} from "./live-reserve-core";
import { RedemptionHolderEligibilitySchema } from "./redemption";
import type { ReserveEvidenceSourceOriginClass } from "./report-card-evidence-journal";
import {
  ReserveAssetClassSchema,
  ReserveRiskFactorSchema,
  ReserveRiskSchema,
  ReserveSliceSchema,
} from "./reserves";
import {
  ANY_FRESHNESS,
  BUSINESS_DAY_NAV_SOURCE_MAX_AGE_SEC,
  DASHBOARD_SOURCE_MAX_AGE_SEC,
  DASHBOARD_VALIDATION,
  DASHBOARD_VERIFIED_VALIDATION,
  DASHBOARD_WITH_UNKNOWN_CAP_VALIDATION,
  DISCLOSURE_SOURCE_MAX_AGE_SEC,
  DISCLOSURE_VALIDATION,
  LATE_MONTHLY_DISCLOSURE_SOURCE_MAX_AGE_SEC,
  LATE_MONTHLY_VERIFIED_VALIDATION,
  LATEST_STATE_VALIDATION,
  LATEST_STATE_WITH_UNKNOWN_CAP_VALIDATION,
  MATERIAL_UNKNOWN_EXPOSURE_PCT,
  MONTHLY_DISCLOSURE_SOURCE_MAX_AGE_SEC,
  MONTHLY_VERIFIED_VALIDATION,
  QUARTERLY_ASSURANCE_MAX_AGE_SEC,
  TIMESTAMPED_FEED_VALIDATION,
  TIMESTAMPLESS_WITH_UNKNOWN_CAP_VALIDATION,
  UNVERIFIED_OR_NOT_APPLICABLE_FRESHNESS,
  VERIFIED_ONLY_FRESHNESS,
  VERIFIED_ONLY_VALIDATION,
  VERIFIED_OR_UNVERIFIED_FRESHNESS,
  WEEKLY_SOURCE_MAX_AGE_SEC,
} from "./live-reserve-adapter-policy";

type LiveReserveAdapterConfigValidationPolicy = {
  allowedSemantics: readonly LiveReserveSemantics[];
  allowedVersions: readonly number[];
};

function configPolicy<
  const Semantics extends readonly LiveReserveSemantics[],
  const Versions extends readonly number[],
>(allowedSemantics: Semantics, allowedVersions: Versions) {
  return { allowedSemantics, allowedVersions };
}

const CONFIG_COLLATERAL_V1 = configPolicy(["collateral-mix"], [1]);
const CONFIG_COLLATERAL_V2 = configPolicy(["collateral-mix"], [2]);
const CONFIG_COLLATERAL_V2_V3_V4 = configPolicy(["collateral-mix"], [2, 3, 4]);
const CONFIG_COLLATERAL_V1_V2 = configPolicy(["collateral-mix"], [1, 2]);
const CONFIG_ATTESTATION_V1 = configPolicy(["attestation-mix"], [1]);
const CONFIG_ATTESTATION_V1_V2 = configPolicy(["attestation-mix"], [1, 2]);
const CONFIG_ATTESTATION_V2 = configPolicy(["attestation-mix"], [2]);
const CONFIG_PROTOCOL_V1 = configPolicy(["protocol-reserve"], [1]);
const CONFIG_PROTOCOL_V2 = configPolicy(["protocol-reserve"], [2]);
const CONFIG_PROTOCOL_V1_V2 = configPolicy(["protocol-reserve"], [1, 2]);
const CONFIG_SINGLE_ASSET_V1 = configPolicy(["single-asset"], [1]);
const CONFIG_SINGLE_ASSET_V2 = configPolicy(["single-asset"], [2]);
const CONFIG_SINGLE_ASSET_V1_V2 = configPolicy(["single-asset"], [1, 2]);
const CONFIG_ACCOUNTABLE = configPolicy(["collateral-mix", "protocol-reserve"], [1]);

// DUSD's reviewed Machine configuration treats position accounting older than
// three hours as stale. Match that contract guard instead of the generic
// dashboard window now that Makina snapshots expose the oldest position time.
const MAKINA_POSITION_SOURCE_MAX_AGE_SEC = 3 * 60 * 60;

const CONFIG_CURATED_VALIDATED = configPolicy(
  ["attestation-mix", "collateral-mix", "single-asset"],
  [1, 2],
);

export const LIVE_RESERVE_ADAPTER_STATUS_VALUES = ["active", "staged", "retired", "parked"] as const;

export type LiveReserveAdapterStatus = (typeof LIVE_RESERVE_ADAPTER_STATUS_VALUES)[number];

export interface LiveReserveAdapterProvenance {
  status: LiveReserveAdapterStatus;
  rationale: string;
  parkedSince?: string;
  nextReview?: string;
}

export type LiveReserveAdapterDescriptor = {
  primaryInputKinds: readonly LiveReserveInput["kind"][];
  paramsSchema: z.ZodTypeAny;
  sourceModel: LiveReserveSourceModel;
  evidenceClass: LiveReserveEvidenceClass;
  sourceOriginClass?: ReserveEvidenceSourceOriginClass;
  sharedSourceMode: LiveReserveSourceSharingMode;
  configValidation: LiveReserveAdapterConfigValidationPolicy;
  redemptionTelemetry: {
    capacity: "direct" | "proxy" | "none";
    /** Capacity emission requires per-coin params (e.g. a redemptionCapacity
     *  block); coins without them never emit and need no unused-telemetry
     *  policy. */
    capacityParamsGated?: boolean;
    fee: "current-bps" | "none";
  };
  validation?: LiveReserveAdapterValidationPolicy;
  /** Target freshness, distinct from tolerated fallback modes. */
  preferredFreshnessMode?: "verified" | "not-applicable";
  /** Upstream evidence limitation when no honest preferred mode is available. */
  freshnessLimitation?: string;
  provenance?: LiveReserveAdapterProvenance;
  displayBadgeKind?: ReserveDisplayBadgeKind;
};

type AdapterProfile = Omit<LiveReserveAdapterDescriptor, "paramsSchema">;

function declareAdapter<
  const Schema extends z.ZodTypeAny,
  const Profile extends AdapterProfile,
  const Overrides extends Partial<AdapterProfile> = Record<never, never>,
>(paramsSchema: Schema, profile: Profile, overrides?: Overrides) {
  return {
    paramsSchema,
    ...profile,
    ...overrides,
  };
}

const ONCHAIN_SINGLE_ASSET_V1 = {
  primaryInputKinds: ["onchain-evm"],
  sourceModel: "single-bucket",
  evidenceClass: "independent",
  sharedSourceMode: "none",
  configValidation: CONFIG_SINGLE_ASSET_V1,
  redemptionTelemetry: { capacity: "direct", fee: "none" },
  validation: LATEST_STATE_VALIDATION,
} as const satisfies AdapterProfile;

const ONCHAIN_SINGLE_ASSET_V2 = {
  ...ONCHAIN_SINGLE_ASSET_V1,
  configValidation: CONFIG_SINGLE_ASSET_V2,
  redemptionTelemetry: { capacity: "direct", fee: "current-bps" },
} as const satisfies AdapterProfile;

const HTTP_DASHBOARD_COLLATERAL_V1 = {
  primaryInputKinds: ["http-json"],
  sourceModel: "dynamic-mix",
  evidenceClass: "independent",
  preferredFreshnessMode: "verified",
  sharedSourceMode: "none",
  configValidation: CONFIG_COLLATERAL_V1,
  redemptionTelemetry: { capacity: "none", fee: "none" },
  validation: DASHBOARD_WITH_UNKNOWN_CAP_VALIDATION,
} as const satisfies AdapterProfile;

const HTTP_DISCLOSURE_ATTESTATION_V1 = {
  primaryInputKinds: ["http-html"],
  sourceModel: "dynamic-mix",
  evidenceClass: "independent",
  sharedSourceMode: "none",
  configValidation: CONFIG_ATTESTATION_V1,
  redemptionTelemetry: { capacity: "none", fee: "none" },
  validation: MONTHLY_VERIFIED_VALIDATION,
} as const satisfies AdapterProfile;

const HTTP_DISCLOSURE_ATTESTATION_V2 = {
  ...HTTP_DISCLOSURE_ATTESTATION_V1,
  sourceOriginClass: "independent-assurance",
  configValidation: CONFIG_ATTESTATION_V2,
  validation: LATE_MONTHLY_VERIFIED_VALIDATION,
} as const satisfies AdapterProfile;

const HTTP_PROTOCOL_V1 = {
  primaryInputKinds: ["http-json"],
  sourceModel: "single-bucket",
  evidenceClass: "weak-live-probe",
  sharedSourceMode: "none",
  configValidation: CONFIG_PROTOCOL_V1,
  redemptionTelemetry: { capacity: "none", fee: "none" },
  validation: DASHBOARD_VALIDATION,
} as const satisfies AdapterProfile;

// ---------------------------------------------------------------------------
// Adapter params schemas
//
// Each schema is referenced directly by the declaration below it, so adding an
// adapter is one schema const plus one declaration entry in this file. Reuse
// `noParamsSchema` when the adapter takes no per-coin params.
// ---------------------------------------------------------------------------

const LiveReserveRpcModeSchema = z.enum(LIVE_RESERVE_RPC_MODE_VALUES);
const LiveReserveRiskSchema = ReserveRiskSchema;
const LiveReserveDependencyTypeSchema = z.enum(DEPENDENCY_TYPE_VALUES);
const AbsoluteUrlSchema = z.string().url();
const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const EvmAddressSchema = z.string().regex(EVM_ADDRESS_PATTERN);
const EvmWordSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const EvmSelectorSchema = z.string().regex(/^0x[0-9a-fA-F]{8}$/);
// eslint-disable-next-line security/detect-unsafe-regex -- anchored fixed-width base32 principal pattern; finite quantifiers, no backtracking ambiguity.
const ICP_CANISTER_ID_PATTERN = /^[a-z2-7]{5}(-[a-z2-7]{5}){3}-[a-z2-7]{3}$/;
const IcpCanisterIdSchema = z.string().regex(ICP_CANISTER_ID_PATTERN);

const OptionalEvmRpcFields = {
  rpcUrl: AbsoluteUrlSchema.optional(),
  fallbackRpcUrl: AbsoluteUrlSchema.optional(),
} as const;
const RequiredSourceUrlsFields = { sourceUrls: z.array(AbsoluteUrlSchema).min(1) } as const;
const OptionalSourceUrlsFields = { sourceUrls: z.array(AbsoluteUrlSchema).min(1).optional() } as const;
const NonemptySourceUrlsFields = { sourceUrls: z.array(AbsoluteUrlSchema).nonempty() } as const;
const TrackedExposureFields = {
  risk: LiveReserveRiskSchema,
  coinId: z.string().optional(),
  depType: LiveReserveDependencyTypeSchema.optional(),
} as const;
const EvmAddressFields = { address: EvmAddressSchema } as const;
const OptionalOracleFreshnessFields = { maxOracleAgeSec: z.number().positive().optional() } as const;

const stringRecordSchema = z.record(z.string(), z.string());
const riskRecordSchema = z.record(z.string(), LiveReserveRiskSchema);
const depTypeRecordSchema = z.record(z.string(), LiveReserveDependencyTypeSchema);

const noParamsSchema = z.object({}).strict();

const hyloAddressSchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const hyloSolanaParamsSchema = z.object({
  program: hyloAddressSchema,
  state: hyloAddressSchema,
  registry: hyloAddressSchema,
  hyusdMint: hyloAddressSchema,
  solOracle: hyloAddressSchema,
  usdcPair: hyloAddressSchema,
  usdcVault: hyloAddressSchema,
  usdcMint: hyloAddressSchema,
  lsts: z.array(z.object({
    mint: hyloAddressSchema, name: z.string().min(1),
    priceChain: z.string().min(1), priceAddress: z.string().min(1),
  }).strict()).min(1).max(16),
  exoPairs: z.array(z.object({
    pair: hyloAddressSchema, vault: hyloAddressSchema, mint: hyloAddressSchema,
    oracle: hyloAddressSchema, feedId: z.string().regex(/^[0-9a-f]{64}$/),
    pool: z.enum(["cbbtc-pool", "hype-pool"]), name: z.string().min(1),
    priceAddress: z.string().min(1),
  }).strict()).length(2),
  inactiveExoPairs: z.array(hyloAddressSchema).max(16),
}).strict();

const usd1BundleOracleParamsSchema = z
  .object({
    ...OptionalEvmRpcFields,
  })
  .strict();

const usdaiProofOfReservesParamsSchema = z.object({
  anchor: z.object({
    vaultAddress: EvmAddressSchema,
    assetAddress: EvmAddressSchema,
    toleranceBps: z.number().int().min(0).max(100),
    liquidReserves: z.array(z.object({
      name: z.string().min(1),
      tokenAddress: EvmAddressSchema,
      holderAddress: EvmAddressSchema,
      decimals: z.number().int().min(0).max(18),
    }).strict()).min(1).max(4),
  }).strict().optional(),
  ...OptionalEvmRpcFields,
}).strict();

const accountableParamsSchema = z
  .object({
    bucket: z
      .enum([
        "type",
        "reserves_split",
        "deployment",
        "type_split",
        "stablecoin_split",
        "exposure_split",
        "protocol_split",
      ])
      .optional(),
    layout: z.enum(["reserves-types", "asset-breakdown"]).optional(),
    riskMap: riskRecordSchema.optional(),
    renameMap: stringRecordSchema.optional(),
    sourceKeyMap: stringRecordSchema.optional(),
    coinIdMap: stringRecordSchema.optional(),
    depTypeMap: depTypeRecordSchema.optional(),
    totalReservesExcludeBuckets: z.array(z.string().min(1)).optional(),
    allowNegativeBuckets: z.array(z.string().min(1)).optional(),
  })
  .strict();

const attestationPdfIndexParamsSchema = z
  .object({
    slices: z.array(ReserveSliceSchema).min(1),
    linkMatch: z
      .string()
      .trim()
      .min(1)
      .refine((value) => {
        try {
          // eslint-disable-next-line security/detect-non-literal-regexp -- compiling a reviewed static currency token, not executing user input.
          new RegExp(value);
          return true;
        } catch {
          return false;
        }
      }, { message: "linkMatch must compile as a regular expression" })
      .optional(),
  })
  .strict()
  .superRefine((params, ctx) => {
    const total = params.slices.reduce((sum, slice) => sum + slice.pct, 0);
    if (Math.abs(total - 100) > 1.5) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["slices"],
        message: `configured reserve composition sum to ${total.toFixed(1)}% (expected 100% ± 1.5%)`,
      });
    }
  });

const assuranceHostSchema = z.string().regex(/^[A-Za-z0-9.-]+$/);
const assuranceParamsShape = {
  indexHost: assuranceHostSchema,
  reportHosts: z.array(assuranceHostSchema).min(1),
};

const paxosAssuranceParamsSchema = z.object({
  product: z.enum(["PAXG", "PYUSD", "USDP", "USDG", "GUSD"]).default("PAXG"),
}).strict();

const audxAssuranceParamsSchema = z
  .object({
    product: z.literal("AUDX"),
    profile: z.literal("audx-v1"),
    ...assuranceParamsShape,
  })
  .strict();

const europAssuranceParamsSchema = z
  .object({
    product: z.literal("EUROP"),
    profile: z.literal("europ-v1"),
    ...assuranceParamsShape,
  })
  .strict();

const straitsxAssuranceParamsSchema = z
  .object({
    product: z.enum(["XSGD", "XUSD"]),
    profile: z.literal("straitsx-v1"),
    ...assuranceParamsShape,
  })
  .strict();

const usdgoAssuranceParamsSchema = z
  .object({
    product: z.literal("USDGO"),
    profile: z.literal("usdgo-v1"),
    ...assuranceParamsShape,
    issuerCrossCheckUrl: z.literal("https://www.usdgo.com/api/lark-bitable"),
  })
  .strict();

const mocV3BucketSchema = z
  .object({
    ...EvmAddressFields,
    expectedProxyCodeHash: EvmWordSchema,
    expectedImplementationAddress: EvmAddressSchema,
    expectedImplementationCodeHash: EvmWordSchema,
    collateralToken: EvmAddressSchema,
    collateralDecimals: z.number().int().nonnegative().max(36),
    expectedPegContainerProvider: EvmAddressSchema,
    expectedPriceProvider: EvmAddressSchema,
  })
  .strict();

const mocV3BucketsParamsSchema = z
  .object({
    rpcUrl: z.literal("https://public-node.rsk.co"),
    fallbackRpcUrl: z.literal("https://mycrypto.rsk.co"),
    confirmationDepth: z.number().int().positive().max(256),
    maxBlockAgeSec: z.number().int().positive(),
    maxFutureSkewSec: z.number().int().nonnegative(),
    maxMarketProtocolDivergencePct: z.number().positive().max(100),
    walletExcessInfoPct: z.number().nonnegative().max(100),
    walletExcessDegradedPct: z.number().positive().max(100),
    branchMaterialityPct: z.number().positive().max(100),
    canonicalUsdrif: z
      .object({
        ...EvmAddressFields,
        expectedProxyCodeHash: EvmWordSchema,
        decimals: z.number().int().nonnegative().max(36),
      })
      .strict(),
    rifToken: z
      .object({
        ...EvmAddressFields,
        expectedCodeHash: EvmWordSchema,
        decimals: z.number().int().nonnegative().max(36),
      })
      .strict(),
    docToken: z
      .object({
        ...EvmAddressFields,
        expectedCodeHash: EvmWordSchema,
        decimals: z.number().int().nonnegative().max(36),
      })
      .strict(),
    rifBucket: mocV3BucketSchema,
    docBucket: mocV3BucketSchema,
    ...RequiredSourceUrlsFields,
  })
  .strict()
  .superRefine((params, ctx) => {
    if (params.walletExcessInfoPct >= params.walletExcessDegradedPct) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["walletExcessInfoPct"],
        message: "walletExcessInfoPct must be less than walletExcessDegradedPct",
      });
    }
    if (params.rifBucket.collateralToken.toLowerCase() !== params.rifToken.address.toLowerCase()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rifBucket", "collateralToken"],
        message: "RIF bucket collateral token must match rifToken.address",
      });
    }
    if (params.docBucket.collateralToken.toLowerCase() !== params.docToken.address.toLowerCase()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["docBucket", "collateralToken"],
        message: "DOC bucket collateral token must match docToken.address",
      });
    }
  });

const btcfiParamsSchema = z
  .object({
    handlersUrl: AbsoluteUrlSchema,
  })
  .strict();

const fxParamsSchema = z
  .object({
    ...OptionalEvmRpcFields,
  })
  .strict();

const fraxFpiCollateralParamsSchema = z
  .object({
    controllerAddress: EvmAddressSchema,
    fpiTokenAddress: EvmAddressSchema,
    fraxTokenAddress: EvmAddressSchema,
    expectedControllerCodeHash: EvmWordSchema,
    expectedFraxPriceFeedAddress: EvmAddressSchema,
    expectedFraxPriceFeedCodeHash: EvmWordSchema,
    expectedFraxPriceFeedDecimals: z.number().int().nonnegative().max(36),
    expectedFpiPriceFeedAddress: EvmAddressSchema,
    expectedFpiPriceFeedCodeHash: EvmWordSchema,
    expectedFpiPriceFeedDecimals: z.number().int().nonnegative().max(36),
    expectedCpiTrackerAddress: EvmAddressSchema,
    expectedCpiTrackerCodeHash: EvmWordSchema,
    maxPriceFeedAgeSec: z.number().int().positive(),
    fullConfidenceCpiTrackerAgeSec: z.number().int().positive(),
    maxCpiTrackerAgeSec: z.number().int().positive(),
    expectedRedeemFeeE6: z.number().int().nonnegative().max(1_000_000),
    outputTrackedAssetId: z.literal("frax-frax"),
    minOutputPriceUsd: z.number().finite().positive(),
    maxOutputPriceUsd: z.number().finite().positive(),
    ...RequiredSourceUrlsFields,
    ...OptionalEvmRpcFields,
  })
  .strict()
  .superRefine((params, ctx) => {
    if (params.minOutputPriceUsd > params.maxOutputPriceUsd) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["minOutputPriceUsd"],
        message: "minOutputPriceUsd must be less than or equal to maxOutputPriceUsd",
      });
    }
    if (params.fullConfidenceCpiTrackerAgeSec > params.maxCpiTrackerAgeSec) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fullConfidenceCpiTrackerAgeSec"],
        message: "fullConfidenceCpiTrackerAgeSec must be less than or equal to maxCpiTrackerAgeSec",
      });
    }
  });

const blastUsdbYieldManagerParamsSchema = z
  .object({
    yieldManagerAddress: EvmAddressSchema,
    supplyChain: z.string(),
    supplyTokenAddress: EvmAddressSchema,
    supplyRpcUrl: AbsoluteUrlSchema,
    fallbackSupplyRpcUrl: AbsoluteUrlSchema.optional(),
    ...OptionalEvmRpcFields,
  })
  .strict();

const chainlinkNavParamsSchema = z
  .object({
    navScope: z.enum(["native-fund-share", "portfolio"]),
    oracleAddress: EvmAddressSchema,
    tokenAddress: EvmAddressSchema,
    assetLabel: z.string(),
    assetRisk: LiveReserveRiskSchema,
    sourceKey: z.string()
      .trim()
      .min(3)
      .max(160)
      .regex(/^[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._:/-]*$/)
      .optional(),
    oracleMethod: z.enum(["latestRoundData", "getPrice", "getPriceData", "getAssetPrice"]).optional(),
    ...OptionalEvmRpcFields,
    ...OptionalOracleFreshnessFields,
    redemptionCapacity: z
      .object({
        managerAddress: EvmAddressSchema,
        usdcAddress: EvmAddressSchema,
        routerAddress: EvmAddressSchema,
        sourceAddress: EvmAddressSchema,
        pauseSelector: EvmSelectorSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const chronicleNavParamsSchema = z
  .object({
    navScope: z.enum(["native-fund-share", "portfolio"]),
    consumerAddress: EvmAddressSchema,
    tokenAddress: EvmAddressSchema,
    assetLabel: z.string(),
    assetRisk: LiveReserveRiskSchema,
    ...OptionalEvmRpcFields,
    ...OptionalOracleFreshnessFields,
  })
  .strict();

const usdaiHubParamsSchema = z
  .object({
    hubAddress: EvmAddressSchema,
    baseTokenAddress: EvmAddressSchema,
    implementationAddress: EvmAddressSchema,
    redemptionCapacity: z
      .object({
        holderEligibility: RedemptionHolderEligibilitySchema,
        ...NonemptySourceUrlsFields,
      })
      .strict(),
    ...OptionalEvmRpcFields,
  })
  .strict();

const xdaiBridgeParamsSchema = z
  .object({
    foreignBridgeAddress: EvmAddressSchema,
    homeBridgeAddress: EvmAddressSchema,
    blockRewardAddress: EvmAddressSchema,
    usdsDepositContractAddress: EvmAddressSchema,
    usdsAddress: EvmAddressSchema,
    susdsAddress: EvmAddressSchema,
    daiAddress: EvmAddressSchema,
    sdaiAddress: EvmAddressSchema,
    ethereumRpcUrl: AbsoluteUrlSchema.optional(),
    ethereumFallbackRpcUrl: AbsoluteUrlSchema.optional(),
    gnosisRpcUrl: AbsoluteUrlSchema.optional(),
    gnosisFallbackRpcUrl: AbsoluteUrlSchema.optional(),
    finalityTag: z.enum(["safe", "finalized"]).optional(),
    maxBlockAgeSec: z.number().int().positive().optional(),
    maxFutureBlockSkewSec: z.number().int().nonnegative().optional(),
    crossChainSkewWarningSec: z.number().int().nonnegative().optional(),
    maxCrossChainSkewSec: z.number().int().positive().optional(),
    coverageShortfallWarningRatio: z.number().finite().positive().max(1).optional(),
    surplusWarningRatio: z.number().finite().gt(1).optional(),
    maxSurplusRatio: z.number().finite().gt(1).optional(),
    legacyWarningPct: z.number().finite().nonnegative().optional(),
    legacyMaterialityPct: z.number().finite().positive().max(100).optional(),
    maxWithdrawDivergencePct: z.number().finite().nonnegative().max(100).optional(),
    ...OptionalSourceUrlsFields,
  })
  .strict()
  .superRefine((params, ctx) => {
    if (
      params.crossChainSkewWarningSec != null &&
      params.maxCrossChainSkewSec != null &&
      params.crossChainSkewWarningSec > params.maxCrossChainSkewSec
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["crossChainSkewWarningSec"],
        message: "crossChainSkewWarningSec must be less than or equal to maxCrossChainSkewSec",
      });
    }
    if (
      params.surplusWarningRatio != null &&
      params.maxSurplusRatio != null &&
      params.surplusWarningRatio > params.maxSurplusRatio
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["surplusWarningRatio"],
        message: "surplusWarningRatio must be less than or equal to maxSurplusRatio",
      });
    }
    if (
      params.legacyWarningPct != null &&
      params.legacyMaterialityPct != null &&
      params.legacyWarningPct > params.legacyMaterialityPct
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["legacyWarningPct"],
        message: "legacyWarningPct must be less than or equal to legacyMaterialityPct",
      });
    }
  });

const hiveHbdProtocolParamsSchema = z
  .object({
    chain: z.literal("hive-mainnet"),
    hardfork: z.literal("hf26-plus"),
    treasuryAccount: z.literal("hive.fund"),
  })
  .strict();

const superstateLiquidityParamsSchema = chainlinkNavParamsSchema
  .extend({
    liquidityUrl: AbsoluteUrlSchema,
    ticker: z.enum(["USTB", "USCC"]),
  })
  .strict();

const capVaultAssetSchema = z
  .object({
    ...EvmAddressFields,
    name: z.string(),
    ...TrackedExposureFields,
    priceUsd: z.number().positive().optional(),
  })
  .strict();

const capVaultParamsSchema = z
  .object({
    ...OptionalEvmRpcFields,
    assets: z.array(capVaultAssetSchema).optional(),
  })
  .strict();

const chainlinkPorIssuerCirculationProbeSchema = z
  .object({
    kind: z.literal("backed-graphql"),
    url: AbsoluteUrlSchema,
    reserveSymbol: z.string().trim().min(1),
  })
  .strict();

const chainlinkPorParamsSchema = z
  .object({
    porFeedAddress: EvmAddressSchema,
    assetLabel: z.string(),
    assetRisk: LiveReserveRiskSchema,
    reserveUnit: z.enum(["USD", "XAU", "XAG", "XAU_G", "XAG_G", "SHARES"]).optional(),
    ...OptionalEvmRpcFields,
    ...OptionalOracleFreshnessFields,
    issuerCirculationProbe: chainlinkPorIssuerCirculationProbeSchema.optional(),
  })
  .strict();

const circleTransparencyParamsSchema = z
  .object({
    coinType: z.enum(["usdc", "eurc"]),
  })
  .strict();

const collateralPositionsRedemptionBridgeSchema = z
  .object({
    chain: z.string(),
    rpcMode: LiveReserveRpcModeSchema,
    holder: EvmAddressSchema,
    tokenAddress: EvmAddressSchema,
    tokenDecimals: z.number().int().nonnegative(),
    priceAddress: EvmAddressSchema.optional(),
    ...OptionalEvmRpcFields,
  })
  .strict();

const collateralPositionsRedemptionBasketBridgeSchema = z
  .object({
    label: z.string().trim().min(1),
    bridgeAddress: EvmAddressSchema,
    tokenAddress: EvmAddressSchema,
    tokenDecimals: z.number().int().nonnegative(),
  })
  .strict();

const collateralPositionsRedemptionBridgeBasketSchema = z
  .object({
    chain: z.string().min(1),
    rpcMode: LiveReserveRpcModeSchema,
    dEuroAddress: EvmAddressSchema,
    eurUsdPriceAddress: EvmAddressSchema,
    bridges: z.array(collateralPositionsRedemptionBasketBridgeSchema).nonempty().max(16),
    ...OptionalEvmRpcFields,
    ...NonemptySourceUrlsFields,
  })
  .strict();

const collateralPositionsParamsSchema = z
  .object({
    pricesUrl: AbsoluteUrlSchema,
    otherThresholdPct: z.number().positive().optional(),
    redemptionBridge: collateralPositionsRedemptionBridgeSchema.optional(),
    redemptionBridgeBasket: collateralPositionsRedemptionBridgeBasketSchema.optional(),
  })
  .strict()
  .refine((params) => !(params.redemptionBridge && params.redemptionBridgeBasket), {
    message: "redemptionBridge and redemptionBridgeBasket are mutually exclusive",
  });

const curatedValidatedParamsSchema = z
  .object({
    ...OptionalEvmRpcFields,
  })
  .strict();

const reserveProtocolDtfAssetSchema = z
  .object({
    ...EvmAddressFields,
    name: z.string(),
    ...TrackedExposureFields,
    blacklistable: z.boolean().optional(),
  })
  .strict();

const reserveProtocolDtfParamsSchema = z
  .object({
    assets: z.array(reserveProtocolDtfAssetSchema).optional(),
    ...OptionalEvmRpcFields,
  })
  .strict();

const resupplyUnderlyingSchema = z
  .object({
    ...EvmAddressFields,
    name: z.string(),
    ...TrackedExposureFields,
  })
  .strict();

const resupplyPairSchema = z
  .object({
    key: z.string(),
    ...EvmAddressFields,
  })
  .strict();

const resupplyPairsParamsSchema = z
  .object({
    ...OptionalEvmRpcFields,
    redemptionHandlerAddress: EvmAddressSchema.optional(),
    pairs: z.array(resupplyPairSchema).min(1),
    underlyings: z.array(resupplyUnderlyingSchema).min(1),
  })
  .strict();

const reserveSliceDescriptorSchema = z
  .object({
    name: z.string(),
    ...TrackedExposureFields,
    expectedAssetAddress: EvmAddressSchema.optional(),
  })
  .strict();

// Saturn USDat's reviewed MultiMint wrapper pins both the implementation and
// the PYUSDx underlying, and the emitted slice is always the canonical PayPal
// USD dependency: M0 documents PYUSDx extensions as 1:1 PYUSDx wrappers and
// PYUSDx as MoonPay's PYUSD-backed tokenization framework (reviewed 2026-09).
const saturnPyusdxParamsSchema = z
  .object({
    wrapperAddress: EvmAddressSchema,
    expectedImplementation: EvmAddressSchema,
    underlyingToken: EvmAddressSchema,
    slice: reserveSliceDescriptorSchema.extend({
      coinId: z.literal("pyusd-paypal"),
      depType: z.literal("wrapper"),
    }),
    ...OptionalSourceUrlsFields,
    ...OptionalEvmRpcFields,
  })
  .strict();

const redemptionRateProbeSchema = z
  .object({
    contract: z.string(),
    selector: EvmSelectorSchema,
    decimals: z.number().int().positive(),
  })
  .strict();

const singleAssetProbeSchema = z
  .object({
    kind: z.literal("json-path"),
    path: z.array(z.string()).min(1),
    scale: z.number().positive().optional(),
  })
  .strict();

const morphoVaultV1RedemptionLiquiditySchema = z
  .object({
    source: z.literal("morpho-vault-v1"),
    chainId: z.number().int().positive(),
    apiUrl: AbsoluteUrlSchema.optional(),
  })
  .strict();

const morphoVaultV2RedemptionLiquiditySchema = z
  .object({
    source: z.literal("morpho-vault-v2"),
    chainId: z.number().int().positive(),
    apiUrl: AbsoluteUrlSchema.optional(),
  })
  .strict();

// Reviewer-asserted: the vault redeems atomically against its full ERC-4626
// backing because the underlying is released on demand from an external savings
// module (e.g. the Sky DSR pot) rather than held as an idle balance in the
// vault. Use only where the unconstrained-redemption property is verified, since
// the default idle-balance telemetry understates such vaults to ~0.
const atomicFullBackingRedemptionLiquiditySchema = z
  .object({
    source: z.literal("atomic-full-backing"),
  })
  .strict();

// Reviewer-asserted Yearn V3 multi-strategy vault path: the adapter measures
// same-run withdrawable capacity from totalIdle plus each funded strategy's
// maxRedeem(vault) value through the vault's default withdrawal queue. This is
// narrower than generic ERC-4626 NAV because strategy liquidity is re-probed on
// every reserve sync.
const yearnV3WithdrawableRedemptionLiquiditySchema = z
  .object({
    source: z.literal("yearn-v3-withdrawable"),
    settlementDelaySec: z.number().int().nonnegative().optional(),
  })
  .strict();

// Reviewer-asserted K3 sBOLD path: the vault deploys its BOLD into Liquity V2
// Stability Pools (idle balance ~0), so the adapter measures same-run
// SP-withdrawable BOLD from the vault's own calcFragments() liquid-BOLD word —
// the value _maxWithdraw caps redemptions at — instead of the idle balance,
// which understates such vaults to ~0.
const sboldSpWithdrawableRedemptionLiquiditySchema = z
  .object({
    source: z.literal("sbold-sp-withdrawable"),
  })
  .strict();

// Reviewer-pinned sfrxUSD holder route. Ethereum sfrxUSD redemptions are
// disabled locally; the active path sends shares through Frax's Ethereum hop,
// redeems against the Fraxtal MintRedeemer inventory, then returns frxUSD.
// Every mutable identity and safety bound is explicit so the observer can fail
// closed on route drift rather than falling back to the local idle balance.
const fraxtalHopWithdrawableRedemptionLiquiditySchema = z
  .object({
    source: z.literal("fraxtal-hop-withdrawable"),
    fraxtalRpcUrl: AbsoluteUrlSchema,
    maxFinalizedBlockAgeSec: z.number().int().positive(),
    maxCrossChainBlockSkewSec: z.number().int().positive(),
    remoteHopAddress: EvmAddressSchema,
    expectedRemoteHopCodeHash: EvmWordSchema,
    expectedEthereumSfrxUsdImplementationAddress: EvmAddressSchema,
    expectedEthereumSfrxUsdProxyCodeHash: EvmWordSchema,
    expectedEthereumSfrxUsdImplementationCodeHash: EvmWordSchema,
    expectedEthereumEid: z.number().int().positive(),
    expectedFraxtalEid: z.number().int().positive(),
    expectedFraxtalHopAddress: EvmAddressSchema,
    expectedEthereumFrxUsdOftAddress: EvmAddressSchema,
    expectedEthereumFrxUsdOftProxyCodeHash: EvmWordSchema,
    expectedEthereumFrxUsdOftImplementationAddress: EvmAddressSchema,
    expectedEthereumFrxUsdOftImplementationCodeHash: EvmWordSchema,
    expectedEthereumSfrxUsdOftAddress: EvmAddressSchema,
    expectedEthereumSfrxUsdOftProxyCodeHash: EvmWordSchema,
    expectedEthereumSfrxUsdOftImplementationAddress: EvmAddressSchema,
    expectedEthereumSfrxUsdOftImplementationCodeHash: EvmWordSchema,
    expectedEthereumFrxUsdAddress: EvmAddressSchema,
    expectedEthUsdFeedAddress: EvmAddressSchema,
    expectedEthUsdFeedCodeHash: EvmWordSchema,
    expectedEthUsdAggregatorAddress: EvmAddressSchema,
    expectedEthUsdAggregatorCodeHash: EvmWordSchema,
    maxEthUsdOracleAgeSec: z.number().int().positive(),
    expectedFraxtalHopCodeHash: EvmWordSchema,
    mintRedeemerProxyAddress: EvmAddressSchema,
    expectedMintRedeemerProxyCodeHash: EvmWordSchema,
    expectedMintRedeemerImplementationAddress: EvmAddressSchema,
    expectedMintRedeemerImplementationCodeHash: EvmWordSchema,
    expectedFrxUsdLockboxAddress: EvmAddressSchema,
    expectedFrxUsdLockboxProxyCodeHash: EvmWordSchema,
    expectedFrxUsdLockboxImplementationAddress: EvmAddressSchema,
    expectedFrxUsdLockboxImplementationCodeHash: EvmWordSchema,
    expectedSfrxUsdLockboxAddress: EvmAddressSchema,
    expectedSfrxUsdLockboxProxyCodeHash: EvmWordSchema,
    expectedSfrxUsdLockboxImplementationAddress: EvmAddressSchema,
    expectedSfrxUsdLockboxImplementationCodeHash: EvmWordSchema,
    expectedFraxtalFrxUsdAddress: EvmAddressSchema,
    expectedFraxtalSfrxUsdAddress: EvmAddressSchema,
    expectedVaultOracleAddress: EvmAddressSchema,
    expectedVaultOracleCodeHash: EvmWordSchema,
    maxOracleToleranceSec: z.number().int().positive(),
    maxOraclePriceDeviationBps: z.number().finite().nonnegative(),
    maxRedemptionFeeBps: z.number().finite().nonnegative(),
    ...RequiredSourceUrlsFields,
  })
  .strict();

const erc4626SingleAssetParamsSchema = z
  .object({
    slice: reserveSliceDescriptorSchema,
    redemptionRoute: z.literal("async-request").optional(),
    redemptionLock: z.array(z.object({
      selector: z.union([EvmSelectorSchema, z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*\(\)$/)]),
      kind: z.enum(["cooldown-seconds", "unstake-window-seconds", "paused-bool"]),
    }).strict()).max(8).optional(),
    redemptionLiquidity: z
      .discriminatedUnion("source", [
        morphoVaultV1RedemptionLiquiditySchema,
        morphoVaultV2RedemptionLiquiditySchema,
        atomicFullBackingRedemptionLiquiditySchema,
        yearnV3WithdrawableRedemptionLiquiditySchema,
        sboldSpWithdrawableRedemptionLiquiditySchema,
        fraxtalHopWithdrawableRedemptionLiquiditySchema,
      ])
      .optional(),
    ...OptionalEvmRpcFields,
  })
  .strict();

const escrowBalanceIdentityCheckSchema = z
  .object({
    selector: EvmSelectorSchema,
    args: z.array(EvmWordSchema).optional(),
    expectedAddress: EvmAddressSchema,
  })
  .strict();

const escrowBalanceSelectorReadSchema = z
  .object({
    contract: EvmAddressSchema,
    selector: EvmSelectorSchema,
    args: z.array(EvmWordSchema).optional(),
    decimals: z.number().int().nonnegative().max(36),
    identityCheck: escrowBalanceIdentityCheckSchema.optional(),
  })
  .strict();

const escrowBalanceErc20ReadSchema = z
  .object({
    contract: EvmAddressSchema,
    erc20BalanceOf: EvmAddressSchema,
    decimals: z.number().int().nonnegative().max(36),
    identityCheck: escrowBalanceIdentityCheckSchema.optional(),
  })
  .strict();

const escrowBalancePauseCheckSchema = z
  .object({
    contract: EvmAddressSchema,
    selector: EvmSelectorSchema,
    args: z.array(EvmWordSchema).optional(),
  })
  .strict();

const escrowBalanceSharedParamsShape = {
  slice: reserveSliceDescriptorSchema.extend({ blacklistable: z.boolean().optional() }),
  ...RequiredSourceUrlsFields,
  holderEligibility: RedemptionHolderEligibilitySchema.optional(),
  settlementDelaySec: z.number().int().nonnegative().optional(),
  compareToCoinSupply: z.boolean().optional(),
  ...OptionalEvmRpcFields,
};

// One pinned escrow/reserve contract whose redemption capacity is readable as a
// single token-denominated view call. This original shape remains unchanged for
// existing configs. `args` are pre-encoded 32-byte ABI words and `decimals` is
// the escrowed asset's decimals, not the tracked coin's.
const escrowBalanceSingleParamsSchema = z
  .object({
    contract: EvmAddressSchema,
    selector: EvmSelectorSchema,
    args: z.array(EvmWordSchema).optional(),
    decimals: z.number().int().nonnegative().max(36),
    // Optional boolean view on the same contract; a true word withholds the
    // route instead of publishing capacity as freely redeemable.
    pausedSelector: EvmSelectorSchema.optional(),
    ...escrowBalanceSharedParamsShape,
  })
  .strict();

// Bounded aggregation for routes whose direct capacity is split across several
// reviewer-pinned views. Every item is either a selector call whose first ABI
// return word is the capacity or an ERC-20 balanceOf(holder) call. Optional
// address-returning identity checks bind a read contract to a reviewed
// dependency. The adapter withholds the whole observation if any read or
// identity check fails.
const escrowBalanceMultiParamsSchema = z
  .object({
    reads: z
      .array(z.union([escrowBalanceSelectorReadSchema, escrowBalanceErc20ReadSchema]))
      .min(1)
      .max(16),
    pauseCheck: escrowBalancePauseCheckSchema.optional(),
    ...escrowBalanceSharedParamsShape,
  })
  .strict();

const escrowBalanceParamsSchema = z.union([
  escrowBalanceSingleParamsSchema,
  escrowBalanceMultiParamsSchema,
]);

// Same wrapper + M token contract addresses as the primary chain, deployed on
// another EVM network (M0's native-multichain model reuses addresses across
// chains). Used to aggregate total supply / underlying M balance across all
// deployments instead of reading only the primary chain.
const m0WrapperAdditionalDeploymentSchema = z
  .object({
    chain: z.string(),
    rpcUrl: AbsoluteUrlSchema.optional(),
  })
  .strict();

const m0WrapperUnderlyingParamsSchema = z
  .object({
    mode: z.enum(["wrapped-m-token", "m-extension"]),
    wrapperAddress: EvmAddressSchema.optional(),
    mTokenSelector: EvmSelectorSchema.optional(),
    expectedMTokenAddress: EvmAddressSchema.optional(),
    swapFacilitySelector: EvmSelectorSchema.optional(),
    expectedSwapFacilityAddress: EvmAddressSchema.optional(),
    swapperAddress: EvmAddressSchema.optional(),
    pausedSelector: EvmSelectorSchema.optional(),
    canSwapViaPathSelector: EvmSelectorSchema.optional(),
    slice: reserveSliceDescriptorSchema,
    ...OptionalSourceUrlsFields,
    ...OptionalEvmRpcFields,
    additionalDeployments: z.array(m0WrapperAdditionalDeploymentSchema).min(1).optional(),
  })
  .strict();

const liquityNativeActivePoolParamsSchema = z
  .object({
    activePoolAddress: EvmAddressSchema,
    collateralLabel: z.string(),
    collateralRisk: LiveReserveRiskSchema,
    collateralDecimals: z.number().int().nonnegative(),
    debtSelector: EvmSelectorSchema,
    debtDecimals: z.number().int().nonnegative().optional(),
    collateralBalanceSelector: EvmSelectorSchema,
    priceFeedAddress: EvmAddressSchema,
    priceSelector: EvmSelectorSchema,
    priceDecimals: z.number().int().nonnegative().optional(),
    troveManagerAddress: EvmAddressSchema,
    tcrSelector: EvmSelectorSchema,
    mcrSelector: EvmSelectorSchema,
    borrowerOperationsAddress: EvmAddressSchema.optional(),
    redemptionRateSelector: EvmSelectorSchema.optional(),
    redemptionRateDecimals: z.number().int().nonnegative().optional(),
    ...OptionalSourceUrlsFields,
    ...OptionalEvmRpcFields,
  })
  .strict();

const originVaultAssetSchema = z
  .object({
    ...EvmAddressFields,
    decimals: z.number().int().nonnegative(),
    name: z.string(),
    ...TrackedExposureFields,
  })
  .strict();

const originVaultBalancesParamsSchema = z
  .object({
    vaultAddress: EvmAddressSchema,
    ...OptionalEvmRpcFields,
    assets: z.array(originVaultAssetSchema).min(1),
  })
  .strict();

const nestVaultPositionsParamsSchema = z
  .object({
    priceUrl: AbsoluteUrlSchema,
    lastPriceUpdateUrl: AbsoluteUrlSchema,
  })
  .strict();

// The credit receivable a `IdleCDOEpochVariant` vault holds is not a tracked
// asset and must never carry a `coinId`: linking it to the deposit token would
// present a single-obligor loan as that token's own reserves. The classification
// (asset class, obligor, risk factors) is reviewed curation and therefore
// config-owned; the *sizing* is always read on-chain.
const idleCdoCreditSliceSchema = z
  .object({
    sourceKey: z.string().trim().min(3),
    name: z.string().trim().min(1),
    risk: LiveReserveRiskSchema,
    assetClass: ReserveAssetClassSchema,
    issuerOrObligor: z.string().trim().min(1),
    riskFactors: z.array(ReserveRiskFactorSchema).min(1),
  })
  .strict();

// Emitted only when the CDO actually holds an unlent underlying balance. The
// adapter never synthesises this slice from NAV.
const idleCdoUnlentSliceSchema = z
  .object({
    sourceKey: z.string().trim().min(3),
    name: z.string().trim().min(1),
    risk: LiveReserveRiskSchema,
    coinId: z.string().trim().min(1),
    depType: LiveReserveDependencyTypeSchema.optional(),
    assetClass: ReserveAssetClassSchema.optional(),
    issuerOrObligor: z.string().trim().min(1).optional(),
    riskFactors: z.array(ReserveRiskFactorSchema).min(1).optional(),
    blacklistable: z.boolean().optional(),
  })
  .strict();

const idleCdoEpochVariantParamsSchema = z
  .object({
    cdoAddress: EvmAddressSchema,
    tranche: z.enum(["AA", "BB"]),
    underlyingAddress: EvmAddressSchema,
    underlyingDecimals: z.number().int().nonnegative(),
    // A structural single-tranche vault has no junior (BB) capital by design.
    // Declaring `false` records the missing junior as an `info` risk fact
    // instead of a data-quality `degraded` warning; the first-loss reality is
    // already carried on the slice's `risk` and `riskFactors`.
    expectJuniorTranche: z.boolean().default(true),
    creditSlice: idleCdoCreditSliceSchema,
    unlentSlice: idleCdoUnlentSliceSchema,
    ...OptionalSourceUrlsFields,
    ...OptionalEvmRpcFields,
  })
  .strict();

const makinaStrategyParamsSchema = z
  .object({
    allocationsUrl: AbsoluteUrlSchema,
    machineAddress: EvmAddressSchema,
    asyncRedeemerAddress: EvmAddressSchema.optional(),
    accountingTokenSymbol: z.string().min(1).optional(),
    accountingTokenDecimals: z.number().int().nonnegative().max(36).optional(),
    otherThresholdPct: z.number().positive().max(20).optional(),
    reconciliationTolerancePct: z.number().positive().max(5).optional(),
  })
  .strict();

const quantozTransparencyParamsSchema = z
  .object({
    token: z.enum(["EURQ", "USDQ"]),
  })
  .strict();

const ethenaWhitelabelParamsSchema = z
  .object({
    stablecoin: z.string().min(1),
  })
  .strict();

// A branch price reference is either an on-chain token, named by its 20-byte
// EVM address, or a CoinGecko market id under the reserved `coingecko` chain.
// The address shape therefore depends on the chain and cannot be pinned by a
// single regex.
const COINGECKO_PRICE_CHAIN = "coingecko";

const priceTokenRefSchema = z
  .object({
    chain: z.string(),
    address: z.string().min(1),
  })
  .strict()
  .superRefine((ref, ctx) => {
    if (ref.chain === COINGECKO_PRICE_CHAIN) return;
    if (!EVM_ADDRESS_PATTERN.test(ref.address)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["address"],
        message: `price token address on chain "${ref.chain}" must be a 20-byte EVM address`,
      });
    }
  });

const evmBranchBalanceBranchSchema = z
  .object({
    /** Reviewed 1:1 conversion for underlying/cross-chain price substitution. */
    underlyingPrice1to1: z.literal(true).optional(),
    chain: z.string().min(1).optional(),
    balanceRead: z.object({
      contract: EvmAddressSchema,
      selector: EvmSelectorSchema,
      args: z.array(EvmWordSchema).optional(),
    }).strict().optional(),
    receipt: z.object({
      kind: z.literal("compound-v2"),
      exchangeRateSelector: EvmSelectorSchema.optional(),
    }).strict().optional(),
    name: z.string(),
    holder: EvmAddressSchema,
    token: z
      .object({
        chain: z.string(),
        ...EvmAddressFields,
        decimals: z.number().int().nonnegative(),
      })
      .strict(),
    priceToken: priceTokenRefSchema.optional(),
    ...TrackedExposureFields,
    priceUsd: z.number().positive().optional(),
  })
  .strict();

const evmBranchBalancesParamsSchema = z
  .object({
    ...OptionalEvmRpcFields,
    branches: z.array(evmBranchBalanceBranchSchema).min(1),
    ...OptionalSourceUrlsFields,
    redemptionRateProbe: redemptionRateProbeSchema.optional(),
    /**
     * When provided, the adapter calls `debtSelector` on `debtContract` (or the
     * first branch's holder if omitted) to fetch a system-wide debt/supply total
     * and emits `collateralizationRatio` in metadata.
     */
    debtSelector: EvmSelectorSchema.optional(),
    debtContract: EvmAddressSchema.optional(),
    debtDecimals: z.number().int().nonnegative().optional(),
    redemptionCapacity: z
      .object({
        kind: z.literal("honey-factory-vaults"),
        factoryAddress: EvmAddressSchema,
        expectedHoneyAddress: EvmAddressSchema,
        maxAssets: z.number().int().positive().max(32),
        stableAssets: z
          .array(
            z
              .object({
                ...EvmAddressFields,
                decimals: z.number().int().nonnegative().max(36),
              })
              .strict(),
          )
          .min(1)
          .max(32),
        ...RequiredSourceUrlsFields,
      })
      .strict()
      .superRefine((params, ctx) => {
        const addresses = new Set<string>();
        params.stableAssets.forEach((asset, index) => {
          const address = asset.address.toLowerCase();
          if (addresses.has(address)) {
            ctx.addIssue({
              code: "custom",
              path: ["stableAssets", index, "address"],
              message: `Duplicate stable asset: ${asset.address}`,
            });
          }
          addresses.add(address);
        });
      })
      .optional(),
  })
  .strict();

const liquityV2MechanismMetricsBranchSchema = z
  .object({
    name: z.string().min(1),
    troveManagerAddress: EvmAddressSchema,
    stabilityPoolAddress: EvmAddressSchema,
  })
  .strict();

const liquityV2MechanismMetricsSchema = z
  .object({
    supplyTokenAddress: EvmAddressSchema,
    branchPriceSelector: EvmSelectorSchema.optional(),
    stabilityPoolDepositsSelector: EvmSelectorSchema,
    maxSupplyDebtDivergencePct: z.number().finite().nonnegative().optional(),
    branches: z.array(liquityV2MechanismMetricsBranchSchema).min(1),
  })
  .strict();

const liquityV2BranchesParamsSchema = evmBranchBalancesParamsSchema
  .extend({
    shutdownSelector: EvmSelectorSchema.optional(),
    mechanismMetrics: liquityV2MechanismMetricsSchema.optional(),
  })
  .strict()
  .superRefine((params, ctx) => {
    if (!params.mechanismMetrics) return;

    const reserveNames = new Set(params.branches.map((branch) => branch.name));
    const metricNames = new Set<string>();
    for (const [index, branch] of params.mechanismMetrics.branches.entries()) {
      if (metricNames.has(branch.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["mechanismMetrics", "branches", index, "name"],
          message: `Duplicate mechanism-metrics branch: ${branch.name}`,
        });
      }
      metricNames.add(branch.name);
      if (!reserveNames.has(branch.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["mechanismMetrics", "branches", index, "name"],
          message: `Unknown reserve branch: ${branch.name}`,
        });
      }
    }

    for (const [index, branch] of params.branches.entries()) {
      if (!metricNames.has(branch.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["branches", index, "name"],
          message: `Missing mechanism-metrics binding for reserve branch: ${branch.name}`,
        });
      }
    }
  });

const ghoGsmModuleSchema = z
  .object({
    ...EvmAddressFields,
    facilitatorAddress: EvmAddressSchema,
    label: z.string(),
    coinId: z.string().optional(),
    depType: LiveReserveDependencyTypeSchema.optional(),
    risk: LiveReserveRiskSchema.optional(),
  })
  .strict();

const ghoParamsSchema = z
  .object({
    ...OptionalEvmRpcFields,
    gsmModules: z.array(ghoGsmModuleSchema).min(1),
    ghoTokenAddress: EvmAddressSchema.optional(),
  })
  .strict();

const liquityV1ParamsSchema = z
  .object({
    troveManagerAddress: EvmAddressSchema,
    slice: reserveSliceDescriptorSchema,
    ...OptionalEvmRpcFields,
    redemptionRateProbe: redemptionRateProbeSchema.optional(),
  })
  .strict();

const yamatoParamsSchema = z
  .object({
    yamatoAddress: EvmAddressSchema,
    priceFeedAddress: EvmAddressSchema.optional(),
    slice: reserveSliceDescriptorSchema.optional(),
    ...OptionalEvmRpcFields,
  })
  .strict();

const jupusdParamsSchema = z
  .object({
    snapshotsUrl: AbsoluteUrlSchema.optional(),
    oracleUrl: AbsoluteUrlSchema.optional(),
  })
  .strict();

// Broker-pool redemption: the coin's own token trades against a stable/USDm
// counter asset in a Mento V2 BiPoolManager pool. `pools` names the token pair;
// the adapter enumerates BiPoolManager.getExchangeIds()/getPoolExchange() at
// runtime and matches by these addresses rather than hardcoding exchangeIds.
const mentoBrokerPoolCounterAssetSchema = z
  .object({
    ...EvmAddressFields,
    label: z.string().optional(),
  })
  .strict();

const mentoBrokerPoolEntrySchema = z
  .object({
    selfTokenAddress: EvmAddressSchema,
    counterAsset: mentoBrokerPoolCounterAssetSchema,
  })
  .strict();

const mentoBrokerPoolRedemptionParamsSchema = z
  .object({
    kind: z.literal("broker-pool"),
    pools: z.array(mentoBrokerPoolEntrySchema).min(1),
    ...OptionalSourceUrlsFields,
    ...OptionalEvmRpcFields,
  })
  .strict();

// Liquity-v2-fork CDP redemption (GBPm/mento-protocol/bold): capacity reads
// ActivePool debt against the CDP's own token total supply.
const mentoLiquityV2CrRedemptionParamsSchema = z
  .object({
    kind: z.literal("liquity-v2-cr"),
    collateralRegistryAddress: EvmAddressSchema,
    troveManagerAddress: EvmAddressSchema,
    activePoolAddress: EvmAddressSchema,
    tokenAddress: EvmAddressSchema,
    ...OptionalSourceUrlsFields,
    ...OptionalEvmRpcFields,
  })
  .strict();

// Mento V3 FPMM pool (JPYm/CHFm): capacity reads the USDm balance held by the
// pool; the swap fee reads the pool's own lpFee() + protocolFee() basis points.
const mentoFpmmPoolRedemptionParamsSchema = z
  .object({
    kind: z.literal("fpmm-pool"),
    poolAddress: EvmAddressSchema,
    usdmTokenAddress: EvmAddressSchema,
    ...OptionalSourceUrlsFields,
    ...OptionalEvmRpcFields,
  })
  .strict();

const mentoRedemptionParamsSchema = z.discriminatedUnion("kind", [
  mentoBrokerPoolRedemptionParamsSchema,
  mentoLiquityV2CrRedemptionParamsSchema,
  mentoFpmmPoolRedemptionParamsSchema,
]);

const mentoParamsSchema = z
  .object({
    cdpStablecoin: z.enum(["GBPm", "JPYm", "CHFm"]).optional(),
    redemption: mentoRedemptionParamsSchema.optional(),
  })
  .strict();

const sgForgeCoinvertibleParamsSchema = z
  .object({
    coinType: z.enum(["eur", "usd"]).optional(),
  })
  .strict();

const spikoApiParamsSchema = z
  .object({
    shareClassSymbol: z.string(),
    slice: reserveSliceDescriptorSchema,
  })
  .strict();

const unitedPorParamsSchema = z
  .object({
    slice: reserveSliceDescriptorSchema,
  })
  .strict();

const tetherTransparencyParamsSchema = z
  .object({
    currencyIso: z.enum(["usdt", "xaut"]),
    slices: z.array(ReserveSliceSchema).min(1),
  })
  .strict();

const singleAssetParamsSchema = z
  .object({
    label: z.string(),
    ...TrackedExposureFields,
    ...OptionalEvmRpcFields,
    reserveProbe: singleAssetProbeSchema.optional(),
    supplyProbe: singleAssetProbeSchema.optional(),
    timestampProbe: singleAssetProbeSchema.optional(),
    reserveSourceLabel: z.string().optional(),
  })
  .strict();

const parallelizerBalanceAssetSchema = z
  .object({
    ...EvmAddressFields,
    decimals: z.number().int().nonnegative().max(36),
    name: z.string().min(1),
    ...TrackedExposureFields,
  })
  .strict();

const parallelizerBalanceDeploymentSchema = z
  .object({
    chain: z.string().min(1),
    vaultAddress: EvmAddressSchema,
    expectedTokenP: EvmAddressSchema,
    rpcUrl: AbsoluteUrlSchema,
    fallbackRpcUrl: AbsoluteUrlSchema.optional(),
    assets: z.array(parallelizerBalanceAssetSchema).min(1),
  })
  .strict();

const parallelizerBalancesParamsSchema = z
  .object({
    deployments: z.array(parallelizerBalanceDeploymentSchema).min(1).max(8),
    ...RequiredSourceUrlsFields,
    holderEligibility: RedemptionHolderEligibilitySchema.optional(),
    settlementDelaySec: z.number().int().nonnegative().optional(),
  })
  .strict();

const abracadabraCauldronSchema = z
  .object({
    ...EvmAddressFields,
    collateralSymbol: z.string(),
    collateralAddress: EvmAddressSchema,
    collateralDecimals: z.number().int().nonnegative(),
    ...TrackedExposureFields,
    // Reserved for future V2/V3/V4 selector nuance; currently unused by the adapter.
    version: z.union([z.literal(2), z.literal(3), z.literal(4)]).optional(),
  })
  .strict();

const abracadabraParamsSchema = z
  .object({
    ...OptionalEvmRpcFields,
    // BentoBox / DegenBox contract that backs the configured cauldrons. Used to
    // convert per-cauldron `totalCollateralShare` into underlying token amounts
    // via `toAmount(token, share, false)`.
    bentoBoxAddress: EvmAddressSchema,
    cauldrons: z.array(abracadabraCauldronSchema).min(1),
  })
  .strict();

const astherusEarnWrapperParamsSchema = z
  .object({
    earnAddress: EvmAddressSchema,
    expectedUnderlyingAddress: EvmAddressSchema,
    expectedShareAddress: EvmAddressSchema,
    underlyingDecimals: z.number().int().nonnegative().max(36),
    shareDecimals: z.number().int().nonnegative().max(36),
    slice: reserveSliceDescriptorSchema,
    ...OptionalEvmRpcFields,
  })
  .strict();

// A 100% parent-inheritance claim must not be repointable by a catalog edit alone.
// A genuine Initia object migration therefore requires a code change and review.
const initiaWrapperVaultParamsSchema = z
  .object({
    lcdUrl: AbsoluteUrlSchema,
    iusdDenom: z.literal("move/6c69733a9e722f3660afb524f89fce957801fa7e4408b8ef8fe89db9627b570e"),
    iusdMetadataAddress: z.literal("0x6c69733a9e722f3660afb524f89fce957801fa7e4408b8ef8fe89db9627b570e"),
    vaultOwnerAddress: z.literal("0xfd6a07594842ac5d7501ff55243aff06e4f991f320828be05a4590970145e90a"),
    ausd0MetadataAddress: z.literal("0x8078cf9fee50e15069402e9d1d9db70b28fc0d5197d79e8a2b41e2ade432efef"),
    decimals: z.literal(6),
    slice: reserveSliceDescriptorSchema.extend({
      coinId: z.literal("ausd-agora"),
      depType: z.literal("wrapper"),
    }),
  })
  .strict();

const stoneyieldRouterPoolParamsSchema = z
  .object({
    slice: reserveSliceDescriptorSchema,
    stusdAddress: EvmAddressSchema,
    usdcAddress: EvmAddressSchema,
    susdcAddress: EvmAddressSchema,
    routerAddress: EvmAddressSchema,
    venusVaultAddress: EvmAddressSchema,
    venusVTokenAddress: EvmAddressSchema,
    ...OptionalEvmRpcFields,
  })
  .strict();

// XPR Network (Antelope) account reads: token supply from one contract's
// currency stats plus the treasury account's balances on the balance contract.
// Each `slices` entry names one measured balance symbol; anything of the supply
// the measured balances do not cover is published as the configured unknown
// slice with an explicit unknownExposurePct, never silently dropped.
const xprAccountBalanceSliceSchema = z
  .object({
    symbol: z.string().trim().min(1),
    name: z.string(),
    risk: LiveReserveRiskSchema,
  })
  .strict();

const xprAccountBalancesParamsSchema = z
  .object({
    treasuryAccount: z.string().trim().min(1).max(12),
    balanceCode: z.string().trim().min(1).max(12),
    supplyCode: z.string().trim().min(1).max(12),
    supplySymbol: z.string().trim().min(1),
    slices: z.array(xprAccountBalanceSliceSchema).min(1),
    unknownSlice: z
      .object({
        name: z.string(),
        risk: LiveReserveRiskSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((params, ctx) => {
    const symbols = new Set<string>();
    for (const [index, slice] of params.slices.entries()) {
      if (symbols.has(slice.symbol)) {
        ctx.addIssue({
          code: "custom",
          path: ["slices", index, "symbol"],
          message: `duplicate measured symbol "${slice.symbol}"`,
        });
      }
      symbols.add(slice.symbol);
    }
  });

// The Bridge transparency stablecoin key: the final path segment of the
// configured primary URL, e.g. "usd_sui" or "path_usd". The adapter refuses to
// fetch a URL whose slug does not match this identity pin.
const bridgeTransparencyParamsSchema = z
  .object({
    slug: z.string().min(1),
  })
  .strict();

// AUDD's William Buck ASRS 4400 agreed-upon-procedures report: published
// through a static-validated / issuer-attested descriptor (the engagement is
// explicitly not an assurance engagement).
const auddAssuranceParamsSchema = z
  .object({
    product: z.literal("AUDD"),
    profile: z.literal("audd-v1"),
    ...assuranceParamsShape,
  })
  .strict();

// Anchorage-published Deloitte attestation reports; reviewed products only.
const anchorageAssuranceParamsSchema = z.discriminatedUnion("product", [
  z
    .object({
      product: z.literal("USAT"),
      profile: z.literal("usat-v1"),
      ...assuranceParamsShape,
    })
    .strict(),
  z
    .object({
      product: z.literal("USDPT"),
      profile: z.literal("usdpt-v1"),
      ...assuranceParamsShape,
    })
    .strict(),
]);

// Baker Tilly's monthly CADD CSAE 3000 report: the index links Google Drive
// share URLs, so reportHosts pins both the drive.google.com share host and the
// drive.usercontent.google.com host the direct download redirects to.
const caddAssuranceParamsSchema = z
  .object({
    product: z.literal("CADD"),
    profile: z.literal("cadd-v1"),
    ...assuranceParamsShape,
  })
  .strict();

// Hash-pinned issuer-signed reserve reports (Fact Finance BRLV PoR memo and
// Catena Digital AUDM issuer-CEO attestation): non-independent, so they share a
// static-validated / issuer-attested sibling descriptor.
const issuerAttestedReportParamsSchema = z.discriminatedUnion("product", [
  z
    .object({
      product: z.literal("BRLV"),
      profile: z.literal("brlv-v1"),
      ...assuranceParamsShape,
    })
    .strict(),
  z
    .object({
      product: z.literal("AUDM"),
      profile: z.literal("audm-v1"),
      ...assuranceParamsShape,
    })
    .strict(),
]);

// BRLA: Notion-hosted transparency index; runtime resolves the reviewed UHY
// report through pinned loadPageChunk/getSignedFileUrls block identity.
const brlaAssuranceParamsSchema = z
  .object({
    product: z.literal("BRLA"),
    profile: z.literal("brla-v1"),
    ...assuranceParamsShape,
  })
  .strict();

// AUSD: Fern-hosted Agora transparency index; runtime verifies the reviewed
// July report path hash on the index and fetches the stable Fern mirror.
const agoraAssuranceParamsSchema = z
  .object({
    product: z.literal("AUSD"),
    profile: z.literal("ausd-v1"),
    ...assuranceParamsShape,
  })
  .strict();

// FIDD: Fidelity Digital Assets transparency index; runtime resolves the
// reviewed July Widen viewer link and its original PDF download anchor.
const fiddAssuranceParamsSchema = z
  .object({
    product: z.literal("FIDD"),
    profile: z.literal("fidd-v1"),
    ...assuranceParamsShape,
  })
  .strict();

// SBC: Brale SBC transparency index with direct monthly PDF links.
const sbcAssuranceParamsSchema = z
  .object({
    product: z.literal("SBC"),
    profile: z.literal("sbc-v1"),
    ...assuranceParamsShape,
  })
  .strict();

// First Digital's AOGB ISAE 3000 reports: the issuer domain blocks Cloudflare
// Worker egress, so discovery pins the issuer's Webflow mirror index and the
// Webflow CDN host serving the PDFs.
const fdusdAssuranceParamsSchema = z
  .object({
    product: z.literal("FDUSD"),
    profile: z.literal("fdusd-v1"),
    ...assuranceParamsShape,
  })
  .strict();

const mocDocParamsSchema = z.object({ rpcUrl: AbsoluteUrlSchema }).strict();

// Kerne's hourly EIP-191-signed proof of reserves: the adapter verifies the
// signature against the pinned `signerAddress` and cross-checks the combined
// USDC balance at the configured PSM contracts on Base. The issuer publishes
// `_meta.stale_threshold_seconds = 7800`, so an attestation older than that is
// stale rather than merely old.
const KERNE_ATTESTATION_MAX_AGE_SEC = 7_800;

const kerneSignedPorParamsSchema = z
  .object({
    signerAddress: EvmAddressSchema,
    psmAddresses: z.array(EvmAddressSchema).min(1),
  })
  .strict();

// Djed (Cardano) bank read: the ADA reserve, the unissued DJED stock, and the
// pool marker NFT live in the single bank script address; `asset_info`
// supplies the (fixed) minted supplies so circulating DJED = minted - bank
// stock. The SHEN unit is optional diagnostics (junior equity), not a slice.
const cardanoUnitSchema = z
  .object({
    policyId: z.string().regex(/^[0-9a-f]{56}$/i),
    assetNameHex: z.string().regex(/^[0-9a-f]+$/i).min(1),
    decimals: z.number().int().nonnegative().max(36),
  })
  .strict();

const djedCardanoParamsSchema = z
  .object({
    bankAddress: z.string().trim().regex(/^addr1[a-z0-9]+$/),
    djedUnit: cardanoUnitSchema,
    shenUnit: cardanoUnitSchema.optional(),
  })
  .strict();

// DGLD's Gold Token SA bar registry emits a single allocated-PAMP-gold slice
// (untracked-exogenous-asset, no coinId), so params carry only the reviewed
// slice identity; the reserve-oz / supply ratio is measured from the registry.
const dgldGoldMapperParamsSchema = z
  .object({
    label: z.string(),
    risk: LiveReserveRiskSchema,
  })
  .strict();

// Matrixdock XAGm FallbackReserveFeed: an issuer-transmitted on-chain silver
// reserve. The slice is physical silver (no tracked coinId), so params pin the
// two Ethereum contracts plus the Sui coin type whose supply completes the
// cross-chain liability denominator.
const matrixdockFrsParamsSchema = z
  .object({
    label: z.string(),
    risk: LiveReserveRiskSchema,
    feedAddress: EvmAddressSchema,
    tokenAddress: EvmAddressSchema,
    suiCoinType: z.string().min(1),
    ...OptionalEvmRpcFields,
  })
  .strict();

// Gold DAO GLDT: a single allocated-gold slice whose reserve mass is measured
// on-chain as the swap canister's locked GLD NFT balances (gram-denominated
// via each canister's `division`) against the ICRC-1 GLDT ledger supply. The
// swap and ledger canisters are pinned; the NFT canisters are read from
// `get_swap_configs` at runtime.
const icpGldtParamsSchema = z
  .object({
    swapCanisterId: IcpCanisterIdSchema,
    ledgerCanisterId: IcpCanisterIdSchema,
    label: z.string(),
    risk: LiveReserveRiskSchema,
  })
  .strict();

// AFI aggregate proof-of-reserves envelope: the proof verifies only aggregate
// reserve/liability totals, so the params pin the expected feed symbol and the
// adapter refuses payloads that carry a different symbol.
const afiProofParamsSchema = z
  .object({
    symbol: z.string().min(1),
  })
  .strict();

export const LIVE_RESERVE_ADAPTER_DESCRIPTOR_DECLARATIONS = {
  "hylo-solana": {
    primaryInputKinds: ["onchain-solana"],
    paramsSchema: hyloSolanaParamsSchema,
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sourceOriginClass: "onchain-observation",
    preferredFreshnessMode: "not-applicable",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: LATEST_STATE_VALIDATION,
  },
  "3jane-usd3": {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: noParamsSchema,
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "direct", fee: "current-bps" },
    validation: LATEST_STATE_VALIDATION,
  },
  abracadabra: {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: abracadabraParamsSchema,
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    provenance: {
      status: "retired",
      rationale:
        "MIM entered the frozen archive on 2026-07-26 after its terminal depeg; retain the adapter only for historical review and re-evaluate if the protocol resumes active issuance.",
      parkedSince: "2026-07-26",
      nextReview: "2027-01-26",
    },
    validation: LATEST_STATE_WITH_UNKNOWN_CAP_VALIDATION,
  },
  "anchorage-independent-assurance": declareAdapter(
    anchorageAssuranceParamsSchema,
    HTTP_DISCLOSURE_ATTESTATION_V2,
  ),
  accountable: {
    primaryInputKinds: ["http-json"],
    paramsSchema: accountableParamsSchema,
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    preferredFreshnessMode: "verified",
    sharedSourceMode: "none",
    configValidation: CONFIG_ACCOUNTABLE,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: DASHBOARD_VALIDATION,
  },
  "agora-independent-assurance": declareAdapter(agoraAssuranceParamsSchema, HTTP_DISCLOSURE_ATTESTATION_V2),
  "anzen-usdz": declareAdapter(noParamsSchema, ONCHAIN_SINGLE_ASSET_V2, {
    sourceOriginClass: "onchain-observation",
  }),
  "moc-doc": declareAdapter(mocDocParamsSchema, ONCHAIN_SINGLE_ASSET_V1, {
    sourceOriginClass: "onchain-observation",
  }),
  "moc-v3-buckets": {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: mocV3BucketsParamsSchema,
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sourceOriginClass: "onchain-observation",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V2,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: LATEST_STATE_VALIDATION,
  },
  "astherus-earn-wrapper": declareAdapter(astherusEarnWrapperParamsSchema, ONCHAIN_SINGLE_ASSET_V1, {
    // asUSDF withdrawals are delayed rather than provably immediate, so the
    // net USDF balance backing the shares is composition evidence, not capacity.
    redemptionTelemetry: { capacity: "none", fee: "none" },
  }),
  "attestation-pdf-index": {
    primaryInputKinds: ["http-html"],
    paramsSchema: attestationPdfIndexParamsSchema,
    sourceModel: "validated-static",
    evidenceClass: "static-validated",
    sharedSourceMode: "none",
    configValidation: CONFIG_ATTESTATION_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: MONTHLY_VERIFIED_VALIDATION,
  },
  "audd-independent-assurance": declareAdapter(
    auddAssuranceParamsSchema,
    HTTP_DISCLOSURE_ATTESTATION_V2,
    {
      // ASRS 4400 agreed-upon procedures: the report explicitly disclaims an
      // assurance opinion, so the evidence class stays static-validated with
      // issuer-attested origin instead of the independent class.
      sourceModel: "validated-static",
      evidenceClass: "static-validated",
      sourceOriginClass: "issuer-attested",
    },
  ),
  "audx-independent-assurance": declareAdapter(
    audxAssuranceParamsSchema,
    HTTP_DISCLOSURE_ATTESTATION_V2,
  ),
  "blast-usdb-yield-manager": {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: blastUsdbYieldManagerParamsSchema,
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_SINGLE_ASSET_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: LATEST_STATE_VALIDATION,
  },
  "brla-independent-assurance": declareAdapter(brlaAssuranceParamsSchema, HTTP_DISCLOSURE_ATTESTATION_V2, {
    // BRLA's official report index is Notion's loadPageChunk/getSignedFileUrls
    // JSON record maps, not a server-rendered HTML page.
    primaryInputKinds: ["http-json"],
  }),
  "cadd-independent-assurance": declareAdapter(caddAssuranceParamsSchema, HTTP_DISCLOSURE_ATTESTATION_V2),
  // Live issuer balance-sheet feed (cash + Treasury vs on-chain liability) with
  // measured composition and a verified observation timestamp. The evidence
  // class mirrors the frax-balance-sheet / tether-transparency issuer
  // balance-sheet precedent: independent *measurement* of an issuer-published
  // feed, not third-party assurance, hence the issuer-attested origin class.
  "bridge-transparency": {
    primaryInputKinds: ["http-json"],
    paramsSchema: bridgeTransparencyParamsSchema,
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    preferredFreshnessMode: "verified",
    sourceOriginClass: "issuer-attested",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: DASHBOARD_VALIDATION,
  },
  btcfi: {
    primaryInputKinds: ["http-json"],
    paramsSchema: btcfiParamsSchema,
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: LATEST_STATE_VALIDATION,
  },
  "cap-vault": {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: capVaultParamsSchema,
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_PROTOCOL_V1,
    redemptionTelemetry: { capacity: "direct", fee: "current-bps" },
    validation: LATEST_STATE_VALIDATION,
  },
  "chainlink-nav": {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: chainlinkNavParamsSchema,
    sourceModel: "single-bucket",
    // P5: native fund-share exposure only; portfolio scope emits a scoring-degraded warning.
    evidenceClass: "independent",
    preferredFreshnessMode: "verified",
    sharedSourceMode: "none",
    configValidation: CONFIG_SINGLE_ASSET_V1_V2,
    // Redemption capacity is emitted only for coins whose params carry a
    // redemptionCapacity block (currently OUSG); plain NAV-feed coins never
    // emit and are not unused-telemetry candidates.
    redemptionTelemetry: { capacity: "direct", capacityParamsGated: true, fee: "none" },
    validation: TIMESTAMPED_FEED_VALIDATION,
  },
  "chronicle-nav": {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: chronicleNavParamsSchema,
    sourceModel: "single-bucket",
    // P5: native fund-share exposure only (ACRDX/STAC/BUIDL); portfolio scope
    // emits a scoring-degraded warning like chainlink-nav.
    evidenceClass: "independent",
    sourceOriginClass: "independent-assurance",
    sharedSourceMode: "none",
    configValidation: CONFIG_SINGLE_ASSET_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: VERIFIED_ONLY_VALIDATION,
  },
  "chainlink-por": {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: chainlinkPorParamsSchema,
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_ATTESTATION_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: VERIFIED_ONLY_VALIDATION,
  },
  "circle-transparency": declareAdapter(
    circleTransparencyParamsSchema,
    HTTP_DISCLOSURE_ATTESTATION_V1,
    {
      preferredFreshnessMode: "verified",
      validation: {
        // Circle publishes the reserve chart weekly, not on its monthly assurance cadence.
        maxSourceAgeSec: WEEKLY_SOURCE_MAX_AGE_SEC,
        allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
      },
    },
  ),
  "collateral-positions-api": {
    primaryInputKinds: ["http-json"],
    paramsSchema: collateralPositionsParamsSchema,
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1_V2,
    // Capacity is emitted only when a coin opts into either the legacy
    // single-bridge probe or the identity-gated bridge-basket probe.
    redemptionTelemetry: { capacity: "direct", capacityParamsGated: true, fee: "none" },
    validation: {
      maxUnknownExposurePct: MATERIAL_UNKNOWN_EXPOSURE_PCT,
      // Complete position pricing dates the observation (verified); a partial
      // price set stays unverified; a payload without any price timestamp is
      // latest-state.
      allowedFreshnessModes: ANY_FRESHNESS,
    },
  },
  crvusd: {
    primaryInputKinds: ["http-json", "onchain-evm"],
    paramsSchema: noParamsSchema,
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    preferredFreshnessMode: "not-applicable",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V2_V3_V4,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: TIMESTAMPLESS_WITH_UNKNOWN_CAP_VALIDATION,
  },
  "curated-validated": {
    primaryInputKinds: ["onchain-evm", "onchain-solana"],
    paramsSchema: curatedValidatedParamsSchema,
    sourceModel: "validated-static",
    evidenceClass: "static-validated",
    sharedSourceMode: "none",
    configValidation: CONFIG_CURATED_VALIDATED,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    // Curated composition is reviewer-owned and does not age; the same-run
    // supply/redemption reads are latest-state, so no source timestamp exists.
    validation: LATEST_STATE_VALIDATION,
  },
  "usdai-hub": declareAdapter(usdaiHubParamsSchema, ONCHAIN_SINGLE_ASSET_V1, {
    sourceOriginClass: "onchain-observation",
    redemptionTelemetry: { capacity: "direct", fee: "current-bps" },
  }),
  "dola-inverse": {
    primaryInputKinds: ["http-json"],
    paramsSchema: noParamsSchema,
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    preferredFreshnessMode: "verified",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    // The adapter reads the Inverse PSM's own supply() and the sUSDS vault's
    // maxWithdraw() for it, which the DOLA -> USDS sell is paid out of, so
    // capacity is a direct measurement rather than a proxy for FiRM collateral.
    redemptionTelemetry: { capacity: "direct", fee: "current-bps" },
    validation: DASHBOARD_VALIDATION,
  },
  "erc4626-single-asset": declareAdapter(erc4626SingleAssetParamsSchema, ONCHAIN_SINGLE_ASSET_V1, {
    redemptionTelemetry: { capacity: "direct", fee: "current-bps" },
  }),
  "escrow-balance": declareAdapter(escrowBalanceParamsSchema, ONCHAIN_SINGLE_ASSET_V1, {
    // The single read or bounded all-or-nothing sum measures the escrow or
    // issuance state the redemption is actually paid against, so the result is
    // direct capacity rather than a backing proxy.
    redemptionTelemetry: { capacity: "direct", fee: "none" },
  }),
  ethena: declareAdapter(noParamsSchema, HTTP_DASHBOARD_COLLATERAL_V1, {
    // The adapter reads the EthenaMinting contract's own USDT/USDC balances,
    // which redemptions are paid out of, so capacity is a direct measurement
    // rather than a proxy for the collateral basket.
    redemptionTelemetry: { capacity: "direct", fee: "none" },
  }),
  "ethena-whitelabel": {
    primaryInputKinds: ["http-json"],
    paramsSchema: ethenaWhitelabelParamsSchema,
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    preferredFreshnessMode: "verified",
    sourceOriginClass: "issuer-attested",
    displayBadgeKind: "proof",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: DASHBOARD_WITH_UNKNOWN_CAP_VALIDATION,
  },
  "evm-branch-balances": {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: evmBranchBalancesParamsSchema,
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "direct", capacityParamsGated: true, fee: "current-bps" },
    validation: LATEST_STATE_VALIDATION,
  },
  "parallelizer-balances": {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: parallelizerBalancesParamsSchema,
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "direct", fee: "none" },
    validation: LATEST_STATE_WITH_UNKNOWN_CAP_VALIDATION,
  },
  "europ-independent-assurance": declareAdapter(
    europAssuranceParamsSchema,
    HTTP_DISCLOSURE_ATTESTATION_V2,
    {
      validation: {
        // Schuman's reviewed reports are quarterly; allow 100 days, not the legacy 116-day override.
        maxSourceAgeSec: QUARTERLY_ASSURANCE_MAX_AGE_SEC,
        allowedFreshnessModes: VERIFIED_ONLY_FRESHNESS,
      },
    },
  ),
  "xdai-bridge": {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: xdaiBridgeParamsSchema,
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sourceOriginClass: "onchain-observation",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: LATEST_STATE_VALIDATION,
  },
  "xpr-account-balances": {
    primaryInputKinds: ["http-json"],
    paramsSchema: xprAccountBalancesParamsSchema,
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sourceOriginClass: "onchain-observation",
    preferredFreshnessMode: "not-applicable",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: LATEST_STATE_WITH_UNKNOWN_CAP_VALIDATION,
  },
  falcon: declareAdapter(noParamsSchema, HTTP_DASHBOARD_COLLATERAL_V1, {
    redemptionTelemetry: { capacity: "proxy", fee: "none" },
  }),
  "fdusd-independent-assurance": declareAdapter(fdusdAssuranceParamsSchema, HTTP_DISCLOSURE_ATTESTATION_V2),
  "fdusd-transparency": declareAdapter(noParamsSchema, HTTP_DISCLOSURE_ATTESTATION_V1, {
    preferredFreshnessMode: "verified",
    provenance: {
      status: "retired",
      rationale:
        "Superseded by the compiled AOGB assurance manifest (fdusd-independent-assurance); retain the adapter only for historical review of the pre-compiled signed-report era.",
      parkedSince: "2026-09-09",
      nextReview: "2027-03-09",
    },
    validation: {
      maxSourceAgeSec: LATE_MONTHLY_DISCLOSURE_SOURCE_MAX_AGE_SEC,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  }),
  "fidd-independent-assurance": declareAdapter(fiddAssuranceParamsSchema, HTTP_DISCLOSURE_ATTESTATION_V2),
  "flying-tulip-ftusd": {
    primaryInputKinds: ["http-json"],
    paramsSchema: noParamsSchema,
    sourceModel: "dynamic-mix",
    evidenceClass: "weak-live-probe",
    sourceOriginClass: "issuer-attested",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
      maxUnknownExposurePct: 0,
      allowedFreshnessModes: VERIFIED_ONLY_FRESHNESS,
    },
  },
  "frax-balance-sheet": {
    primaryInputKinds: ["http-json"],
    paramsSchema: noParamsSchema,
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    preferredFreshnessMode: "verified",
    sourceOriginClass: "issuer-attested",
    displayBadgeKind: "proof",
    sharedSourceMode: "none",
    configValidation: CONFIG_ATTESTATION_V1_V2,
    redemptionTelemetry: { capacity: "proxy", fee: "none" },
    validation: DASHBOARD_WITH_UNKNOWN_CAP_VALIDATION,
  },
  "frax-fpi-collateral": {
    primaryInputKinds: ["http-json"],
    paramsSchema: fraxFpiCollateralParamsSchema,
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    preferredFreshnessMode: "verified",
    sourceOriginClass: "issuer-attested",
    displayBadgeKind: "proof",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "proxy", fee: "none" },
    validation: DASHBOARD_WITH_UNKNOWN_CAP_VALIDATION,
  },
  fx: {
    primaryInputKinds: ["http-json", "onchain-evm"],
    paramsSchema: fxParamsSchema,
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    preferredFreshnessMode: "not-applicable",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "proxy", fee: "none" },
    validation: {
      maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
      allowedFreshnessModes: UNVERIFIED_OR_NOT_APPLICABLE_FRESHNESS,
    },
  },
  "gemini-independent-assurance": declareAdapter(noParamsSchema, HTTP_DISCLOSURE_ATTESTATION_V2, {
    // Gemini's /dollar attestation list loads from its public Contentful
    // delivery collection (content_type=gusdAttestation), so the reviewed
    // official index is JSON rather than server-rendered HTML.
    primaryInputKinds: ["http-json"],
  }),
  "sodax-sonic": {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: noParamsSchema,
    sourceModel: "dynamic-mix",
    evidenceClass: "weak-live-probe",
    sourceOriginClass: "onchain-observation",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: LATEST_STATE_WITH_UNKNOWN_CAP_VALIDATION,
  },
  gho: {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: ghoParamsSchema,
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_PROTOCOL_V2,
    redemptionTelemetry: { capacity: "direct", fee: "current-bps" },
    validation: LATEST_STATE_VALIDATION,
  },
  "hive-hbd-protocol": {
    primaryInputKinds: ["http-json"],
    paramsSchema: hiveHbdProtocolParamsSchema,
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sourceOriginClass: "onchain-observation",
    sharedSourceMode: "none",
    configValidation: CONFIG_PROTOCOL_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: LATEST_STATE_VALIDATION,
  },
  "idle-cdo-epoch-variant": {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: idleCdoEpochVariantParamsSchema,
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sourceOriginClass: "onchain-observation",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    // The vault's exit is a monthly epoch redemption whose stressed depth is
    // not observable on-chain; publishing capacity from NAV would fabricate it.
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: LATEST_STATE_VALIDATION,
  },
  infinifi: declareAdapter(noParamsSchema, HTTP_DASHBOARD_COLLATERAL_V1, {
    redemptionTelemetry: { capacity: "proxy", fee: "none" },
    validation: {
      // The transparency dashboard's siUSD rate-history snapshotter writes on
      // a 2-hour cadence (I2); 6h admits three missed writes before the
      // snapshot reads as stale, replacing the generic 3-day dashboard cap.
      maxSourceAgeSec: 6 * 60 * 60,
      maxUnknownExposurePct: MATERIAL_UNKNOWN_EXPOSURE_PCT,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  }),
  "initia-wrapper-vault": {
    primaryInputKinds: ["http-json"],
    paramsSchema: initiaWrapperVaultParamsSchema,
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sourceOriginClass: "onchain-observation",
    sharedSourceMode: "none",
    configValidation: CONFIG_SINGLE_ASSET_V1,
    // Initia has no EVM read path, so the vault balance is read over the chain's
    // LCD; the wrapper has no published redemption terms, so no capacity.
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: LATEST_STATE_VALIDATION,
  },
  "issuer-attested-report": declareAdapter(
    issuerAttestedReportParamsSchema,
    HTTP_DISCLOSURE_ATTESTATION_V2,
    {
      // Hash-pinned issuer-signed reports (BRLV Fact Finance PoR memo, AUDM
      // issuer-CEO attestation): non-independent tiers, so the evidence class
      // stays static-validated with issuer-attested origin.
      sourceModel: "validated-static",
      evidenceClass: "static-validated",
      sourceOriginClass: "issuer-attested",
    },
  ),
  jupusd: {
    primaryInputKinds: ["http-json"],
    paramsSchema: jupusdParamsSchema,
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    preferredFreshnessMode: "verified",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "direct", fee: "none" },
    validation: DASHBOARD_VALIDATION,
  },
  "kava-cdp": {
    primaryInputKinds: ["http-json"],
    paramsSchema: noParamsSchema,
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sourceOriginClass: "onchain-observation",
    preferredFreshnessMode: "not-applicable",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    // The legacy CDP's exit is borrower repay-only (no holder-facing
    // redemption route), so capacity/fee telemetry would fabricate a route.
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: LATEST_STATE_WITH_UNKNOWN_CAP_VALIDATION,
  },
  "hliquity-hedera": {
    primaryInputKinds: ["http-json"],
    paramsSchema: noParamsSchema,
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sourceOriginClass: "onchain-observation",
    preferredFreshnessMode: "not-applicable",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    // Holder-facing Liquity-style redemptions exist, but the redemption fee
    // (baseRate + 0.5%) is not read, so fee telemetry is omitted.
    redemptionTelemetry: { capacity: "direct", fee: "none" },
    validation: LATEST_STATE_VALIDATION,
  },
  "kerne-signed-por": {
    primaryInputKinds: ["http-json"],
    paramsSchema: kerneSignedPorParamsSchema,
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    preferredFreshnessMode: "verified",
    sourceOriginClass: "onchain-observation",
    sharedSourceMode: "none",
    configValidation: CONFIG_SINGLE_ASSET_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    provenance: {
      status: "staged",
      rationale: "bound to pre-launch kusd-kerne; activates at launch",
      parkedSince: "2026-09-09",
      nextReview: "2027-03-09",
    },
    validation: {
      maxSourceAgeSec: KERNE_ATTESTATION_MAX_AGE_SEC,
      allowedFreshnessModes: VERIFIED_ONLY_FRESHNESS,
    },
  },
  "krwq-custodian": {
    primaryInputKinds: ["http-json"],
    paramsSchema: noParamsSchema,
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    preferredFreshnessMode: "verified",
    sourceOriginClass: "onchain-observation",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: DASHBOARD_WITH_UNKNOWN_CAP_VALIDATION,
  },
  "liquity-v1": declareAdapter(liquityV1ParamsSchema, ONCHAIN_SINGLE_ASSET_V2),
  "liquity-native-active-pool": {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: liquityNativeActivePoolParamsSchema,
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "direct", fee: "current-bps" },
    validation: LATEST_STATE_VALIDATION,
  },
  "liquity-v2-branches": {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: liquityV2BranchesParamsSchema,
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1_V2,
    redemptionTelemetry: { capacity: "direct", fee: "current-bps" },
    validation: LATEST_STATE_VALIDATION,
  },
  m0: {
    primaryInputKinds: ["http-json"],
    paramsSchema: noParamsSchema,
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    preferredFreshnessMode: "verified",
    sharedSourceMode: "source-invariant",
    configValidation: CONFIG_PROTOCOL_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: DASHBOARD_VALIDATION,
  },
  "m0-wrapper-underlying": declareAdapter(m0WrapperUnderlyingParamsSchema, ONCHAIN_SINGLE_ASSET_V1),
  "makina-strategy": {
    primaryInputKinds: ["http-json"],
    paramsSchema: makinaStrategyParamsSchema,
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    preferredFreshnessMode: "verified",
    sourceOriginClass: "issuer-attested",
    displayBadgeKind: "proof",
    sharedSourceMode: "none",
    // v2: position rows missing `updated_at` now degrade the snapshot instead
    // of publishing unbounded position-accounting freshness.
    configValidation: CONFIG_COLLATERAL_V1_V2,
    redemptionTelemetry: { capacity: "proxy", fee: "none" },
    validation: {
      maxSourceAgeSec: MAKINA_POSITION_SOURCE_MAX_AGE_SEC,
      maxUnknownExposurePct: MATERIAL_UNKNOWN_EXPOSURE_PCT,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  },
  "megausd-custody": {
    primaryInputKinds: ["http-json"],
    paramsSchema: noParamsSchema,
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    preferredFreshnessMode: "verified",
    sourceOriginClass: "issuer-attested",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: DASHBOARD_VALIDATION,
  },
  mento: {
    primaryInputKinds: ["http-json"],
    paramsSchema: mentoParamsSchema,
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    preferredFreshnessMode: "verified",
    // Per-coin on-chain redemption reads (broker-pool/liquity-v2-cr/fpmm-pool)
    // make the adapter's output coin-specific, so results can no longer be
    // shared across coins within a run.
    sharedSourceMode: "none",
    // v2: a dashboard payload without per-stablecoin `cdp_backings` totals
    // degrades the snapshot instead of silently skipping the coherence gate.
    configValidation: CONFIG_COLLATERAL_V1_V2,
    redemptionTelemetry: { capacity: "direct", fee: "current-bps" },
    validation: DASHBOARD_VALIDATION,
  },
  "money-llamma": {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: noParamsSchema,
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    preferredFreshnessMode: "not-applicable",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: LATEST_STATE_WITH_UNKNOWN_CAP_VALIDATION,
  },
  "nest-vault-positions": {
    primaryInputKinds: ["http-json"],
    paramsSchema: nestVaultPositionsParamsSchema,
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: DASHBOARD_VERIFIED_VALIDATION,
  },
  "openeden-usdo": {
    primaryInputKinds: ["http-json"],
    paramsSchema: noParamsSchema,
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    preferredFreshnessMode: "verified",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "direct", fee: "none" },
    provenance: {
      status: "parked",
      rationale:
        "Re-enable probe (2026-08-13) confirmed the issuer gateway serves ordinary clients, but the first production cron (2026-08-14) received HTTP 500 on every Worker fetch strategy; re-parked until OpenEden unblocks Cloudflare Worker egress.",
      parkedSince: "2026-08-14",
      nextReview: "2027-02-14",
    },
    validation: DASHBOARD_VALIDATION,
  },
  "origin-vault-balances": {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: originVaultBalancesParamsSchema,
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "direct", fee: "none" },
    validation: LATEST_STATE_VALIDATION,
  },
  "quantoz-transparency": declareAdapter(
    quantozTransparencyParamsSchema,
    HTTP_DISCLOSURE_ATTESTATION_V1,
  ),
  "re-metrics": {
    primaryInputKinds: ["http-html"],
    paramsSchema: noParamsSchema,
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    preferredFreshnessMode: "verified",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "direct", fee: "none" },
    validation: DASHBOARD_VALIDATION,
  },
  "resupply-pairs": {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: resupplyPairsParamsSchema,
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "direct", fee: "none" },
    validation: LATEST_STATE_VALIDATION,
  },
  "reserve-protocol-dtf": {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: reserveProtocolDtfParamsSchema,
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    preferredFreshnessMode: "not-applicable",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "direct", fee: "none" },
    validation: LATEST_STATE_VALIDATION,
  },
  reservoir: {
    primaryInputKinds: ["http-json"],
    paramsSchema: noParamsSchema,
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    freshnessLimitation: "The reserve balance-sheet API publishes no accounting timestamp; same-run PSM reads date redemption liquidity, not the reserve book.",
    sharedSourceMode: "source-invariant",
    configValidation: CONFIG_PROTOCOL_V1,
    // Capacity comes from a same-run read of the terminal USDC PSM balance, not
    // from the balance-sheet payload; the adapter withholds the redemption
    // block entirely when that read fails. The fee is the SavingModule's
    // MANAGER-settable redeemFee(), read in the same run because no static
    // bound is defensible.
    redemptionTelemetry: { capacity: "direct", fee: "current-bps" },
    validation: DASHBOARD_WITH_UNKNOWN_CAP_VALIDATION,
  },
  "ripple-transparency": {
    primaryInputKinds: ["http-html"],
    paramsSchema: noParamsSchema,
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_ATTESTATION_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: MONTHLY_VERIFIED_VALIDATION,
  },
  "sgforge-coinvertible": {
    primaryInputKinds: ["http-html"],
    paramsSchema: sgForgeCoinvertibleParamsSchema,
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    preferredFreshnessMode: "verified",
    sharedSourceMode: "none",
    configValidation: CONFIG_ATTESTATION_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: DISCLOSURE_VALIDATION,
  },
  "saturn-pyusdx": declareAdapter(saturnPyusdxParamsSchema, ONCHAIN_SINGLE_ASSET_V1, {
    sourceOriginClass: "onchain-observation",
  }),
  "sbc-independent-assurance": declareAdapter(sbcAssuranceParamsSchema, HTTP_DISCLOSURE_ATTESTATION_V2),
  "solstice-attestation": declareAdapter(noParamsSchema, HTTP_PROTOCOL_V1, {
    validation: {
      // Weekly attestations with observed publication gaps of 5-9 days (SO1);
      // 14 days admits two missed weekly attestations before the proof reads
      // as stale, replacing the 700,000s (8.10d) cap that sat seconds away
      // from the real gap.
      maxSourceAgeSec: 1_209_600,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  }),
  "single-asset": {
    primaryInputKinds: ["http-json", "onchain-evm"],
    paramsSchema: singleAssetParamsSchema,
    sourceModel: "single-bucket",
    evidenceClass: "weak-live-probe",
    sharedSourceMode: "none",
    configValidation: CONFIG_SINGLE_ASSET_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    // The http-json probe emits verified or unverified depending on whether the
    // upstream carries a timestamp; the on-chain probe is latest-state.
    validation: { allowedFreshnessModes: ANY_FRESHNESS },
  },
  "sky-makercore": {
    primaryInputKinds: ["http-json"],
    paramsSchema: noParamsSchema,
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    preferredFreshnessMode: "verified",
    sharedSourceMode: "source-invariant",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "direct", fee: "none" },
    validation: DASHBOARD_WITH_UNKNOWN_CAP_VALIDATION,
  },
  "solomon-protocol": {
    primaryInputKinds: ["http-json"],
    paramsSchema: noParamsSchema,
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    preferredFreshnessMode: "verified",
    sourceOriginClass: "issuer-attested",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: DASHBOARD_WITH_UNKNOWN_CAP_VALIDATION,
  },

  "spiko-api": {
    primaryInputKinds: ["http-json"],
    paramsSchema: spikoApiParamsSchema,
    sourceModel: "single-bucket",
    // P5: independent admission is limited to the named native fund-share exposure.
    evidenceClass: "independent",
    sourceOriginClass: "issuer-attested",
    sharedSourceMode: "none",
    configValidation: CONFIG_SINGLE_ASSET_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      maxSourceAgeSec: BUSINESS_DAY_NAV_SOURCE_MAX_AGE_SEC,
      allowedFreshnessModes: VERIFIED_ONLY_FRESHNESS,
    },
  },
  "stoneyield-router-pool": declareAdapter(stoneyieldRouterPoolParamsSchema, ONCHAIN_SINGLE_ASSET_V1, {
    // stUSD's exit is `needs-research`/`capacity-unpublished` and there is no
    // public unwrap, so no capacity may be published from the pool read.
    redemptionTelemetry: { capacity: "none", fee: "none" },
    provenance: {
      status: "staged",
      rationale:
        "On-chain evidence contradicts the reviewed 100% USDC sidecar row, so the adapter must not publish yet. At BSC block 119927831 SUSDC.getProtocolStats reported totalSupply 10,020,010, totalUSDCDeposited 10, totalRewardsDistributed 10,020,000 and contractUSDCBalance 0.05; the only observed USDC egress is 4.95 (block 69663673) plus 5 (block 69664002), both to StrategyRouter 0x563f48aAD50a75Ef3662827a4d536dbd46aBb5a2, which is the sole active full-weight strategy, and the Venus look-through adds 5.098725768562729 to 4.95 idle. Against STUSD supply 2,894,743.271428093 that is coverage 0.0000034886429716375584. Park until reserve-composition curation resolves the contradiction; review when verified backing or corrected supply evidence exists.",
      parkedSince: "2026-09-04",
      nextReview: "2026-12-04",
    },
  }),

  "superstate-liquidity": {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: superstateLiquidityParamsSchema,
    sourceModel: "single-bucket",
    // P5: USTB's single slice names the fund share, not its underlying securities.
    evidenceClass: "independent",
    preferredFreshnessMode: "verified",
    sharedSourceMode: "none",
    configValidation: CONFIG_SINGLE_ASSET_V1,
    redemptionTelemetry: { capacity: "direct", fee: "none" },
    validation: TIMESTAMPED_FEED_VALIDATION,
  },
  "paxos-independent-assurance": declareAdapter(paxosAssuranceParamsSchema, HTTP_DISCLOSURE_ATTESTATION_V2, {
    // PAXG/PYUSD/USDG/USDP resolve through the same paxos.com Framer site and
    // the identical script_main module, so one run's fetched payloads are
    // valid for every product; per-product index/page/PDF URLs still differ
    // and stay per-coin.
    sharedSourceMode: "source-invariant",
  }),
  "straitsx-independent-assurance": declareAdapter(
    straitsxAssuranceParamsSchema,
    HTTP_DISCLOSURE_ATTESTATION_V2,
  ),
  "river-protocol-info": declareAdapter(noParamsSchema, HTTP_PROTOCOL_V1, {
    redemptionTelemetry: { capacity: "direct", fee: "current-bps" },
  }),
  // NOTE(owner-review): evidenceClass "independent" mirrors the frax-balance-sheet
  // issuer-balance-sheet precedent (live total assets/liabilities + freshness,
  // configured static composition), but the totals here are Tether's own
  // self-published transparency.json rather than a third-party-audited feed.
  // Flagged for owner review of whether this should instead be "static-validated".
  "tether-transparency": {
    primaryInputKinds: ["http-json"],
    paramsSchema: tetherTransparencyParamsSchema,
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    preferredFreshnessMode: "verified",
    sourceOriginClass: "issuer-attested",
    displayBadgeKind: "proof",
    sharedSourceMode: "source-invariant",
    configValidation: CONFIG_ATTESTATION_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    // Measured 2026-08-25: 24 upstream publications in the retained 30-day
    // window (last 2026-08-21T23:30:02Z; the breach was detected at
    // 2026-08-25T00:11:34Z when warning_count rose from 1 to 2), with a
    // median gap of 1.00 d and a maximum gap of 3.00 d. The recurring
    // Friday-publish/weekend-skip lands exactly on the old 3-day bound with
    // zero margin, and the 2026-08-16 shift from 01:00Z to 23:30Z consumed
    // it. The 7-day tier accepts collateralizationRatio, totalAssetsUsd,
    // totalLiabilitiesUsd, and chain details up to 7 days old; reserve-category
    // percentages are curated in liveReservesConfig.params.slices and do not
    // age with this feed. Those totals are currently unscored for a fiat-cash
    // asset, so this bound protects strong backing evidence, not a scored
    // number.
    validation: DISCLOSURE_VALIDATION,
  },
  "united-por": {
    primaryInputKinds: ["http-json"],
    paramsSchema: unitedPorParamsSchema,
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_SINGLE_ASSET_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: DASHBOARD_VERIFIED_VALIDATION,
  },
  "usdgo-transparency": declareAdapter(usdgoAssuranceParamsSchema, HTTP_DISCLOSURE_ATTESTATION_V2, {
    configValidation: configPolicy(["attestation-mix"], [3]),
  }),
  "usdh-native-markets": {
    primaryInputKinds: ["http-html"],
    paramsSchema: noParamsSchema,
    sourceModel: "single-bucket",
    evidenceClass: "weak-live-probe",
    sharedSourceMode: "none",
    configValidation: CONFIG_ATTESTATION_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    provenance: {
      status: "retired",
      rationale:
        "Native Markets USDH entered the frozen archive on 2026-07-11 after its USDC migration; retain the adapter only for historical review and re-evaluate if the issuer resumes the product.",
      parkedSince: "2026-07-11",
      nextReview: "2026-10-11",
    },
    validation: {
      // Native Markets USDH publishes attestation PDFs monthly; use the 33-day window.
      maxSourceAgeSec: MONTHLY_DISCLOSURE_SOURCE_MAX_AGE_SEC,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  },
  "usdai-proof-of-reserves": {
    primaryInputKinds: ["http-json"],
    paramsSchema: usdaiProofOfReservesParamsSchema,
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    preferredFreshnessMode: "not-applicable",
    sourceOriginClass: "issuer-attested",
    displayBadgeKind: "proof",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V2,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      maxUnknownExposurePct: MATERIAL_UNKNOWN_EXPOSURE_PCT,
      maxSourceAgeSec: DISCLOSURE_SOURCE_MAX_AGE_SEC,
      allowedFreshnessModes: ["not-applicable", "unverified"],
    },
  },
  "usd1-bundle-oracle": {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: usd1BundleOracleParamsSchema,
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_SINGLE_ASSET_V2,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      maxSourceAgeSec: DISCLOSURE_SOURCE_MAX_AGE_SEC,
      allowedFreshnessModes: VERIFIED_ONLY_FRESHNESS,
    },
  },
  "usdd-data-platform": {
    primaryInputKinds: ["http-json"],
    paramsSchema: noParamsSchema,
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    preferredFreshnessMode: "verified",
    sharedSourceMode: "none",
    // v2: collateral rows dropping `lockedValue` fail the sync closed instead
    // of being silently summed as zero.
    configValidation: CONFIG_COLLATERAL_V1_V2,
    redemptionTelemetry: { capacity: "direct", fee: "current-bps" },
    validation: DASHBOARD_VALIDATION,
  },
  "usdtb-transparency": {
    primaryInputKinds: ["http-json"],
    paramsSchema: noParamsSchema,
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    preferredFreshnessMode: "verified",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: DASHBOARD_VALIDATION,
  },
  yamato: declareAdapter(yamatoParamsSchema, ONCHAIN_SINGLE_ASSET_V1),
  "youves-tezos": {
    primaryInputKinds: ["http-json"],
    paramsSchema: noParamsSchema,
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sourceOriginClass: "onchain-observation",
    preferredFreshnessMode: "not-applicable",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    // The legacy CDP's exit is borrower repay-only (no holder-facing
    // redemption route on a long-depegged token), so capacity/fee telemetry
    // would fabricate a route.
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: LATEST_STATE_WITH_UNKNOWN_CAP_VALIDATION,
  },
  // v2: a snapshot carrying none of the four ZSD circulating-supply encodings
  // fails closed instead of publishing a supply-less snapshot.
  "zephyr-scanner": declareAdapter(noParamsSchema, HTTP_PROTOCOL_V1, {
    configValidation: CONFIG_PROTOCOL_V1_V2,
  }),
  "usdy-holdings-report": {
    primaryInputKinds: ["http-html"],
    paramsSchema: noParamsSchema,
    sourceModel: "validated-static",
    evidenceClass: "static-validated",
    sourceOriginClass: "independent-assurance",
    preferredFreshnessMode: "verified",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    provenance: {
      status: "parked",
      rationale: "USDY is suspended until the daily Ankura archive has proven newest-report discovery. The pinned September 3 manifest remains reviewed static evidence only.",
      parkedSince: "2026-09-09",
      nextReview: "2026-10-09",
    },
    validation: {
      allowedFreshnessModes: VERIFIED_ONLY_FRESHNESS,
      maxSourceAgeSec: BUSINESS_DAY_NAV_SOURCE_MAX_AGE_SEC,
      maxUnknownExposurePct: MATERIAL_UNKNOWN_EXPOSURE_PCT,
    },
  },
  "djed-cardano": {
    primaryInputKinds: ["http-json"],
    paramsSchema: djedCardanoParamsSchema,
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sourceOriginClass: "onchain-observation",
    preferredFreshnessMode: "not-applicable",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: LATEST_STATE_VALIDATION,
  },
  "dgld-gold-mapper": {
    primaryInputKinds: ["http-json"],
    paramsSchema: dgldGoldMapperParamsSchema,
    sourceModel: "single-bucket",
    evidenceClass: "weak-live-probe",
    sourceOriginClass: "issuer-attested",
    sharedSourceMode: "none",
    configValidation: CONFIG_SINGLE_ASSET_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
      maxUnknownExposurePct: 0,
      allowedFreshnessModes: VERIFIED_ONLY_FRESHNESS,
    },
  },
  "matrixdock-frs": {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: matrixdockFrsParamsSchema,
    sourceModel: "single-bucket",
    evidenceClass: "weak-live-probe",
    sourceOriginClass: "issuer-attested",
    sharedSourceMode: "none",
    configValidation: CONFIG_SINGLE_ASSET_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: LATEST_STATE_VALIDATION,
  },
  "icp-gldt": {
    primaryInputKinds: ["http-json"],
    paramsSchema: icpGldtParamsSchema,
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sourceOriginClass: "onchain-observation",
    preferredFreshnessMode: "not-applicable",
    sharedSourceMode: "none",
    configValidation: CONFIG_SINGLE_ASSET_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: LATEST_STATE_VALIDATION,
  },
  "onre-holdings-csv": {
    primaryInputKinds: ["http-html"],
    paramsSchema: noParamsSchema,
    sourceModel: "dynamic-mix",
    // The sheet is an issuer-published schedule, not an independently examined
    // census: issuer-attested provenance with a weak probe class until the
    // total/AUM reconciliation drift is resolved and the cadence is reviewed.
    evidenceClass: "weak-live-probe",
    sourceOriginClass: "issuer-attested",
    preferredFreshnessMode: "verified",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      // Dated Schedule of Assets snapshots; the observed 2026-08-14 snapshot
      // was 26 days old at implementation, so use the monthly disclosure tier.
      maxSourceAgeSec: MONTHLY_DISCLOSURE_SOURCE_MAX_AGE_SEC,
      maxUnknownExposurePct: MATERIAL_UNKNOWN_EXPOSURE_PCT,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  },
  "avant-reserves-api": {
    primaryInputKinds: ["http-json"],
    paramsSchema: noParamsSchema,
    sourceModel: "dynamic-mix",
    // Gross long legs of a leveraged book are not a reconciled holder-exitable
    // allocation; issuer-attested weak probe until provenance/completeness is
    // resolved. Debt is published as separate totals, never netted.
    evidenceClass: "weak-live-probe",
    sourceOriginClass: "issuer-attested",
    preferredFreshnessMode: "verified",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      // Weekly Tuesday reserve snapshots (2026-08-25, 2026-09-01) with grace
      // for one missed period; the yield-refresh clock is not reserve freshness.
      maxSourceAgeSec: 10 * 86_400,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  },
  "afi-proof": {
    primaryInputKinds: ["http-json"],
    paramsSchema: afiProofParamsSchema,
    sourceModel: "single-bucket",
    // Proof generation is not asset observation: the envelope verifies only
    // aggregate totals, so this stays a weak live probe with ratio telemetry.
    evidenceClass: "weak-live-probe",
    sourceOriginClass: "issuer-attested",
    displayBadgeKind: "proof",
    sharedSourceMode: "none",
    configValidation: CONFIG_SINGLE_ASSET_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    freshnessLimitation:
      "The AFI proof carries a generation timestamp, but proof generation does not establish the as-of dates of the underlying assets; ratio telemetry publishes as unverified.",
    validation: {
      // The basket is 100% opaque by design: a permanent structural fact
      // surfaced as info, not a per-run degradation.
      maxUnknownExposurePct: 100,
      allowedFreshnessModes: ["unverified"],
    },
  },
} as const satisfies Record<string, LiveReserveAdapterDescriptor>;

export type LiveReserveAdapterKey = keyof typeof LIVE_RESERVE_ADAPTER_DESCRIPTOR_DECLARATIONS;

export const LIVE_RESERVE_ADAPTER_KEYS = Object.freeze(
  Object.keys(LIVE_RESERVE_ADAPTER_DESCRIPTOR_DECLARATIONS) as LiveReserveAdapterKey[],
);
