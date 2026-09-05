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

function configPolicy<
  const Semantics extends readonly LiveReserveSemantics[],
  const Versions extends readonly number[],
>(allowedSemantics: Semantics, allowedVersions: Versions) {
  return { allowedSemantics, allowedVersions };
}

const CONFIG_COLLATERAL_V1 = configPolicy(["collateral-mix"], [1]);
const CONFIG_COLLATERAL_V2 = configPolicy(["collateral-mix"], [2]);
const CONFIG_COLLATERAL_V2_V3 = configPolicy(["collateral-mix"], [2, 3]);
const CONFIG_COLLATERAL_V1_V2 = configPolicy(["collateral-mix"], [1, 2]);
const CONFIG_ATTESTATION_V1 = configPolicy(["attestation-mix"], [1]);
const CONFIG_ATTESTATION_V1_V2 = configPolicy(["attestation-mix"], [1, 2]);
const CONFIG_ATTESTATION_V2 = configPolicy(["attestation-mix"], [2]);
const CONFIG_PROTOCOL_V1 = configPolicy(["protocol-reserve"], [1]);
const CONFIG_PROTOCOL_V2 = configPolicy(["protocol-reserve"], [2]);
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

type AdapterProfile = Omit<LiveReserveAdapterDescriptorDeclaration, "paramsSchema">;

function declareAdapter<
  const SchemaKey extends string,
  const Profile extends AdapterProfile,
  const Overrides extends Partial<AdapterProfile> = Record<never, never>,
>(paramsSchema: SchemaKey, profile: Profile, overrides?: Overrides) {
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
  validation: { allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS },
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
  sharedSourceMode: "none",
  configValidation: CONFIG_COLLATERAL_V1,
  redemptionTelemetry: { capacity: "none", fee: "none" },
  validation: {
    maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
    maxUnknownExposurePct: MATERIAL_UNKNOWN_EXPOSURE_PCT,
    allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
  },
} as const satisfies AdapterProfile;

const HTTP_DISCLOSURE_ATTESTATION_V1 = {
  primaryInputKinds: ["http-html"],
  sourceModel: "dynamic-mix",
  evidenceClass: "independent",
  sharedSourceMode: "none",
  configValidation: CONFIG_ATTESTATION_V1,
  redemptionTelemetry: { capacity: "none", fee: "none" },
  validation: {
    maxSourceAgeSec: MONTHLY_DISCLOSURE_SOURCE_MAX_AGE_SEC,
    allowedFreshnessModes: VERIFIED_ONLY_FRESHNESS,
  },
} as const satisfies AdapterProfile;

const HTTP_DISCLOSURE_ATTESTATION_V2 = {
  ...HTTP_DISCLOSURE_ATTESTATION_V1,
  sourceOriginClass: "independent-assurance",
  configValidation: CONFIG_ATTESTATION_V2,
  validation: {
    maxSourceAgeSec: LATE_MONTHLY_DISCLOSURE_SOURCE_MAX_AGE_SEC,
    allowedFreshnessModes: VERIFIED_ONLY_FRESHNESS,
  },
} as const satisfies AdapterProfile;

const HTTP_PROTOCOL_V1 = {
  primaryInputKinds: ["http-json"],
  sourceModel: "single-bucket",
  evidenceClass: "weak-live-probe",
  sharedSourceMode: "none",
  configValidation: CONFIG_PROTOCOL_V1,
  redemptionTelemetry: { capacity: "none", fee: "none" },
  validation: {
    maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
    allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
  },
} as const satisfies AdapterProfile;

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
  "anzen-usdz": declareAdapter("none", ONCHAIN_SINGLE_ASSET_V2, {
    sourceOriginClass: "onchain-observation",
  }),
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
  "astherus-earn-wrapper": declareAdapter("astherusEarnWrapper", ONCHAIN_SINGLE_ASSET_V1, {
    // asUSDF withdrawals are delayed rather than provably immediate, so the
    // net USDF balance backing the shares is composition evidence, not capacity.
    redemptionTelemetry: { capacity: "none", fee: "none" },
  }),
  asymmetry: declareAdapter("none", HTTP_DASHBOARD_COLLATERAL_V1, {
    redemptionTelemetry: { capacity: "direct", fee: "none" },
  }),
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
  "audx-independent-assurance": declareAdapter(
    "audxAssurance",
    HTTP_DISCLOSURE_ATTESTATION_V2,
  ),
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
  "circle-transparency": declareAdapter(
    "circleTransparency",
    HTTP_DISCLOSURE_ATTESTATION_V1,
    {
      validation: {
        maxSourceAgeSec: DISCLOSURE_SOURCE_MAX_AGE_SEC,
        allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
      },
    },
  ),
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
  "usdai-hub": declareAdapter("usdaiHub", ONCHAIN_SINGLE_ASSET_V1, {
    sourceOriginClass: "onchain-observation",
    redemptionTelemetry: { capacity: "direct", fee: "current-bps" },
  }),
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
  "erc4626-single-asset": declareAdapter("erc4626SingleAsset", ONCHAIN_SINGLE_ASSET_V1, {
    redemptionTelemetry: { capacity: "direct", fee: "current-bps" },
  }),
  "escrow-balance": declareAdapter("escrowBalance", ONCHAIN_SINGLE_ASSET_V1, {
    // The single read or bounded all-or-nothing sum measures the escrow or
    // issuance state the redemption is actually paid against, so the result is
    // direct capacity rather than a backing proxy.
    redemptionTelemetry: { capacity: "direct", fee: "none" },
  }),
  ethena: declareAdapter("none", HTTP_DASHBOARD_COLLATERAL_V1, {
    // The adapter reads the EthenaMinting contract's own USDT/USDC balances,
    // which redemptions are paid out of, so capacity is a direct measurement
    // rather than a proxy for the collateral basket.
    redemptionTelemetry: { capacity: "direct", fee: "none" },
  }),
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
  "europ-independent-assurance": declareAdapter(
    "europAssurance",
    HTTP_DISCLOSURE_ATTESTATION_V2,
    {
      validation: {
        maxSourceAgeSec: QUARTERLY_DISCLOSURE_SOURCE_MAX_AGE_SEC,
        allowedFreshnessModes: VERIFIED_ONLY_FRESHNESS,
      },
    },
  ),
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
  falcon: declareAdapter("none", HTTP_DASHBOARD_COLLATERAL_V1, {
    redemptionTelemetry: { capacity: "proxy", fee: "none" },
  }),
  "fdusd-transparency": declareAdapter("none", HTTP_DISCLOSURE_ATTESTATION_V1, {
    validation: {
      maxSourceAgeSec: LATE_MONTHLY_DISCLOSURE_SOURCE_MAX_AGE_SEC,
      allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
    },
  }),
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
  "idle-cdo-epoch-variant": {
    primaryInputKinds: ["onchain-evm"],
    paramsSchema: "idleCdoEpochVariant",
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sourceOriginClass: "onchain-observation",
    sharedSourceMode: "none",
    configValidation: CONFIG_COLLATERAL_V1,
    // The vault's exit is a monthly epoch redemption whose stressed depth is
    // not observable on-chain; publishing capacity from NAV would fabricate it.
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: { allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS },
  },
  infinifi: declareAdapter("none", HTTP_DASHBOARD_COLLATERAL_V1, {
    redemptionTelemetry: { capacity: "proxy", fee: "none" },
  }),
  "initia-wrapper-vault": {
    primaryInputKinds: ["http-json"],
    paramsSchema: "initiaWrapperVault",
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sourceOriginClass: "onchain-observation",
    sharedSourceMode: "none",
    configValidation: CONFIG_SINGLE_ASSET_V1,
    // Initia has no EVM read path, so the vault balance is read over the chain's
    // LCD; the wrapper has no published redemption terms, so no capacity.
    redemptionTelemetry: { capacity: "none", fee: "none" },
    validation: { allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS },
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
    provenance: {
      status: "parked",
      rationale: "The complete Lista GemJoin census contains positive unpriced assets and a non-unit-rate receipt that the branch adapter cannot value exactly. No active config is retained until every positive branch has a supported valuation path.",
      parkedSince: "2026-09-05",
      nextReview: "2026-10-05",
    },
    validation: { allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS },
  },
  "liquity-v1": declareAdapter("liquityV1", ONCHAIN_SINGLE_ASSET_V2),
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
  "m0-wrapper-underlying": declareAdapter("m0WrapperUnderlying", ONCHAIN_SINGLE_ASSET_V1),
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
  "pusd-vault": declareAdapter("pusdVault", ONCHAIN_SINGLE_ASSET_V1),
  "quantoz-transparency": declareAdapter(
    "quantozTransparency",
    HTTP_DISCLOSURE_ATTESTATION_V1,
  ),
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
  "sgho-wrapper": declareAdapter("erc4626SingleAsset", ONCHAIN_SINGLE_ASSET_V1),
  "solstice-attestation": declareAdapter("none", HTTP_PROTOCOL_V1),
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
  "stoneyield-router-pool": declareAdapter("stoneyieldRouterPool", ONCHAIN_SINGLE_ASSET_V1, {
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
  "straitsx-independent-assurance": declareAdapter(
    "straitsxAssurance",
    HTTP_DISCLOSURE_ATTESTATION_V2,
  ),
  "river-protocol-info": declareAdapter("none", HTTP_PROTOCOL_V1, {
    redemptionTelemetry: { capacity: "direct", fee: "current-bps" },
  }),
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
    validation: {
      maxSourceAgeSec: DISCLOSURE_SOURCE_MAX_AGE_SEC,
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
  "usdgo-transparency": declareAdapter("usdgoAssurance", HTTP_DISCLOSURE_ATTESTATION_V2),
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
  yamato: declareAdapter("yamato", ONCHAIN_SINGLE_ASSET_V1),
  "zephyr-scanner": declareAdapter("none", HTTP_PROTOCOL_V1),
} as const satisfies Record<string, LiveReserveAdapterDescriptorDeclaration>;

export type LiveReserveAdapterKey = keyof typeof LIVE_RESERVE_ADAPTER_DESCRIPTOR_DECLARATIONS;

export const LIVE_RESERVE_ADAPTER_KEYS = Object.freeze(
  Object.keys(LIVE_RESERVE_ADAPTER_DESCRIPTOR_DECLARATIONS) as LiveReserveAdapterKey[],
);
