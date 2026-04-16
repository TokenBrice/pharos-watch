import type {
  LiveReserveAdapterKey,
  LiveReserveAdapterValidationPolicy,
  LiveReserveEvidenceClass,
  LiveReserveSourceModel,
  LiveReserveSourceSharingMode,
} from "../types/live-reserves";
import {
  DASHBOARD_SOURCE_MAX_AGE_SEC,
  DISCLOSURE_SOURCE_MAX_AGE_SEC,
  MATERIAL_UNKNOWN_EXPOSURE_PCT,
  MONTHLY_DISCLOSURE_SOURCE_MAX_AGE_SEC,
  NOT_APPLICABLE_ONLY_FRESHNESS,
  UNVERIFIED_ONLY_FRESHNESS,
  VERIFIED_ONLY_FRESHNESS,
  VERIFIED_OR_UNVERIFIED_FRESHNESS,
} from "./live-reserve-adapters-schemas";

export const LIVE_RESERVE_ADAPTER_DEFINITIONS = {
  abracadabra: {
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
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
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS,
    },
  },
  asymmetry: {
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    redemptionTelemetry: { capacity: "direct", fee: "none" },
    validation: {
      maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
      maxUnknownExposurePct: MATERIAL_UNKNOWN_EXPOSURE_PCT,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  },
  btcfi: {
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: { allowedFreshnessModes: UNVERIFIED_ONLY_FRESHNESS },
  },
  "buck-io-transparency": {
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      maxSourceAgeSec: DISCLOSURE_SOURCE_MAX_AGE_SEC,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  },
  "cap-vault": {
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    redemptionTelemetry: { capacity: "direct", fee: "none" },
    validation: { allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS },
  },
  "chainlink-nav": {
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: { allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS },
  },
  "chainlink-por": {
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: { allowedFreshnessModes: VERIFIED_ONLY_FRESHNESS },
  },
  "circle-transparency": {
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
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
    redemptionTelemetry: { capacity: "direct", fee: "none" },
    validation: {
      maxUnknownExposurePct: MATERIAL_UNKNOWN_EXPOSURE_PCT,
      allowedFreshnessModes: UNVERIFIED_ONLY_FRESHNESS,
    },
  },
  crvusd: {
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      maxUnknownExposurePct: MATERIAL_UNKNOWN_EXPOSURE_PCT,
      allowedFreshnessModes: UNVERIFIED_ONLY_FRESHNESS,
    },
  },
  "curated-validated": {
    sourceModel: "validated-static",
    evidenceClass: "static-validated",
    sharedSourceMode: "none",
    redemptionTelemetry: { capacity: "none", fee: "none" },
  },
  "dola-inverse": {
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
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
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: { allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS },
  },
  ethena: {
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
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
    redemptionTelemetry: { capacity: "none", fee: "current-bps" },
    validation: { allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS },
  },
  falcon: {
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
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
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      maxSourceAgeSec: DISCLOSURE_SOURCE_MAX_AGE_SEC,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  },
  "frax-balance-sheet": {
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
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
    redemptionTelemetry: { capacity: "proxy", fee: "none" },
    validation: {
      maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
      allowedFreshnessModes: UNVERIFIED_ONLY_FRESHNESS,
    },
  },
  gho: {
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    redemptionTelemetry: { capacity: "direct", fee: "current-bps" },
    validation: { allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS },
  },
  infinifi: {
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    redemptionTelemetry: { capacity: "proxy", fee: "none" },
    validation: {
      maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
      maxUnknownExposurePct: MATERIAL_UNKNOWN_EXPOSURE_PCT,
      allowedFreshnessModes: UNVERIFIED_ONLY_FRESHNESS,
    },
  },
  jupusd: {
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
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
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: { allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS },
  },
  "liquity-v1": {
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    redemptionTelemetry: { capacity: "direct", fee: "current-bps" },
    validation: { allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS },
  },
  "liquity-v2-branches": {
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    redemptionTelemetry: { capacity: "direct", fee: "current-bps" },
    validation: { allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS },
  },
  m0: {
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "source-invariant",
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  },
  mento: {
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "source-invariant",
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  },
  "openeden-usdo": {
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    redemptionTelemetry: { capacity: "direct", fee: "none" },
    validation: {
      maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  },
  "re-metrics": {
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  },
  reservoir: {
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    redemptionTelemetry: { capacity: "proxy", fee: "none" },
    validation: {
      maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
      maxUnknownExposurePct: MATERIAL_UNKNOWN_EXPOSURE_PCT,
      allowedFreshnessModes: UNVERIFIED_ONLY_FRESHNESS,
    },
  },
  "sgforge-coinvertible": {
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      maxSourceAgeSec: DISCLOSURE_SOURCE_MAX_AGE_SEC,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  },
  "solstice-attestation": {
    sourceModel: "single-bucket",
    evidenceClass: "weak-live-probe",
    sharedSourceMode: "none",
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
    redemptionTelemetry: { capacity: "none", fee: "current-bps" },
  },
  "sky-makercore": {
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "source-invariant",
    redemptionTelemetry: { capacity: "proxy", fee: "none" },
    validation: {
      maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
      maxUnknownExposurePct: MATERIAL_UNKNOWN_EXPOSURE_PCT,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  },
  "superstate-liquidity": {
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    redemptionTelemetry: { capacity: "proxy", fee: "none" },
    validation: {
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  },
  tether: {
    sourceModel: "single-bucket",
    evidenceClass: "weak-live-probe",
    sharedSourceMode: "none",
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: { maxSourceAgeSec: DISCLOSURE_SOURCE_MAX_AGE_SEC },
  },
  "river-protocol-info": {
    sourceModel: "single-bucket",
    evidenceClass: "weak-live-probe",
    sharedSourceMode: "none",
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
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  },
} as const satisfies Record<LiveReserveAdapterKey, {
  sourceModel: LiveReserveSourceModel;
  evidenceClass: LiveReserveEvidenceClass;
  sharedSourceMode: LiveReserveSourceSharingMode;
  redemptionTelemetry: {
    capacity: "direct" | "proxy" | "none";
    fee: "current-bps" | "none";
  };
  validation?: LiveReserveAdapterValidationPolicy;
}>;
