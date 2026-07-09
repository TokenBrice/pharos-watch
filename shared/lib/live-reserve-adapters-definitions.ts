import type {
  LiveReserveAdapterKey,
  LiveReserveAdapterValidationPolicy,
  LiveReserveEvidenceClass,
  LiveReserveSemantics,
  LiveReserveSourceModel,
  LiveReserveSourceSharingMode,
} from "../types/live-reserves";
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
  liveReserveAdapterSchemaMetadata,
} from "./live-reserve-adapters-schemas";

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

type LiveReserveAdapterSourceDefinition = {
  sourceModel: LiveReserveSourceModel;
  evidenceClass: LiveReserveEvidenceClass;
  sharedSourceMode: LiveReserveSourceSharingMode;
  configValidation: LiveReserveAdapterConfigValidationPolicy;
  redemptionTelemetry: {
    capacity: "direct" | "proxy" | "none";
    fee: "current-bps" | "none";
  };
  validation?: LiveReserveAdapterValidationPolicy;
};

const LIVE_RESERVE_ADAPTER_SOURCE_DEFINITIONS = {
  abracadabra: {
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      maxUnknownExposurePct: MATERIAL_UNKNOWN_EXPOSURE_PCT,
      allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS,
    },
  },
  accountable: {
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
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_SINGLE_ASSET_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: { allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS },
  },
  btcfi: {
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: { allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS },
  },
  "cap-vault": {
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_PROTOCOL_V1,
    redemptionTelemetry: { capacity: "direct", fee: "current-bps" },
    validation: { allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS },
  },
  "chainlink-nav": {
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_SINGLE_ASSET_V1_V2,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: { allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS },
  },
  "chainlink-por": {
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_ATTESTATION_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: { allowedFreshnessModes: VERIFIED_ONLY_FRESHNESS },
  },
  "circle-transparency": {
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
    sourceModel: "validated-static",
    evidenceClass: "static-validated",
    sharedSourceMode: "none",
    configValidation: CONFIG_CURATED_VALIDATED,
    redemptionTelemetry: { capacity: "none", fee: "none" },
  },
  "dola-inverse": {
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
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_SINGLE_ASSET_V1,
    redemptionTelemetry: { capacity: "direct", fee: "none" },
    validation: { allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS },
  },
  ethena: {
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
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "none", fee: "current-bps" },
    validation: { allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS },
  },
  falcon: {
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
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
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
  fx: {
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
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_PROTOCOL_V2,
    redemptionTelemetry: { capacity: "direct", fee: "current-bps" },
    validation: { allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS },
  },
  infinifi: {
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
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: { allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS },
  },
  "liquity-v1": {
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_SINGLE_ASSET_V2,
    redemptionTelemetry: { capacity: "direct", fee: "current-bps" },
    validation: { allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS },
  },
  "liquity-native-active-pool": {
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "direct", fee: "current-bps" },
    validation: { allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS },
  },
  "liquity-v2-branches": {
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1_V2,
    redemptionTelemetry: { capacity: "direct", fee: "current-bps" },
    validation: { allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS },
  },
  m0: {
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
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_SINGLE_ASSET_V1,
    redemptionTelemetry: { capacity: "direct", fee: "none" },
    validation: { allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS },
  },
  mento: {
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "source-invariant",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  },
  "nest-vault-positions": {
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
  "origin-vault-balances": {
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "direct", fee: "none" },
    validation: { allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS },
  },
  "pusd-vault": {
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_SINGLE_ASSET_V1,
    redemptionTelemetry: { capacity: "direct", fee: "none" },
    validation: { allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS },
  },
  "quantoz-transparency": {
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
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_SINGLE_ASSET_V1,
    redemptionTelemetry: { capacity: "direct", fee: "none" },
    validation: { allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS },
  },
  "solstice-attestation": {
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
    sourceModel: "single-bucket",
    evidenceClass: "weak-live-probe",
    sharedSourceMode: "none",
    configValidation: CONFIG_SINGLE_ASSET_V1,
    redemptionTelemetry: { capacity: "none", fee: "current-bps" },
  },
  "sky-makercore": {
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
  "usdgo-transparency": {
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
    sourceModel: "single-bucket",
    evidenceClass: "weak-live-probe",
    sharedSourceMode: "none",
    configValidation: CONFIG_ATTESTATION_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      // Native Markets USDH publishes attestation PDFs monthly; use the 33-day window.
      maxSourceAgeSec: MONTHLY_DISCLOSURE_SOURCE_MAX_AGE_SEC,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  },
  "usdai-proof-of-reserves": {
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
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
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_SINGLE_ASSET_V1,
    redemptionTelemetry: { capacity: "direct", fee: "none" },
    validation: { allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS },
  },
  "zephyr-scanner": {
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
} as const satisfies Record<
  LiveReserveAdapterKey,
  LiveReserveAdapterSourceDefinition
>;

export const LIVE_RESERVE_ADAPTER_DEFINITIONS = Object.fromEntries(
  (Object.entries(LIVE_RESERVE_ADAPTER_SOURCE_DEFINITIONS) as Array<[
    LiveReserveAdapterKey,
    LiveReserveAdapterSourceDefinition,
  ]>).map(([key, definition]) => [
    key,
    {
      key,
      ...definition,
      ...liveReserveAdapterSchemaMetadata[key],
    },
  ]),
) as {
  [K in LiveReserveAdapterKey]: (typeof LIVE_RESERVE_ADAPTER_SOURCE_DEFINITIONS)[K]
    & (typeof liveReserveAdapterSchemaMetadata)[K]
    & { key: K };
};
