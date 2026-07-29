import type {
  LiveReserveAdapterValidationPolicy,
  LiveReserveEvidenceClass,
  LiveReserveInput,
  LiveReserveSemantics,
  LiveReserveSourceModel,
  LiveReserveSourceSharingMode,
  ReserveDisplayBadgeKind,
} from "./live-reserve-core";
import type { ReserveEvidenceSourceOriginClass } from "./report-card-evidence-journal";
import {
  BUSINESS_DAY_NAV_SOURCE_MAX_AGE_SEC,
  DASHBOARD_SOURCE_MAX_AGE_SEC,
  DISCLOSURE_SOURCE_MAX_AGE_SEC,
  LATE_MONTHLY_DISCLOSURE_SOURCE_MAX_AGE_SEC,
  MATERIAL_UNKNOWN_EXPOSURE_PCT,
  MONTHLY_DISCLOSURE_SOURCE_MAX_AGE_SEC,
  NOT_APPLICABLE_ONLY_FRESHNESS,
  VERIFIED_ONLY_FRESHNESS,
  VERIFIED_OR_UNVERIFIED_FRESHNESS,
} from "./live-reserve-adapter-policy";

type LiveReserveAdapterConfigValidationPolicy = {
  allowedSemantics: readonly LiveReserveSemantics[];
  allowedVersions: readonly number[];
};

const CONFIG_COLLATERAL_V1 = {
  allowedSemantics: ["collateral-mix"],
  allowedVersions: [1],
} as const satisfies LiveReserveAdapterConfigValidationPolicy;

const CONFIG_COLLATERAL_V2 = {
  allowedSemantics: ["collateral-mix"],
  allowedVersions: [2],
} as const satisfies LiveReserveAdapterConfigValidationPolicy;

const CONFIG_COLLATERAL_V2_V3 = {
  allowedSemantics: ["collateral-mix"],
  allowedVersions: [2, 3],
} as const satisfies LiveReserveAdapterConfigValidationPolicy;

const CONFIG_COLLATERAL_V1_V2 = {
  allowedSemantics: ["collateral-mix"],
  allowedVersions: [1, 2],
} as const satisfies LiveReserveAdapterConfigValidationPolicy;

const CONFIG_ATTESTATION_V1 = {
  allowedSemantics: ["attestation-mix"],
  allowedVersions: [1],
} as const satisfies LiveReserveAdapterConfigValidationPolicy;

const CONFIG_ATTESTATION_V1_V2 = {
  allowedSemantics: ["attestation-mix"],
  allowedVersions: [1, 2],
} as const satisfies LiveReserveAdapterConfigValidationPolicy;

const CONFIG_PROTOCOL_V1 = {
  allowedSemantics: ["protocol-reserve"],
  allowedVersions: [1],
} as const satisfies LiveReserveAdapterConfigValidationPolicy;

const CONFIG_PROTOCOL_V2 = {
  allowedSemantics: ["protocol-reserve"],
  allowedVersions: [2],
} as const satisfies LiveReserveAdapterConfigValidationPolicy;

const CONFIG_SINGLE_ASSET_V1 = {
  allowedSemantics: ["single-asset"],
  allowedVersions: [1],
} as const satisfies LiveReserveAdapterConfigValidationPolicy;

const CONFIG_SINGLE_ASSET_V2 = {
  allowedSemantics: ["single-asset"],
  allowedVersions: [2],
} as const satisfies LiveReserveAdapterConfigValidationPolicy;

const CONFIG_SINGLE_ASSET_V1_V2 = {
  allowedSemantics: ["single-asset"],
  allowedVersions: [1, 2],
} as const satisfies LiveReserveAdapterConfigValidationPolicy;

const CONFIG_ACCOUNTABLE = {
  allowedSemantics: ["collateral-mix", "protocol-reserve"],
  allowedVersions: [1],
} as const satisfies LiveReserveAdapterConfigValidationPolicy;

const CONFIG_CURATED_VALIDATED = {
  allowedSemantics: ["attestation-mix", "collateral-mix", "single-asset"],
  allowedVersions: [1, 2],
} as const satisfies LiveReserveAdapterConfigValidationPolicy;

const UNVERIFIED_OR_NOT_APPLICABLE_FRESHNESS = [
  "unverified",
  "not-applicable",
] satisfies LiveReserveAdapterValidationPolicy["allowedFreshnessModes"];

export const LIVE_RESERVE_ADAPTER_STATUS_VALUES = ["active", "staged", "retired", "parked"] as const;

export type LiveReserveAdapterStatus = (typeof LIVE_RESERVE_ADAPTER_STATUS_VALUES)[number];

export interface LiveReserveAdapterProvenance {
  status: LiveReserveAdapterStatus;
  rationale: string;
  parkedSince?: string;
  nextReview?: string;
}

type LiveReserveAdapterDescriptorDeclaration = {
  primaryInputKinds: readonly LiveReserveInput["kind"][];
  paramsSchema: string;
  sourceModel: LiveReserveSourceModel;
  evidenceClass: LiveReserveEvidenceClass;
  sourceOriginClass?: ReserveEvidenceSourceOriginClass;
  sharedSourceMode: LiveReserveSourceSharingMode;
  configValidation: LiveReserveAdapterConfigValidationPolicy;
  redemptionTelemetry: {
    capacity: "direct" | "proxy" | "none";
    fee: "current-bps" | "none";
  };
  validation?: LiveReserveAdapterValidationPolicy;
  provenance?: LiveReserveAdapterProvenance;
  displayBadgeKind?: ReserveDisplayBadgeKind;
};

export const LIVE_RESERVE_ADAPTER_DESCRIPTOR_DECLARATIONS = {
  "3jane-usd3": {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: "none",
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "direct", fee: "current-bps" },
    validation: { allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS },
  },
  abracadabra: {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: "abracadabra",
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
    validation: {
      maxUnknownExposurePct: MATERIAL_UNKNOWN_EXPOSURE_PCT,
      allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS,
    },
  },
  accountable: {
    primaryInputKinds: ["http-json"],
    paramsSchema: "accountable",
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_ACCOUNTABLE,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  },
  "anzen-usdz": {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: "none",
    sourceModel: "single-bucket",
    evidenceClass: "weak-live-probe",
    sharedSourceMode: "none",
    configValidation: CONFIG_SINGLE_ASSET_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS,
    },
  },
  asymmetry: {
    primaryInputKinds: ["http-json"],
    paramsSchema: "none",
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "direct", fee: "none" },
    validation: {
      maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
      maxUnknownExposurePct: MATERIAL_UNKNOWN_EXPOSURE_PCT,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  },
  "attestation-pdf-index": {
    primaryInputKinds: ["http-html"],
    paramsSchema: "attestationPdfIndex",
    sourceModel: "validated-static",
    evidenceClass: "static-validated",
    sharedSourceMode: "none",
    configValidation: CONFIG_ATTESTATION_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      maxSourceAgeSec: MONTHLY_DISCLOSURE_SOURCE_MAX_AGE_SEC,
      allowedFreshnessModes: VERIFIED_ONLY_FRESHNESS,
    },
  },
  "blast-usdb-yield-manager": {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: "blastUsdbYieldManager",
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_SINGLE_ASSET_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: { allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS },
  },
  btcfi: {
    primaryInputKinds: ["http-json"],
    paramsSchema: "btcfi",
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: { allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS },
  },
  "cap-vault": {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: "capVault",
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_PROTOCOL_V1,
    redemptionTelemetry: { capacity: "direct", fee: "current-bps" },
    validation: { allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS },
  },
  "chainlink-nav": {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: "chainlinkNav",
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_SINGLE_ASSET_V1_V2,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: { allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS },
  },
  "chainlink-por": {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: "chainlinkPor",
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_ATTESTATION_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: { allowedFreshnessModes: VERIFIED_ONLY_FRESHNESS },
  },
  "circle-transparency": {
    primaryInputKinds: ["http-html"],
    paramsSchema: "circleTransparency",
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_ATTESTATION_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      maxSourceAgeSec: DISCLOSURE_SOURCE_MAX_AGE_SEC,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  },
  "collateral-positions-api": {
    primaryInputKinds: ["http-json"],
    paramsSchema: "collateralPositions",
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1_V2,
    redemptionTelemetry: { capacity: "direct", fee: "none" },
    validation: {
      maxUnknownExposurePct: MATERIAL_UNKNOWN_EXPOSURE_PCT,
      allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS,
    },
  },
  crvusd: {
    primaryInputKinds: ["http-json", "onchain-evm"],
    paramsSchema: "none",
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V2_V3,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      maxUnknownExposurePct: MATERIAL_UNKNOWN_EXPOSURE_PCT,
      allowedFreshnessModes: UNVERIFIED_OR_NOT_APPLICABLE_FRESHNESS,
    },
  },
  "curated-validated": {
    primaryInputKinds: ["onchain-evm", "onchain-solana"],
    paramsSchema: "curatedValidated",
    sourceModel: "validated-static",
    evidenceClass: "static-validated",
    sharedSourceMode: "none",
    configValidation: CONFIG_CURATED_VALIDATED,
    redemptionTelemetry: { capacity: "none", fee: "none" },
  },
  "dola-inverse": {
    primaryInputKinds: ["http-json"],
    paramsSchema: "none",
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  },
  "erc4626-single-asset": {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: "erc4626SingleAsset",
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_SINGLE_ASSET_V1,
    redemptionTelemetry: { capacity: "direct", fee: "current-bps" },
    validation: { allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS },
  },
  ethena: {
    primaryInputKinds: ["http-json"],
    paramsSchema: "none",
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "proxy", fee: "none" },
    validation: {
      maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
      maxUnknownExposurePct: MATERIAL_UNKNOWN_EXPOSURE_PCT,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  },
  "evm-branch-balances": {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: "evmBranchBalances",
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "none", fee: "current-bps" },
    validation: { allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS },
  },
  falcon: {
    primaryInputKinds: ["http-json"],
    paramsSchema: "none",
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "proxy", fee: "none" },
    validation: {
      maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
      maxUnknownExposurePct: MATERIAL_UNKNOWN_EXPOSURE_PCT,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  },
  "fdusd-transparency": {
    primaryInputKinds: ["http-html"],
    paramsSchema: "none",
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_ATTESTATION_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      maxSourceAgeSec: LATE_MONTHLY_DISCLOSURE_SOURCE_MAX_AGE_SEC,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  },
  "frax-balance-sheet": {
    primaryInputKinds: ["http-json"],
    paramsSchema: "none",
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sourceOriginClass: "issuer-attested",
    sharedSourceMode: "none",
    configValidation: CONFIG_ATTESTATION_V1_V2,
    redemptionTelemetry: { capacity: "proxy", fee: "none" },
    validation: {
      maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
      maxUnknownExposurePct: MATERIAL_UNKNOWN_EXPOSURE_PCT,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  },
  "frax-fpi-collateral": {
    primaryInputKinds: ["http-json"],
    paramsSchema: "fraxFpiCollateral",
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sourceOriginClass: "issuer-attested",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "proxy", fee: "none" },
    validation: {
      maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
      maxUnknownExposurePct: MATERIAL_UNKNOWN_EXPOSURE_PCT,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  },
  fx: {
    primaryInputKinds: ["http-json", "onchain-evm"],
    paramsSchema: "fx",
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "proxy", fee: "none" },
    validation: {
      maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
      allowedFreshnessModes: UNVERIFIED_OR_NOT_APPLICABLE_FRESHNESS,
    },
  },
  gho: {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: "gho",
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_PROTOCOL_V2,
    redemptionTelemetry: { capacity: "direct", fee: "current-bps" },
    validation: { allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS },
  },
  infinifi: {
    primaryInputKinds: ["http-json"],
    paramsSchema: "none",
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "proxy", fee: "none" },
    validation: {
      maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
      maxUnknownExposurePct: MATERIAL_UNKNOWN_EXPOSURE_PCT,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  },
  jupusd: {
    primaryInputKinds: ["http-json"],
    paramsSchema: "jupusd",
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "direct", fee: "none" },
    validation: {
      maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  },
  lista: {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: "evmBranchBalances",
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: { allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS },
  },
  "liquity-v1": {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: "liquityV1",
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_SINGLE_ASSET_V2,
    redemptionTelemetry: { capacity: "direct", fee: "current-bps" },
    validation: { allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS },
  },
  "liquity-native-active-pool": {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: "liquityNativeActivePool",
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "direct", fee: "current-bps" },
    validation: { allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS },
  },
  "liquity-v2-branches": {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: "liquityV2Branches",
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1_V2,
    redemptionTelemetry: { capacity: "direct", fee: "current-bps" },
    validation: { allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS },
  },
  m0: {
    primaryInputKinds: ["http-json"],
    paramsSchema: "none",
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "source-invariant",
    configValidation: CONFIG_PROTOCOL_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  },
  "m0-wrapper-underlying": {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: "m0WrapperUnderlying",
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_SINGLE_ASSET_V1,
    redemptionTelemetry: { capacity: "direct", fee: "none" },
    validation: { allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS },
  },
  "makina-strategy": {
    primaryInputKinds: ["http-json"],
    paramsSchema: "makinaStrategy",
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sourceOriginClass: "issuer-attested",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
      maxUnknownExposurePct: MATERIAL_UNKNOWN_EXPOSURE_PCT,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  },
  mento: {
    primaryInputKinds: ["http-json"],
    paramsSchema: "mento",
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    // Per-coin on-chain redemption reads (broker-pool/liquity-v2-cr/fpmm-pool)
    // make the adapter's output coin-specific, so results can no longer be
    // shared across coins within a run.
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "direct", fee: "current-bps" },
    validation: {
      maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  },
  "nest-vault-positions": {
    primaryInputKinds: ["http-json"],
    paramsSchema: "nestVaultPositions",
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
      allowedFreshnessModes: VERIFIED_ONLY_FRESHNESS,
    },
  },
  "openeden-usdo": {
    primaryInputKinds: ["http-json"],
    paramsSchema: "none",
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "direct", fee: "none" },
    provenance: {
      status: "parked",
      rationale:
        "OpenEden USDO adapter is retained, but its live config was suspended 2026-06-25 because OpenEden's gateway drops Cloudflare Worker egress; rebind once the issuer allowlists our egress.",
      parkedSince: "2026-06-25",
      nextReview: "2026-12-25",
    },
    validation: {
      maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  },
  "origin-vault-balances": {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: "originVaultBalances",
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "direct", fee: "none" },
    validation: { allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS },
  },
  "pusd-vault": {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: "pusdVault",
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_SINGLE_ASSET_V1,
    redemptionTelemetry: { capacity: "direct", fee: "none" },
    validation: { allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS },
  },
  "quantoz-transparency": {
    primaryInputKinds: ["http-html"],
    paramsSchema: "quantozTransparency",
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_ATTESTATION_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      maxSourceAgeSec: MONTHLY_DISCLOSURE_SOURCE_MAX_AGE_SEC,
      allowedFreshnessModes: VERIFIED_ONLY_FRESHNESS,
    },
  },
  "re-metrics": {
    primaryInputKinds: ["http-html"],
    paramsSchema: "none",
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "direct", fee: "none" },
    validation: {
      maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  },
  "resupply-pairs": {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: "resupplyPairs",
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "direct", fee: "none" },
    validation: {
      allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS,
    },
  },
  "reserve-protocol-dtf": {
    primaryInputKinds: ["http-json", "onchain-evm"],
    paramsSchema: "reserveProtocolDtf",
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      maxUnknownExposurePct: MATERIAL_UNKNOWN_EXPOSURE_PCT,
      allowedFreshnessModes: UNVERIFIED_OR_NOT_APPLICABLE_FRESHNESS,
    },
  },
  reservoir: {
    primaryInputKinds: ["http-json"],
    paramsSchema: "none",
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "source-invariant",
    configValidation: CONFIG_PROTOCOL_V1,
    redemptionTelemetry: { capacity: "proxy", fee: "none" },
    validation: {
      maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
      maxUnknownExposurePct: MATERIAL_UNKNOWN_EXPOSURE_PCT,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  },
  "ripple-transparency": {
    primaryInputKinds: ["http-html"],
    paramsSchema: "none",
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_ATTESTATION_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      maxSourceAgeSec: MONTHLY_DISCLOSURE_SOURCE_MAX_AGE_SEC,
      allowedFreshnessModes: VERIFIED_ONLY_FRESHNESS,
    },
  },
  "sgforge-coinvertible": {
    primaryInputKinds: ["http-html"],
    paramsSchema: "sgForgeCoinvertible",
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_ATTESTATION_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      maxSourceAgeSec: DISCLOSURE_SOURCE_MAX_AGE_SEC,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  },
  "sgho-wrapper": {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: "erc4626SingleAsset",
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_SINGLE_ASSET_V1,
    redemptionTelemetry: { capacity: "direct", fee: "none" },
    validation: { allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS },
  },
  "solstice-attestation": {
    primaryInputKinds: ["http-json"],
    paramsSchema: "none",
    sourceModel: "single-bucket",
    evidenceClass: "weak-live-probe",
    sharedSourceMode: "none",
    configValidation: CONFIG_PROTOCOL_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  },
  "single-asset": {
    primaryInputKinds: ["http-json", "onchain-evm"],
    paramsSchema: "singleAsset",
    sourceModel: "single-bucket",
    evidenceClass: "weak-live-probe",
    sharedSourceMode: "none",
    configValidation: CONFIG_SINGLE_ASSET_V1,
    redemptionTelemetry: { capacity: "none", fee: "current-bps" },
  },
  "sky-makercore": {
    primaryInputKinds: ["http-json"],
    paramsSchema: "none",
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "source-invariant",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "direct", fee: "none" },
    validation: {
      maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
      maxUnknownExposurePct: MATERIAL_UNKNOWN_EXPOSURE_PCT,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  },
  "spiko-api": {
    primaryInputKinds: ["http-json"],
    paramsSchema: "spikoApi",
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_SINGLE_ASSET_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      maxSourceAgeSec: BUSINESS_DAY_NAV_SOURCE_MAX_AGE_SEC,
      allowedFreshnessModes: VERIFIED_ONLY_FRESHNESS,
    },
  },
  "superstate-liquidity": {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: "superstateLiquidity",
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_SINGLE_ASSET_V1,
    redemptionTelemetry: { capacity: "direct", fee: "none" },
    validation: {
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  },
  "river-protocol-info": {
    primaryInputKinds: ["http-json"],
    paramsSchema: "none",
    sourceModel: "single-bucket",
    evidenceClass: "weak-live-probe",
    sharedSourceMode: "none",
    configValidation: CONFIG_PROTOCOL_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  },
  // NOTE(owner-review): evidenceClass "independent" mirrors the frax-balance-sheet
  // issuer-balance-sheet precedent (live total assets/liabilities + freshness,
  // configured static composition), but the totals here are Tether's own
  // self-published transparency.json rather than a third-party-audited feed.
  // Flagged for owner review of whether this should instead be "static-validated".
  "tether-transparency": {
    primaryInputKinds: ["http-json"],
    paramsSchema: "tetherTransparency",
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sourceOriginClass: "issuer-attested",
    sharedSourceMode: "source-invariant",
    configValidation: CONFIG_ATTESTATION_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  },
  "united-por": {
    primaryInputKinds: ["http-json"],
    paramsSchema: "unitedPor",
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_SINGLE_ASSET_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
      allowedFreshnessModes: VERIFIED_ONLY_FRESHNESS,
    },
  },
  "usdgo-transparency": {
    primaryInputKinds: ["http-json"],
    paramsSchema: "none",
    sourceModel: "dynamic-mix",
    evidenceClass: "weak-live-probe",
    sharedSourceMode: "none",
    configValidation: CONFIG_ATTESTATION_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      maxSourceAgeSec: DISCLOSURE_SOURCE_MAX_AGE_SEC,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  },
  "usdh-native-markets": {
    primaryInputKinds: ["http-html"],
    paramsSchema: "none",
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
    paramsSchema: "none",
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sourceOriginClass: "issuer-attested",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V2,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      maxUnknownExposurePct: MATERIAL_UNKNOWN_EXPOSURE_PCT,
      maxSourceAgeSec: DISCLOSURE_SOURCE_MAX_AGE_SEC,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  },
  "usd1-bundle-oracle": {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: "usd1BundleOracle",
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
    paramsSchema: "none",
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  },
  "usdtb-transparency": {
    primaryInputKinds: ["http-json"],
    paramsSchema: "none",
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  },
  yamato: {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: "yamato",
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_SINGLE_ASSET_V1,
    redemptionTelemetry: { capacity: "direct", fee: "none" },
    validation: { allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS },
  },
  "zephyr-scanner": {
    primaryInputKinds: ["http-json"],
    paramsSchema: "none",
    sourceModel: "single-bucket",
    evidenceClass: "weak-live-probe",
    sharedSourceMode: "none",
    configValidation: CONFIG_PROTOCOL_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  },
} as const satisfies Record<string, LiveReserveAdapterDescriptorDeclaration>;

export type LiveReserveAdapterKey = keyof typeof LIVE_RESERVE_ADAPTER_DESCRIPTOR_DECLARATIONS;

export const LIVE_RESERVE_ADAPTER_KEYS = Object.freeze(
  Object.keys(LIVE_RESERVE_ADAPTER_DESCRIPTOR_DECLARATIONS) as LiveReserveAdapterKey[],
);
