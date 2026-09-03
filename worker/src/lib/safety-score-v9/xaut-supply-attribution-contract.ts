import { v9RepresentationGroupRouteKey } from "@shared/lib/safety-score-v9/facts";
import { compareText } from "@shared/lib/safety-score-v9/primitives";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import {
  BridgeRouteRiskTierSchema,
  type BridgeRouteRiskTier,
} from "@shared/types/core";
import { z } from "zod";

// Explicit per-asset override (owner ruling 2026-07-29): xaut-tether alone runs
// a 3600s observation window; every other attribution asset stays on the 1800s
// bound (REVIEWED_DEPLOYMENT_SUPPLY_MAX_AGE_SEC in
// safety-score-v9-supply-attribution-contract.ts). XAUT is the only source that
// pins a finalized Ethereum block and reconciles it against the issuer
// transparency snapshot, so its observation is already 780-1150s old when the
// generation is published and then ages across the 30-minute consumption window
// before a consumer re-derives it. At 1800s that always expired mid-window.
export const XAUT_SUPPLY_ATTRIBUTION_MAX_AGE_SEC = 3_600;
export const XAUT_DISCLOSURE_MAX_AGE_SEC = 2 * 86_400;
export const XAUT_ASSET_ID = "xaut-tether";
export const XAUT_REPRESENTATION_ID = "xaut0-omnichain";
export const XAUT_CANONICAL_CHAIN_ID = "ethereum";
export const XAUT_CANONICAL_TOKEN_ADDRESS =
  "0x68749665ff8d2d112fa859aa293f07a622782f38";
export const XAUT_TREASURY_ADDRESS =
  "0x5754284f345afc66a98fbb0a0afe71e0f007b949";
export const XAUT_TRANSPARENCY_SOURCE_ID =
  "tether-transparency:xaut:ethereum";
const XAUT_TRANSPARENCY_URL =
  "https://app.tether.to/transparency.json";
export const XAUT_CANONICAL_ROUTE_ID =
  `${XAUT_CANONICAL_CHAIN_ID}:${XAUT_CANONICAL_TOKEN_ADDRESS}`;
export const XAUT0_ADAPTER_ADDRESS =
  "0xb9c2321bb7d0db468f570d10a424d1cc8efd696c";
export const XAUT0_COMMON_FAILURE_DOMAIN = "protocol:xaut0-omnichain";
export const XAUT0_ADAPTER_FAILURE_DOMAIN =
  `contract:${XAUT_CANONICAL_CHAIN_ID}:${XAUT0_ADAPTER_ADDRESS}`;

const XAUT_ROUTE_INVENTORY_DIGEST_DOMAIN =
  "safety-score-v9.xaut-representation-group-route-inventory.v1";
const XAUT_TRANSPARENCY_CONFIG_DIGEST_DOMAIN =
  "safety-score-v9.xaut-transparency-source-config.v1";
const SHARE_SCALE = 10n ** 18n;
const RAW_SUPPLY_RE = /^(0|[1-9][0-9]*)$/;
const EVM_ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const EVM_BLOCK_HASH_RE = /^0x[0-9a-f]{64}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

export const XAUT_CANONICAL_RUNTIME_CODE_SHA256 =
  "f493237b9d26fcb9d47fc3685d30e1e17c8302b5d84071394e77642cfa14cfcb";
export const XAUT_CANONICAL_IMPLEMENTATION_ADDRESS =
  "0x4c0d2c74a8d26f1e4f5653021c521f5471f9e566";
export const XAUT_CANONICAL_IMPLEMENTATION_CODE_SHA256 =
  "4d6c2310a870878b93dc466d4bb1ec999c21f8b824565b53ce1a47ba8a2a3cba";
export const XAUT0_ADAPTER_RUNTIME_CODE_SHA256 =
  "18808e7e12c9fbc460bbd2d0098955b0a78629568f355c18c16e9f175c14fbcb";
export const XAUT0_ADAPTER_IMPLEMENTATION_ADDRESS =
  "0x77e277ea59a49ee2c9c6d06ef708b4bb8edc4af3";
export const XAUT0_ADAPTER_IMPLEMENTATION_CODE_SHA256 =
  "9bd465bbe890ff66143dba87895b4fa8847e9c3d5840fdede3f161696bf64610";
export const XAUT0_LAYERZERO_ENDPOINT_ADDRESS =
  "0x1a44076050125825900e736c501f859c50fe728c";

export interface XautRepresentationGroupInventoryRow {
  routeId: string;
  destinationChain: string;
  contractAddress: string;
  representationId: string;
  riskTier: BridgeRouteRiskTier;
  reviewDisposition: "reviewed";
  failureDomainKeys: string[];
}

export interface XautRepresentationGroupInventory {
  assetId: typeof XAUT_ASSET_ID;
  canonicalRouteId: string;
  representationId: typeof XAUT_REPRESENTATION_ID;
  riskTier: BridgeRouteRiskTier;
  commonFailureDomainKeys: string[];
  digest: string;
  routes: XautRepresentationGroupInventoryRow[];
}

export interface XautLockMintObservation {
  chainId: typeof XAUT_CANONICAL_CHAIN_ID;
  canonicalTokenAddress: string;
  adapterAddress: string;
  decimals: number;
  canonicalTotalSupplyRaw: string;
  treasuryAddress: string;
  treasuryBalanceRaw: string;
  adapterLockedSupplyRaw: string;
  blockNumber: number;
  blockTimeSec: number;
  blockHash: string;
  canonicalRuntimeCodeSha256: string;
  canonicalImplementationAddress: string;
  canonicalImplementationCodeSha256: string;
  adapterRuntimeCodeSha256: string;
  adapterImplementationAddress: string;
  adapterImplementationCodeSha256: string;
  adapterTokenAddress: string;
  adapterEndpointAddress: string;
  disclosure: {
    sourceId: typeof XAUT_TRANSPARENCY_SOURCE_ID;
    sourceConfigDigest: string;
    sourceTimestampSec: number;
    responseSha256: string;
    totalAuthorizedRaw: string;
    notIssuedRaw: string;
    quarantinedRaw: string;
  };
}

export interface XautTransparencySource {
  sourceId: typeof XAUT_TRANSPARENCY_SOURCE_ID;
  url: string;
  configDigest: string;
}

export interface XautRepresentationGroupSupplyAttributionV2 {
  model: "canonical-lock-mint-group-partition-v2";
  assetId: typeof XAUT_ASSET_ID;
  observedAtSec: number;
  registryFingerprint: string;
  routeInventoryDigest: string;
  canonical: {
    routeId: string;
    chainId: typeof XAUT_CANONICAL_CHAIN_ID;
    currentSupplyUsd: number;
  };
  representationGroup: {
    deploymentRouteKey: string;
    representationId: typeof XAUT_REPRESENTATION_ID;
    routeIds: string[];
    riskTier: BridgeRouteRiskTier;
    failureDomainKeys: string[];
    currentSupplyUsd: number;
  };
  observation: XautLockMintObservation;
}

const XautLockMintObservationSchema = z.strictObject({
  chainId: z.literal(XAUT_CANONICAL_CHAIN_ID),
  canonicalTokenAddress: z.string().regex(EVM_ADDRESS_RE),
  adapterAddress: z.string().regex(EVM_ADDRESS_RE),
  decimals: z.number().int().min(0).max(36),
  canonicalTotalSupplyRaw: z.string().regex(RAW_SUPPLY_RE),
  treasuryAddress: z.string().regex(EVM_ADDRESS_RE),
  treasuryBalanceRaw: z.string().regex(RAW_SUPPLY_RE),
  adapterLockedSupplyRaw: z.string().regex(RAW_SUPPLY_RE),
  blockNumber: z.number().int().nonnegative(),
  blockTimeSec: z.number().int().nonnegative(),
  blockHash: z.string().regex(EVM_BLOCK_HASH_RE),
  canonicalRuntimeCodeSha256: z.string().regex(SHA256_RE),
  canonicalImplementationAddress: z.string().regex(EVM_ADDRESS_RE),
  canonicalImplementationCodeSha256: z.string().regex(SHA256_RE),
  adapterRuntimeCodeSha256: z.string().regex(SHA256_RE),
  adapterImplementationAddress: z.string().regex(EVM_ADDRESS_RE),
  adapterImplementationCodeSha256: z.string().regex(SHA256_RE),
  adapterTokenAddress: z.string().regex(EVM_ADDRESS_RE),
  adapterEndpointAddress: z.string().regex(EVM_ADDRESS_RE),
  disclosure: z.strictObject({
    sourceId: z.literal(XAUT_TRANSPARENCY_SOURCE_ID),
    sourceConfigDigest: z.string().regex(SHA256_RE),
    sourceTimestampSec: z.number().int().nonnegative(),
    responseSha256: z.string().regex(SHA256_RE),
    totalAuthorizedRaw: z.string().regex(RAW_SUPPLY_RE),
    notIssuedRaw: z.string().regex(RAW_SUPPLY_RE),
    quarantinedRaw: z.string().regex(RAW_SUPPLY_RE),
  }),
});

export const XautRepresentationGroupSupplyAttributionV2Schema = z.strictObject({
  model: z.literal("canonical-lock-mint-group-partition-v2"),
  assetId: z.literal(XAUT_ASSET_ID),
  observedAtSec: z.number().int().nonnegative(),
  registryFingerprint: z.string().regex(SHA256_RE),
  routeInventoryDigest: z.string().regex(SHA256_RE),
  canonical: z.strictObject({
    routeId: z.string().min(1),
    chainId: z.literal(XAUT_CANONICAL_CHAIN_ID),
    currentSupplyUsd: z.number().finite().positive(),
  }),
  representationGroup: z.strictObject({
    deploymentRouteKey: z.string().min(1),
    representationId: z.literal(XAUT_REPRESENTATION_ID),
    routeIds: z.array(z.string().min(1)).min(1),
    riskTier: BridgeRouteRiskTierSchema,
    failureDomainKeys: z.array(z.string().min(1)).min(1),
    currentSupplyUsd: z.number().finite().positive(),
  }),
  observation: XautLockMintObservationSchema,
});

function canonicalStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function exactStrings(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export function buildXautTransparencySource(): XautTransparencySource | null {
  const config = ACTIVE_META_BY_ID.get(XAUT_ASSET_ID)?.liveReservesConfig;
  const primary = config?.inputs.primary;
  if (
    config?.adapter !== "tether-transparency" ||
    primary?.kind !== "http-json" ||
    config.params?.currencyIso !== "xaut"
  ) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(primary.url);
  } catch {
    return null;
  }
  if (
    url.origin !== "https://app.tether.to" ||
    url.pathname !== "/transparency.json" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.toString() !== XAUT_TRANSPARENCY_URL
  ) {
    return null;
  }

  const normalizedUrl = url.toString();
  return {
    sourceId: XAUT_TRANSPARENCY_SOURCE_ID,
    url: normalizedUrl,
    configDigest: sha256Hex(
      stableJsonStringifyV1({
        domain: XAUT_TRANSPARENCY_CONFIG_DIGEST_DOMAIN,
        assetId: XAUT_ASSET_ID,
        adapter: config.adapter,
        currencyIso: "xaut",
        chainName: "Ethereum",
        url: normalizedUrl,
      }),
    ),
  };
}

export function buildXautRepresentationGroupInventory():
  | XautRepresentationGroupInventory
  | null {
  const meta = ACTIVE_META_BY_ID.get(XAUT_ASSET_ID);
  const routes = meta?.bridgeRouteRisk?.routes ?? [];
  const canonical = routes.filter(
    (route) =>
      route.id === XAUT_CANONICAL_ROUTE_ID &&
      route.destinationChain === XAUT_CANONICAL_CHAIN_ID &&
      route.contractAddress.toLowerCase() === XAUT_CANONICAL_TOKEN_ADDRESS &&
      route.routeClass === "native" &&
      route.issuanceModel === "native-issuance" &&
      route.reviewDisposition === "reviewed",
  );
  const grouped = routes.filter(
    (route) => route.representationId === XAUT_REPRESENTATION_ID,
  );
  if (
    canonical.length !== 1 ||
    grouped.length === 0 ||
    grouped.length !== routes.length - 1 ||
    new Set(routes.map((route) => route.id)).size !== routes.length
  ) {
    return null;
  }

  const riskTiers = canonicalStrings(grouped.map((route) => route.riskTier));
  if (riskTiers.length !== 1 || riskTiers[0] !== "external-lock-mint") return null;
  for (const route of grouped) {
    if (
      route.canonicalChain !== XAUT_CANONICAL_CHAIN_ID ||
      route.routeClass === "native" ||
      route.issuanceModel !== "wrapped-representation" ||
      route.semantics !== "lock-mint" ||
      route.reviewDisposition !== "reviewed" ||
      !route.failureDomainKeys?.includes(XAUT0_COMMON_FAILURE_DOMAIN)
    ) {
      return null;
    }
  }

  let commonFailureDomainKeys = canonicalStrings(
    grouped[0]!.failureDomainKeys ?? [],
  );
  for (const route of grouped.slice(1)) {
    const routeDomains = new Set(route.failureDomainKeys ?? []);
    commonFailureDomainKeys = commonFailureDomainKeys.filter((key) =>
      routeDomains.has(key),
    );
  }
  if (!commonFailureDomainKeys.includes(XAUT0_COMMON_FAILURE_DOMAIN)) return null;

  const inventoryRoutes = grouped
    .map<XautRepresentationGroupInventoryRow>((route) => ({
      routeId: route.id,
      destinationChain: route.destinationChain,
      contractAddress: route.contractAddress,
      representationId: XAUT_REPRESENTATION_ID,
      riskTier: route.riskTier,
      reviewDisposition: "reviewed",
      failureDomainKeys: canonicalStrings(route.failureDomainKeys ?? []),
    }))
    .sort((left, right) => compareText(left.routeId, right.routeId));
  const inventoryPayload = {
    domain: XAUT_ROUTE_INVENTORY_DIGEST_DOMAIN,
    assetId: XAUT_ASSET_ID,
    canonicalRouteId: XAUT_CANONICAL_ROUTE_ID,
    representationId: XAUT_REPRESENTATION_ID,
    riskTier: riskTiers[0] as BridgeRouteRiskTier,
    commonFailureDomainKeys,
    routes: inventoryRoutes,
  };
  return {
    assetId: XAUT_ASSET_ID,
    canonicalRouteId: XAUT_CANONICAL_ROUTE_ID,
    representationId: XAUT_REPRESENTATION_ID,
    riskTier: riskTiers[0] as BridgeRouteRiskTier,
    commonFailureDomainKeys,
    digest: sha256Hex(stableJsonStringifyV1(inventoryPayload)),
    routes: inventoryRoutes,
  };
}

export function xautLockMintIdentityValidationError(
  observation: XautLockMintObservation,
): string | null {
  const transparencySource = buildXautTransparencySource();
  if (
    !transparencySource ||
    observation.chainId !== XAUT_CANONICAL_CHAIN_ID ||
    observation.canonicalTokenAddress.toLowerCase() !==
      XAUT_CANONICAL_TOKEN_ADDRESS ||
    observation.treasuryAddress.toLowerCase() !== XAUT_TREASURY_ADDRESS ||
    observation.adapterAddress.toLowerCase() !== XAUT0_ADAPTER_ADDRESS ||
    observation.decimals !== 6 ||
    observation.canonicalRuntimeCodeSha256 !==
      XAUT_CANONICAL_RUNTIME_CODE_SHA256 ||
    observation.canonicalImplementationAddress.toLowerCase() !==
      XAUT_CANONICAL_IMPLEMENTATION_ADDRESS ||
    observation.canonicalImplementationCodeSha256 !==
      XAUT_CANONICAL_IMPLEMENTATION_CODE_SHA256 ||
    observation.adapterRuntimeCodeSha256 !==
      XAUT0_ADAPTER_RUNTIME_CODE_SHA256 ||
    observation.adapterImplementationAddress.toLowerCase() !==
      XAUT0_ADAPTER_IMPLEMENTATION_ADDRESS ||
    observation.adapterImplementationCodeSha256 !==
      XAUT0_ADAPTER_IMPLEMENTATION_CODE_SHA256 ||
    observation.adapterTokenAddress.toLowerCase() !==
      XAUT_CANONICAL_TOKEN_ADDRESS ||
    observation.adapterEndpointAddress.toLowerCase() !==
      XAUT0_LAYERZERO_ENDPOINT_ADDRESS ||
    observation.disclosure.sourceId !== XAUT_TRANSPARENCY_SOURCE_ID ||
    observation.disclosure.sourceConfigDigest !==
      transparencySource.configDigest
  ) {
    return "XAUT disclosure, canonical token, treasury, or XAUt0 adapter identity mismatch";
  }
  if (
    !RAW_SUPPLY_RE.test(observation.canonicalTotalSupplyRaw) ||
    !RAW_SUPPLY_RE.test(observation.treasuryBalanceRaw) ||
    !RAW_SUPPLY_RE.test(observation.adapterLockedSupplyRaw) ||
    !RAW_SUPPLY_RE.test(observation.disclosure.totalAuthorizedRaw) ||
    !RAW_SUPPLY_RE.test(observation.disclosure.notIssuedRaw) ||
    !RAW_SUPPLY_RE.test(observation.disclosure.quarantinedRaw) ||
    !SHA256_RE.test(observation.disclosure.responseSha256) ||
    !Number.isSafeInteger(observation.blockNumber) ||
    observation.blockNumber < 0 ||
    !Number.isInteger(observation.blockTimeSec) ||
    observation.blockTimeSec < 0 ||
    !Number.isInteger(observation.disclosure.sourceTimestampSec) ||
    observation.disclosure.sourceTimestampSec < 0 ||
    !EVM_BLOCK_HASH_RE.test(observation.blockHash) ||
    !SHA256_RE.test(observation.canonicalRuntimeCodeSha256) ||
    !SHA256_RE.test(observation.canonicalImplementationCodeSha256) ||
    !SHA256_RE.test(observation.adapterRuntimeCodeSha256) ||
    !SHA256_RE.test(observation.adapterImplementationCodeSha256)
  ) {
    return "Malformed XAUT lock/mint observation";
  }
  const totalRaw = BigInt(observation.canonicalTotalSupplyRaw);
  const treasuryRaw = BigInt(observation.treasuryBalanceRaw);
  const lockedRaw = BigInt(observation.adapterLockedSupplyRaw);
  const disclosedTotalRaw = BigInt(
    observation.disclosure.totalAuthorizedRaw,
  );
  const disclosedNotIssuedRaw = BigInt(
    observation.disclosure.notIssuedRaw,
  );
  const disclosedQuarantinedRaw = BigInt(
    observation.disclosure.quarantinedRaw,
  );
  if (
    totalRaw !== disclosedTotalRaw ||
    treasuryRaw !== disclosedNotIssuedRaw
  ) {
    return "XAUT transparency disclosure does not reconcile to finalized on-chain state";
  }
  const circulatingLiabilityRaw = disclosedTotalRaw - disclosedNotIssuedRaw;
  return disclosedQuarantinedRaw === 0n &&
    disclosedTotalRaw > disclosedNotIssuedRaw &&
    circulatingLiabilityRaw > 0n &&
    lockedRaw > 0n &&
    lockedRaw < circulatingLiabilityRaw
    ? null
    : "Invalid XAUT circulating-liability lock/mint supply relationship";
}

function expectedSupplyRows(
  aggregateSupplyUsd: number,
  circulatingLiabilityRaw: bigint,
  adapterLockedSupplyRaw: bigint,
): { canonicalSupplyUsd: number; representationGroupSupplyUsd: number } | null {
  if (
    !Number.isFinite(aggregateSupplyUsd) ||
    aggregateSupplyUsd <= 0 ||
    circulatingLiabilityRaw <= 0n ||
    adapterLockedSupplyRaw <= 0n ||
    adapterLockedSupplyRaw >= circulatingLiabilityRaw
  ) {
    return null;
  }
  const shareScaled =
    (adapterLockedSupplyRaw * SHARE_SCALE + circulatingLiabilityRaw / 2n) /
    circulatingLiabilityRaw;
  const representationGroupSupplyUsd =
    aggregateSupplyUsd * (Number(shareScaled) / Number(SHARE_SCALE));
  const canonicalSupplyUsd =
    aggregateSupplyUsd - representationGroupSupplyUsd;
  return Number.isFinite(canonicalSupplyUsd) &&
    canonicalSupplyUsd > 0 &&
    Number.isFinite(representationGroupSupplyUsd) &&
    representationGroupSupplyUsd > 0
    ? { canonicalSupplyUsd, representationGroupSupplyUsd }
    : null;
}

export function xautRepresentationGroupAttributionValidationError(input: {
  attribution: XautRepresentationGroupSupplyAttributionV2;
  aggregateSupplyUsd: number;
  registryFingerprint: string;
  clockSec: number;
}): string | null {
  const { attribution } = input;
  if (
    attribution.assetId !== XAUT_ASSET_ID ||
    attribution.registryFingerprint !== input.registryFingerprint
  ) {
    return "XAUT attribution registry identity mismatch";
  }
  const inventory = buildXautRepresentationGroupInventory();
  if (
    !inventory ||
    attribution.routeInventoryDigest !== inventory.digest ||
    attribution.canonical.routeId !== inventory.canonicalRouteId ||
    attribution.canonical.chainId !== XAUT_CANONICAL_CHAIN_ID ||
    attribution.representationGroup.representationId !==
      inventory.representationId ||
    attribution.representationGroup.deploymentRouteKey !==
      v9RepresentationGroupRouteKey(
        XAUT_ASSET_ID,
        XAUT_REPRESENTATION_ID,
      ) ||
    attribution.representationGroup.riskTier !== inventory.riskTier ||
    !exactStrings(
      attribution.representationGroup.routeIds,
      inventory.routes.map((route) => route.routeId),
    ) ||
    !exactStrings(
      attribution.representationGroup.failureDomainKeys,
      canonicalStrings([
        ...inventory.commonFailureDomainKeys,
        XAUT0_ADAPTER_FAILURE_DOMAIN,
      ]),
    )
  ) {
    return "XAUT representation-group route inventory mismatch";
  }
  if (
    attribution.observedAtSec !==
      Math.max(
        attribution.observation.blockTimeSec,
        attribution.observation.disclosure.sourceTimestampSec,
      ) ||
    attribution.observedAtSec > input.clockSec ||
    attribution.observation.blockTimeSec > input.clockSec ||
    input.clockSec - attribution.observation.blockTimeSec >
      XAUT_SUPPLY_ATTRIBUTION_MAX_AGE_SEC
  ) {
    return "XAUT finalized lock/mint observation time is invalid";
  }
  if (
    attribution.observation.disclosure.sourceTimestampSec >
      input.clockSec ||
    input.clockSec -
      attribution.observation.disclosure.sourceTimestampSec >
      XAUT_DISCLOSURE_MAX_AGE_SEC
  ) {
    return "XAUT transparency disclosure time is invalid";
  }
  const identityError = xautLockMintIdentityValidationError(
    attribution.observation,
  );
  if (identityError) return identityError;

  const circulatingLiabilityRaw =
    BigInt(attribution.observation.disclosure.totalAuthorizedRaw) -
    BigInt(attribution.observation.disclosure.notIssuedRaw);
  const expected = expectedSupplyRows(
    input.aggregateSupplyUsd,
    circulatingLiabilityRaw,
    BigInt(attribution.observation.adapterLockedSupplyRaw),
  );
  if (!expected) return "XAUT lock/mint allocation is invalid";
  const toleranceUsd = Math.max(0.000001, input.aggregateSupplyUsd * 1e-12);
  if (
    Math.abs(
      attribution.canonical.currentSupplyUsd -
        expected.canonicalSupplyUsd,
    ) > toleranceUsd ||
    Math.abs(
      attribution.representationGroup.currentSupplyUsd -
        expected.representationGroupSupplyUsd,
    ) > toleranceUsd ||
    Math.abs(
      attribution.canonical.currentSupplyUsd +
        attribution.representationGroup.currentSupplyUsd -
        input.aggregateSupplyUsd,
    ) > toleranceUsd
  ) {
    return "XAUT lock/mint allocation does not conserve aggregate supply";
  }
  return null;
}

export function deriveXautRepresentationGroupSupplyAttribution(input: {
  aggregateSupplyUsd: number;
  registryFingerprint: string;
  scoringClockSec: number;
  observation: XautLockMintObservation;
}): XautRepresentationGroupSupplyAttributionV2 | null {
  const inventory = buildXautRepresentationGroupInventory();
  const identityError = xautLockMintIdentityValidationError(input.observation);
  if (!inventory || identityError) return null;
  const circulatingLiabilityRaw =
    BigInt(input.observation.disclosure.totalAuthorizedRaw) -
    BigInt(input.observation.disclosure.notIssuedRaw);
  const rows = expectedSupplyRows(
    input.aggregateSupplyUsd,
    circulatingLiabilityRaw,
    BigInt(input.observation.adapterLockedSupplyRaw),
  );
  if (!rows) return null;

  const attribution: XautRepresentationGroupSupplyAttributionV2 = {
    model: "canonical-lock-mint-group-partition-v2",
    assetId: XAUT_ASSET_ID,
    observedAtSec: Math.max(
      input.observation.blockTimeSec,
      input.observation.disclosure.sourceTimestampSec,
    ),
    registryFingerprint: input.registryFingerprint,
    routeInventoryDigest: inventory.digest,
    canonical: {
      routeId: inventory.canonicalRouteId,
      chainId: XAUT_CANONICAL_CHAIN_ID,
      currentSupplyUsd: rows.canonicalSupplyUsd,
    },
    representationGroup: {
      deploymentRouteKey: v9RepresentationGroupRouteKey(
        XAUT_ASSET_ID,
        XAUT_REPRESENTATION_ID,
      ),
      representationId: inventory.representationId,
      routeIds: inventory.routes.map((route) => route.routeId),
      riskTier: inventory.riskTier,
      failureDomainKeys: canonicalStrings([
        ...inventory.commonFailureDomainKeys,
        XAUT0_ADAPTER_FAILURE_DOMAIN,
      ]),
      currentSupplyUsd: rows.representationGroupSupplyUsd,
    },
    observation: input.observation,
  };
  return xautRepresentationGroupAttributionValidationError({
    attribution,
    aggregateSupplyUsd: input.aggregateSupplyUsd,
    registryFingerprint: input.registryFingerprint,
    clockSec: input.scoringClockSec,
  }) === null
    ? attribution
    : null;
}

export function normalizeXautRepresentationGroupAttribution(
  attribution: XautRepresentationGroupSupplyAttributionV2,
): XautRepresentationGroupSupplyAttributionV2 {
  return {
    ...attribution,
    representationGroup: {
      ...attribution.representationGroup,
      routeIds: [...attribution.representationGroup.routeIds].sort(
        compareText,
      ),
      failureDomainKeys: canonicalStrings(
        attribution.representationGroup.failureDomainKeys,
      ),
    },
  };
}
