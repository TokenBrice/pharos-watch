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
  QUARTERLY_DISCLOSURE_SOURCE_MAX_AGE_SEC,
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

const CONFIG_ATTESTATION_V2 = {
  allowedSemantics: ["attestation-mix"],
  allowedVersions: [2],
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

// DUSD's reviewed Machine configuration treats position accounting older than
// three hours as stale. Match that contract guard instead of the generic
// dashboard window now that Makina snapshots expose the oldest position time.
const MAKINA_POSITION_SOURCE_MAX_AGE_SEC = 3 * 60 * 60;

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
    /** Capacity emission requires per-coin params (e.g. a redemptionCapacity
     *  block); coins without them never emit and need no unused-telemetry
     *  policy. */
    capacityParamsGated?: boolean;
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
    evidenceClass: "independent",
    sourceOriginClass: "onchain-observation",
    sharedSourceMode: "none",
    configValidation: CONFIG_SINGLE_ASSET_V2,
    redemptionTelemetry: { capacity: "direct", fee: "current-bps" },
    validation: {
      allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS,
    },
  },
  "moc-v3-buckets": {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: "mocV3Buckets",
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sourceOriginClass: "onchain-observation",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V2,
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
  "audx-independent-assurance": {
    primaryInputKinds: ["http-html"],
    paramsSchema: "audxAssurance",
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sourceOriginClass: "independent-assurance",
    sharedSourceMode: "none",
    configValidation: CONFIG_ATTESTATION_V2,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      maxSourceAgeSec: LATE_MONTHLY_DISCLOSURE_SOURCE_MAX_AGE_SEC,
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
    // Redemption capacity is emitted only for coins whose params carry a
    // redemptionCapacity block (currently OUSG); plain NAV-feed coins never
    // emit and are not unused-telemetry candidates.
    redemptionTelemetry: { capacity: "direct", capacityParamsGated: true, fee: "none" },
    validation: { allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS },
  },
  "chronicle-nav": {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: "chronicleNav",
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sourceOriginClass: "independent-assurance",
    sharedSourceMode: "none",
    configValidation: CONFIG_SINGLE_ASSET_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: { allowedFreshnessModes: VERIFIED_ONLY_FRESHNESS },
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
    // Capacity is emitted only when a coin opts into either the legacy
    // single-bridge probe or the identity-gated bridge-basket probe.
    redemptionTelemetry: { capacity: "direct", capacityParamsGated: true, fee: "none" },
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
    // Live capacity is emitted only for curated coins whose params carry a
    // redemptionCapacity block; every other curated coin keeps its static
    // redemption block and is not an unused-telemetry candidate.
    redemptionTelemetry: { capacity: "direct", capacityParamsGated: true, fee: "none" },
  },
  "usdai-hub": {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: "usdaiHub",
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sourceOriginClass: "onchain-observation",
    sharedSourceMode: "none",
    configValidation: CONFIG_SINGLE_ASSET_V1,
    redemptionTelemetry: { capacity: "direct", fee: "current-bps" },
    validation: { allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS },
  },
  "dola-inverse": {
    primaryInputKinds: ["http-json"],
    paramsSchema: "none",
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    // The adapter reads the Inverse PSM's own supply() and the sUSDS vault's
    // maxWithdraw() for it, which the DOLA -> USDS sell is paid out of, so
    // capacity is a direct measurement rather than a proxy for FiRM collateral.
    redemptionTelemetry: { capacity: "direct", fee: "current-bps" },
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
  "escrow-balance": {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: "escrowBalance",
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_SINGLE_ASSET_V1,
    // The single read or bounded all-or-nothing sum measures the escrow or
    // issuance state the redemption is actually paid against, so the result is
    // direct capacity rather than a backing proxy.
    redemptionTelemetry: { capacity: "direct", fee: "none" },
    validation: { allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS },
  },
  ethena: {
    primaryInputKinds: ["http-json"],
    paramsSchema: "none",
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    // The adapter reads the EthenaMinting contract's own USDT/USDC balances,
    // which redemptions are paid out of, so capacity is a direct measurement
    // rather than a proxy for the collateral basket.
    redemptionTelemetry: { capacity: "direct", fee: "none" },
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
    redemptionTelemetry: { capacity: "direct", capacityParamsGated: true, fee: "current-bps" },
    validation: { allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS },
  },
  "parallelizer-balances": {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: "parallelizerBalances",
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "direct", fee: "none" },
    validation: {
      maxUnknownExposurePct: MATERIAL_UNKNOWN_EXPOSURE_PCT,
      allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS,
    },
  },
  "europ-independent-assurance": {
    primaryInputKinds: ["http-html"],
    paramsSchema: "europAssurance",
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sourceOriginClass: "independent-assurance",
    sharedSourceMode: "none",
    configValidation: CONFIG_ATTESTATION_V2,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      maxSourceAgeSec: QUARTERLY_DISCLOSURE_SOURCE_MAX_AGE_SEC,
      allowedFreshnessModes: VERIFIED_ONLY_FRESHNESS,
    },
  },
  "xdai-bridge": {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: "xdaiBridge",
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sourceOriginClass: "onchain-observation",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
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
  "flying-tulip-ftusd": {
    primaryInputKinds: ["http-json"],
    paramsSchema: "none",
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
    paramsSchema: "none",
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sourceOriginClass: "issuer-attested",
    displayBadgeKind: "proof",
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
    displayBadgeKind: "proof",
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
  "hive-hbd-protocol": {
    primaryInputKinds: ["http-json"],
    paramsSchema: "hiveHbdProtocol",
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sourceOriginClass: "onchain-observation",
    sharedSourceMode: "none",
    configValidation: CONFIG_PROTOCOL_V1,
    redemptionTelemetry: { capacity: "none", fee: "none" },
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
    sourceModel: "single-bucket",
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
    displayBadgeKind: "proof",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    redemptionTelemetry: { capacity: "proxy", fee: "none" },
    validation: {
      maxSourceAgeSec: MAKINA_POSITION_SOURCE_MAX_AGE_SEC,
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
        "Re-enable probe (2026-08-13) confirmed the issuer gateway serves ordinary clients, but the first production cron (2026-08-14) received HTTP 500 on every Worker fetch strategy; re-parked until OpenEden unblocks Cloudflare Worker egress.",
      parkedSince: "2026-08-14",
      nextReview: "2027-02-14",
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
    redemptionTelemetry: { capacity: "direct", fee: "none" },
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
    // Capacity comes from a same-run read of the terminal USDC PSM balance, not
    // from the balance-sheet payload; the adapter withholds the redemption
    // block entirely when that read fails. The fee is the SavingModule's
    // MANAGER-settable redeemFee(), read in the same run because no static
    // bound is defensible.
    redemptionTelemetry: { capacity: "direct", fee: "current-bps" },
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
    // Redemption capacity is emitted only for coins whose params carry a
    // redemptionCapacity block (currently AID); the plain liveness-probe coins
    // never emit and are not unused-telemetry candidates.
    redemptionTelemetry: { capacity: "direct", capacityParamsGated: true, fee: "current-bps" },
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
  "solomon-protocol": {
    primaryInputKinds: ["http-json"],
    paramsSchema: "none",
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
  "straitsx-independent-assurance": {
    primaryInputKinds: ["http-html"],
    paramsSchema: "straitsxAssurance",
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sourceOriginClass: "independent-assurance",
    sharedSourceMode: "none",
    configValidation: CONFIG_ATTESTATION_V2,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      maxSourceAgeSec: LATE_MONTHLY_DISCLOSURE_SOURCE_MAX_AGE_SEC,
      allowedFreshnessModes: VERIFIED_ONLY_FRESHNESS,
    },
  },
  "river-protocol-info": {
    primaryInputKinds: ["http-json"],
    paramsSchema: "none",
    sourceModel: "single-bucket",
    evidenceClass: "weak-live-probe",
    sharedSourceMode: "none",
    configValidation: CONFIG_PROTOCOL_V1,
    redemptionTelemetry: { capacity: "direct", fee: "current-bps" },
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
    displayBadgeKind: "proof",
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
    primaryInputKinds: ["http-html"],
    paramsSchema: "usdgoAssurance",
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sourceOriginClass: "independent-assurance",
    sharedSourceMode: "none",
    configValidation: CONFIG_ATTESTATION_V2,
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: {
      maxSourceAgeSec: LATE_MONTHLY_DISCLOSURE_SOURCE_MAX_AGE_SEC,
      allowedFreshnessModes: VERIFIED_ONLY_FRESHNESS,
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
    displayBadgeKind: "proof",
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
    redemptionTelemetry: { capacity: "direct", fee: "current-bps" },
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
