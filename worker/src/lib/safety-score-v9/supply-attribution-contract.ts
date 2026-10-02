import { CHAIN_META, resolveChainId } from "@shared/lib/chains";
import { SUPPLY_ATTRIBUTION_RPC_URLS } from "@shared/lib/chain-rpc-registry";
import { compareText } from "@shared/lib/safety-score-v9/primitives";
import { WM_SUPPLY_ATTRIBUTION_MAX_POST_CLOCK_SEC } from "@shared/lib/safety-score-v9-supply-attribution-journal";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import reviewedEconomicSupplyPlans from "@shared/data/safety-score-v9/supply-attribution-reviews-v1.json";
import { isFixedDecimalDeployment } from "@shared/lib/deployment-amounts";
import type { BridgeRouteRiskProfile, StablecoinMeta } from "@shared/types/core";
import { ReviewedEconomicSupplyPlanFileSchema, ReviewedEconomicSupplyPlanSchema, ReviewedEconomicDeploymentPartitionSchema, type ReviewedEconomicSupplyPlan, type ReviewedEconomicDeploymentPartition, type EconomicSupplyObservation, type EconomicSupplyReference } from "@shared/types/safety-score-v9-supply-attribution";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import { normalizeDeploymentId } from "@shared/lib/deployment-id";

const REVIEWED_DEPLOYMENT_SUPPLY_MAX_AGE_SEC = V9_CANDIDATE_POLICY_V1.policy.semantic.supplyAttribution.observationMaxAgeSec;
const REVIEWED_DEPLOYMENT_SUPPLY_MAX_SKEW_SEC = V9_CANDIDATE_POLICY_V1.policy.semantic.supplyAttribution.observationMaxSkewSec;

const EVM_ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const EVM_BLOCK_HASH_RE = /^0x[0-9a-f]{64}$/;
const SOLANA_BLOCK_HASH_RE = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const RAW_SUPPLY_RE = /^(0|[1-9][0-9]*)$/;
const ROUTE_INVENTORY_DIGEST_DOMAIN = "safety-score-v9.reviewed-deployment-route-inventory.v1";
const SHARE_SCALE = 10n ** 18n;

export interface ReviewedDeploymentRouteInventoryRow {
  routeId: string;
  chainId: string;
  contractAddress: string;
  decimals: number;
  reviewDisposition: "reviewed" | "unreviewed";
  controllerAddress?: string;
}

export interface ReviewedDeploymentRouteInventory {
  assetId: string;
  digest: string;
  routes: ReviewedDeploymentRouteInventoryRow[];
}

export interface ReviewedDeploymentSupplyObservation {
  routeId: string;
  chainId: string;
  contractAddress: string;
  decimals: number;
  rawSupply: string;
  blockNumberOrSlot: string;
  blockTimeSec: number;
  blockHash: string;
  runtimeCodeSha256?: string;
  implementationAddress?: string;
  implementationCodeSha256?: string;
  underlyingTokenAddress?: string;
  controllerAddress?: string;
  controllerProgramOwner?: string;
  programOwner?: string;
  mintAuthority?: string;
}

export interface ReviewedDeploymentSupplyRow extends ReviewedDeploymentSupplyObservation {
  currentSupplyUsd: number;
}

export interface ReviewedDeploymentUnitPartitionV1 {
  model: "reviewed-deployment-unit-partition-v1";
  assetId: string;
  observedAtSec: number;
  captureStartedAtSec: number;
  captureEndedAtSec: number;
  registryFingerprint: string;
  routeInventoryDigest: string;
  deployments: ReviewedDeploymentSupplyRow[];
}

export interface ReviewedDeploymentObservationTimingIssue {
  code: "invalid-envelope" | "cross-chain-skew" | "future-clock" | "stale";
  failedRouteId: string | null;
}

interface WmEvmIdentity {
  runtime: "evm";
  runtimeCodeSha256: string;
  implementationAddress: string;
  implementationCodeSha256: string;
  underlyingTokenAddress: string;
  controllerAddress: string;
  controllerRead: "minter-gateway" | "portal";
}

interface WmSolanaIdentity {
  runtime: "solana";
  programOwner: string;
  mintAuthority: string;
  controllerAddress: string;
  controllerProgramOwner: string;
}

export type WmDeploymentIdentity = WmEvmIdentity | WmSolanaIdentity;

export interface CentrifugeEvmDeploymentIdentity {
  runtime: "evm";
  liabilityModel: "protocol-burn-mint";
  runtimeCodeSha256: string;
  controllerAddress: string;
  safeBlockLag: number;
  extraRpcUrls?: readonly string[];
}

export interface CentrifugeSolanaDeploymentIdentity {
  runtime: "solana";
  liabilityModel: "protocol-burn-mint";
  programOwner: string;
  mintAuthority: string;
  controllerAddress: string;
  controllerProgramOwner: string;
}

export type CentrifugeDeploymentIdentity =
  | CentrifugeEvmDeploymentIdentity
  | CentrifugeSolanaDeploymentIdentity;

const WM_V1_IMPLEMENTATION = "0x813b926b1d096e117721bd1eb017fba122302da0";
const WM_ARBITRUM_V2_IMPLEMENTATION = "0x3bb83030f5f784b3dc2c6af5d7e77f7c39d65804";
const WM_BASE_V2_IMPLEMENTATION = "0xb1bb9f97af604385eb69212f34d986073ac6693c";
const WM_ETHEREUM_V2_IMPLEMENTATION = "0x6d9db63afccf515f393d5e65be69d38bb3b29d13";
const WM_UNDERLYING_M = "0x866a2bf4e572cbcf37d5071a7a58503bfb36be1b";
const M0_PORTAL = "0xd925c84b55e4e44a53749ff5f2a5a13f63d128fd";

const WM_DEPLOYMENT_IDENTITIES: Readonly<Record<string, WmDeploymentIdentity>> = {
  "ethereum:0x437cc33344a0b27a429f795ff6b469c72698b291": {
    runtime: "evm",
    runtimeCodeSha256: "ef515e6adf8e4349bd060bbfe7472b8cb69b4ca89db7f94af138a0c82cfaa63a",
    implementationAddress: WM_ETHEREUM_V2_IMPLEMENTATION,
    implementationCodeSha256: "a70202e1437227a8f6229324cffdde3375eb31d2b2231a90e55ea01c58aeac8e",
    underlyingTokenAddress: WM_UNDERLYING_M,
    controllerAddress: "0xf7f9638cb444d65e5a40bf5ff98ebe4ff319f04e",
    controllerRead: "minter-gateway",
  },
  "arbitrum:0x437cc33344a0b27a429f795ff6b469c72698b291": {
    runtime: "evm",
    runtimeCodeSha256: "5c1fe46e765b84b11e490af16edddffaa6a162eac8bf26e7a0449cfaa42bceae",
    implementationAddress: WM_ARBITRUM_V2_IMPLEMENTATION,
    implementationCodeSha256: "92b85ef0789e99456c8326dcff26c19e179adab47a71c2ca13179274d26e278c",
    underlyingTokenAddress: WM_UNDERLYING_M,
    controllerAddress: M0_PORTAL,
    controllerRead: "portal",
  },
  "base:0x437cc33344a0b27a429f795ff6b469c72698b291": {
    runtime: "evm",
    runtimeCodeSha256: "961610d5a1d1ddab57ececfd095b6fd6a1a0c8d3026f9af70759196f1dffa9d2",
    implementationAddress: WM_BASE_V2_IMPLEMENTATION,
    implementationCodeSha256: "c8a546e7bad03f58acf5e982738bb07ebb24b9774b9a69515e41012fd51d61b1",
    underlyingTokenAddress: WM_UNDERLYING_M,
    controllerAddress: M0_PORTAL,
    controllerRead: "portal",
  },
  "plume:0x437cc33344a0b27a429f795ff6b469c72698b291": {
    runtime: "evm",
    runtimeCodeSha256: "692615a84165d49ceb5c60125c65d21c1d379d3d1da7b03c984d6f9951094f58",
    implementationAddress: WM_V1_IMPLEMENTATION,
    implementationCodeSha256: "8a3f761b3d5fde864819ce415092d2f8127ee002813ce83a341a053202eb16a0",
    underlyingTokenAddress: WM_UNDERLYING_M,
    controllerAddress: "0x36f586a30502ae3afb555b8aa4dcc05d233c2ece",
    controllerRead: "portal",
  },
  "solana:mzeroXDoBpRVhnEXBra27qzAMdxgpWVY3DzQW7xMVJp": {
    runtime: "solana",
    programOwner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    mintAuthority: "Anfx7wng5TEe5UrkFKTirtADBawmtRs9KoD15BUbEmvT",
    controllerAddress: "mzp1q2j5Hr1QuLC3KFBCAUz5aUckT6qyuZKZ3WJnMmY",
    controllerProgramOwner: "BPFLoaderUpgradeab1e11111111111111111111111",
  },
};

const CENTRIFUGE_V3_SPOKE_ADDRESS =
  "0xec3582fcdc34078a4b7a8c75a5a3ae46f48525ab";
const CENTRIFUGE_SOLANA_MINT_AUTHORITY =
  "3JiU6sJt94WcD6r7EFTUnJo6By9DJ9WJxovRGfY9oseb";
const SOLANA_TOKEN_2022_PROGRAM =
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const SOLANA_SYSTEM_PROGRAM = "11111111111111111111111111111111";

const CENTRIFUGE_BURN_MINT_DEPLOYMENT_IDENTITIES: Readonly<
  Record<string, Readonly<Record<string, CentrifugeDeploymentIdentity>>>
> = {
  "jtrsy-anemoy": {
    "ethereum:0x8c213ee79581ff4984583c6a801e5263418c4b86": {
      runtime: "evm",
      liabilityModel: "protocol-burn-mint",
      runtimeCodeSha256:
        "8a1922fd0a610c5408c2fedcf59694120a00c71e2fe0cc411b398a6088aa22c4",
      controllerAddress: CENTRIFUGE_V3_SPOKE_ADDRESS,
      safeBlockLag: 2,
    },
    "base:0x8c213ee79581ff4984583c6a801e5263418c4b86": {
      runtime: "evm",
      liabilityModel: "protocol-burn-mint",
      runtimeCodeSha256:
        "7215d5b91d33b4e1d1d40a5e57a665d79e83bc1d059dbbf6ad23ae031b472af8",
      controllerAddress: CENTRIFUGE_V3_SPOKE_ADDRESS,
      safeBlockLag: 12,
    },
    "arbitrum:0x8c213ee79581ff4984583c6a801e5263418c4b86": {
      runtime: "evm",
      liabilityModel: "protocol-burn-mint",
      runtimeCodeSha256:
        "37692f6a0b36e15fbd2dad86bba1b2e64c2967ebbb4257fe39587c6ee47d5abd",
      controllerAddress: CENTRIFUGE_V3_SPOKE_ADDRESS,
      safeBlockLag: 96,
    },
    "avalanche:0xa5d465251fbcc907f5dd6bb2145488dfc6a2627b": {
      runtime: "evm",
      liabilityModel: "protocol-burn-mint",
      runtimeCodeSha256:
        "2a7fd349137bf64fdc2d0c295a48dcaf728539a3a98cd99a4143f28acb2afe47",
      controllerAddress: CENTRIFUGE_V3_SPOKE_ADDRESS,
      safeBlockLag: 10,
    },
    "plume:0xa5d465251fbcc907f5dd6bb2145488dfc6a2627b": {
      runtime: "evm",
      liabilityModel: "protocol-burn-mint",
      runtimeCodeSha256:
        "390adf7418ac002dcb256005648f81dced42b36976d93d0007112fe75b17ea0b",
      controllerAddress: CENTRIFUGE_V3_SPOKE_ADDRESS,
      safeBlockLag: 24,
      extraRpcUrls: SUPPLY_ATTRIBUTION_RPC_URLS.plume,
    },
    "bsc:0xa5d465251fbcc907f5dd6bb2145488dfc6a2627b": {
      runtime: "evm",
      liabilityModel: "protocol-burn-mint",
      runtimeCodeSha256:
        "3350d2cf5af41a41e141d5becfb2f0e6b3aa3fdb29947f222c00e728d4b72396",
      controllerAddress: CENTRIFUGE_V3_SPOKE_ADDRESS,
      safeBlockLag: 30,
    },
    "monad:0xc18e6f730896971a79d748e8dea61067a9bc6040": {
      runtime: "evm",
      liabilityModel: "protocol-burn-mint",
      runtimeCodeSha256:
        "48d61022deeca312150f0a1fcf585e5e0fcb55d0e6c620c1880a7bcccd56173f",
      controllerAddress: CENTRIFUGE_V3_SPOKE_ADDRESS,
      safeBlockLag: 10,
      extraRpcUrls: SUPPLY_ATTRIBUTION_RPC_URLS.monad,
    },
    "solana:JTRu97Z4oduVwfVBWdf1fSAz8h7CBBPqEo4Jco9fZPj": {
      runtime: "solana",
      liabilityModel: "protocol-burn-mint",
      programOwner: SOLANA_TOKEN_2022_PROGRAM,
      mintAuthority: CENTRIFUGE_SOLANA_MINT_AUTHORITY,
      controllerAddress: CENTRIFUGE_SOLANA_MINT_AUTHORITY,
      controllerProgramOwner: SOLANA_SYSTEM_PROGRAM,
    },
  },
  "acrdx-anemoy-apollo": {
    "ethereum:0x9477724bb54ad5417de8baff29e59df3fb4da74f": {
      runtime: "evm",
      liabilityModel: "protocol-burn-mint",
      runtimeCodeSha256:
        "4013ef4e7e372b27a793ddb12e1ac86b6cd6677f361014d3c06a61e7171cc6e1",
      controllerAddress: CENTRIFUGE_V3_SPOKE_ADDRESS,
      safeBlockLag: 2,
    },
    "plume:0x9477724bb54ad5417de8baff29e59df3fb4da74f": {
      runtime: "evm",
      liabilityModel: "protocol-burn-mint",
      runtimeCodeSha256:
        "0212b631a7889adf5f74857c3768a211a2a25dce9c57e5630d25f6f1c056860c",
      controllerAddress: CENTRIFUGE_V3_SPOKE_ADDRESS,
      safeBlockLag: 24,
      extraRpcUrls: SUPPLY_ATTRIBUTION_RPC_URLS.plume,
    },
    "monad:0x2fabf1c784b8583d63c00c5c9c0377d8cf1a3245": {
      runtime: "evm",
      liabilityModel: "protocol-burn-mint",
      runtimeCodeSha256:
        "5c903ebeaedc9bbbef618bab8106f93c4fae50fb2b8e15870bf346056f9bd1c5",
      controllerAddress: CENTRIFUGE_V3_SPOKE_ADDRESS,
      safeBlockLag: 10,
      extraRpcUrls: SUPPLY_ATTRIBUTION_RPC_URLS.monad,
    },
    "optimism:0x2fabf1c784b8583d63c00c5c9c0377d8cf1a3245": {
      runtime: "evm",
      liabilityModel: "protocol-burn-mint",
      runtimeCodeSha256:
        "799525537471dc553ff39869d51105dd1ed4965cb205343248c76b8b6f1c33b6",
      controllerAddress: CENTRIFUGE_V3_SPOKE_ADDRESS,
      safeBlockLag: 12,
    },
    "base:0x9477724bb54ad5417de8baff29e59df3fb4da74f": {
      runtime: "evm",
      liabilityModel: "protocol-burn-mint",
      runtimeCodeSha256:
        "2d9d20e9b8c196f718da3e531685c39a9e562f1ca30fd4c2483a4b42e0813a08",
      controllerAddress: CENTRIFUGE_V3_SPOKE_ADDRESS,
      safeBlockLag: 12,
    },
    "solana:ACDR3LGFrMuDZSDRyJjncFCzo5c8xkQxhWx4im4Vmq8G": {
      runtime: "solana",
      liabilityModel: "protocol-burn-mint",
      programOwner: SOLANA_TOKEN_2022_PROGRAM,
      mintAuthority: CENTRIFUGE_SOLANA_MINT_AUTHORITY,
      controllerAddress: CENTRIFUGE_SOLANA_MINT_AUTHORITY,
      controllerProgramOwner: SOLANA_SYSTEM_PROGRAM,
    },
  },
};

export const CENTRIFUGE_BURN_MINT_ASSET_IDS = Object.freeze(
  Object.keys(CENTRIFUGE_BURN_MINT_DEPLOYMENT_IDENTITIES).sort(compareText),
);

function routeChain(routeId: string): string | null {
  const separator = routeId.indexOf(":");
  if (separator <= 0) return null;
  return resolveChainId(routeId.slice(0, separator)) ?? routeId.slice(0, separator).toLowerCase();
}

function normalizeAddress(chainId: string, address: string): string {
  return CHAIN_META[chainId]?.type === "evm" ? address.toLowerCase() : address;
}

function routeAddress(routeId: string): string | null {
  const separator = routeId.indexOf(":");
  return separator <= 0 || separator === routeId.length - 1 ? null : routeId.slice(separator + 1);
}

export function buildReviewedDeploymentRouteInventory(
  assetId: string,
): ReviewedDeploymentRouteInventory | null {
  const meta = ACTIVE_META_BY_ID.get(assetId);
  const routes = meta?.bridgeRouteRisk?.routes ?? [];
  const contracts = meta?.contracts ?? [];
  if (routes.length === 0 || routes.length !== contracts.length) return null;
  if (contracts.some(contract => !isFixedDecimalDeployment(contract))) return null;

  const remainingContracts = contracts.map((contract) => {
    const chainId = resolveChainId(contract.chain) ?? contract.chain.toLowerCase();
    return {
      chainId,
      contractAddress: normalizeAddress(chainId, contract.address),
      decimals: isFixedDecimalDeployment(contract) ? contract.decimals : null,
      matched: false,
    };
  });

  const inventoryRows: ReviewedDeploymentRouteInventoryRow[] = [];
  for (const route of routes) {
    const chainId = routeChain(route.id);
    const rawContractAddress = route.contractAddress ?? routeAddress(route.id);
    if (chainId === null || rawContractAddress === null) return null;
    const contractAddress = normalizeAddress(chainId, rawContractAddress);
    const contract = remainingContracts.find(
      (candidate) =>
        !candidate.matched &&
        candidate.chainId === chainId &&
        candidate.contractAddress === contractAddress,
    );
    if (!contract || contract.decimals === null || !Number.isInteger(contract.decimals) || contract.decimals < 0 || contract.decimals > 36) {
      return null;
    }
    contract.matched = true;
    inventoryRows.push({
      routeId: route.id,
      chainId,
      contractAddress,
      decimals: contract.decimals,
      reviewDisposition: route.reviewDisposition === "reviewed" ? "reviewed" : "unreviewed",
      ...(route.controllerAddress
        ? { controllerAddress: normalizeAddress(chainId, route.controllerAddress) }
        : {}),
    });
  }
  if (remainingContracts.some((contract) => !contract.matched)) return null;

  const canonicalRows = inventoryRows.sort((left, right) => compareText(left.routeId, right.routeId));
  return {
    assetId,
    digest: sha256Hex(
      stableJsonStringifyV1({
        domain: ROUTE_INVENTORY_DIGEST_DOMAIN,
        assetId,
        routes: canonicalRows,
      }),
    ),
    routes: canonicalRows,
  };
}

function normalizedRawSupplies(
  observations: readonly ReviewedDeploymentSupplyObservation[],
): bigint[] | null {
  if (observations.length === 0) return null;
  const maxDecimals = Math.max(...observations.map((observation) => observation.decimals));
  if (!Number.isInteger(maxDecimals) || maxDecimals < 0 || maxDecimals > 36) return null;

  const normalized: bigint[] = [];
  for (const observation of observations) {
    if (
      !Number.isInteger(observation.decimals) ||
      observation.decimals < 0 ||
      observation.decimals > maxDecimals ||
      !RAW_SUPPLY_RE.test(observation.rawSupply)
    ) {
      return null;
    }
    normalized.push(BigInt(observation.rawSupply) * 10n ** BigInt(maxDecimals - observation.decimals));
  }
  return normalized;
}

function allocateAggregateSupply(
  aggregateSupplyUsd: number,
  observations: readonly ReviewedDeploymentSupplyObservation[],
): ReviewedDeploymentSupplyRow[] | null {
  if (!Number.isFinite(aggregateSupplyUsd) || aggregateSupplyUsd <= 0) return null;
  const normalized = normalizedRawSupplies(observations);
  if (!normalized) return null;
  const totalRaw = normalized.reduce((sum, value) => sum + value, 0n);
  if (totalRaw <= 0n) return null;

  let residualIndex = normalized.length - 1;
  while (residualIndex >= 0 && normalized[residualIndex] === 0n) residualIndex -= 1;
  if (residualIndex < 0) return null;

  let allocatedUsd = 0;
  const currentSupplyUsd = normalized.map((rawSupply, index) => {
    if (index === residualIndex) return 0;
    const shareScaled = (rawSupply * SHARE_SCALE) / totalRaw;
    const supplyUsd = aggregateSupplyUsd * (Number(shareScaled) / Number(SHARE_SCALE));
    allocatedUsd += supplyUsd;
    return supplyUsd;
  });
  currentSupplyUsd[residualIndex] = aggregateSupplyUsd - allocatedUsd;

  return observations.map((observation, index) => ({
    ...observation,
    currentSupplyUsd: currentSupplyUsd[index]!,
  }));
}

function expectedReviewedDeploymentIdentity(
  assetId: string,
  routeId: string,
): WmDeploymentIdentity | CentrifugeDeploymentIdentity | undefined {
  return assetId === "wm-m0"
    ? WM_DEPLOYMENT_IDENTITIES[routeId]
    : CENTRIFUGE_BURN_MINT_DEPLOYMENT_IDENTITIES[assetId]?.[routeId];
}

function reviewedDeploymentInventoryValidationError(
  assetId: string,
  inventory: ReviewedDeploymentRouteInventory,
  observations: readonly ReviewedDeploymentSupplyObservation[],
): string | null {
  if (assetId === "wm-m0") return null;
  const identities = CENTRIFUGE_BURN_MINT_DEPLOYMENT_IDENTITIES[assetId];
  const meta = ACTIVE_META_BY_ID.get(assetId);
  const routes = meta?.bridgeRouteRisk?.routes ?? [];
  if (!identities || routes.length !== inventory.routes.length) {
    return `unsupported reviewed deployment attribution asset ${assetId}`;
  }
  const identityRouteIds = Object.keys(identities).sort(compareText);
  if (
    identityRouteIds.length !== inventory.routes.length ||
    identityRouteIds.some(
      (routeId, index) => routeId !== inventory.routes[index]?.routeId,
    )
  ) {
    return `reviewed deployment identity inventory mismatch for ${assetId}`;
  }
  for (const route of routes) {
    // Positive zero evidence removes this deployment's accounting ambiguity,
    // not its unresolved control posture. The full packet still has to pass
    // the route, runtime identity and same-generation timing gates below.
    if (
      route.reviewDisposition !== "reviewed" &&
      observations.some((row) => row.routeId === route.id && row.rawSupply === "0")
    ) {
      continue;
    }
    if (
      route.reviewDisposition !== "reviewed" ||
      (route.semantics !== "native-mint" && route.semantics !== "burn-mint") ||
      (route.issuanceModel !== "native-issuance" &&
        route.issuanceModel !== "bridge-representation") ||
      route.representationId != null
    ) {
      return `reviewed deployment liability model is unsupported for ${assetId}:${route.id}`;
    }
  }
  return null;
}

export function reviewedDeploymentIdentityValidationError(
  row: ReviewedDeploymentSupplyObservation,
  assetId = "wm-m0",
  expectedDeployment?: { chainId: string; contractAddress: string },
): string | null {
  if (expectedDeployment) {
    return row.chainId === expectedDeployment.chainId &&
      normalizeReviewedDeploymentAddress(row.chainId, row.contractAddress) ===
        normalizeReviewedDeploymentAddress(expectedDeployment.chainId, expectedDeployment.contractAddress)
      ? null
      : `reviewed deployment identity mismatch for ${row.routeId}`;
  }
  const expected = expectedReviewedDeploymentIdentity(assetId, row.routeId);
  if (!expected) return `unsupported reviewed deployment ${assetId}:${row.routeId}`;
  if (expected.runtime === "evm") {
    if ("liabilityModel" in expected) {
      if (
        row.runtimeCodeSha256 !== expected.runtimeCodeSha256 ||
        row.controllerAddress?.toLowerCase() !== expected.controllerAddress ||
        row.implementationAddress !== undefined ||
        row.implementationCodeSha256 !== undefined ||
        row.underlyingTokenAddress !== undefined
      ) {
        return `Centrifuge EVM identity mismatch for ${row.routeId}`;
      }
      if (
        !SHA256_RE.test(row.runtimeCodeSha256) ||
        !EVM_ADDRESS_RE.test(row.controllerAddress?.toLowerCase() ?? "")
      ) {
        return `malformed Centrifuge EVM identity for ${row.routeId}`;
      }
      return null;
    }
    if (
      row.runtimeCodeSha256 !== expected.runtimeCodeSha256 ||
      row.implementationAddress?.toLowerCase() !== expected.implementationAddress ||
      row.implementationCodeSha256 !== expected.implementationCodeSha256 ||
      row.underlyingTokenAddress?.toLowerCase() !== expected.underlyingTokenAddress ||
      row.controllerAddress?.toLowerCase() !== expected.controllerAddress
    ) {
      return `wM EVM identity mismatch for ${row.routeId}`;
    }
    if (
      !SHA256_RE.test(row.runtimeCodeSha256) ||
      !SHA256_RE.test(row.implementationCodeSha256 ?? "") ||
      !EVM_ADDRESS_RE.test(row.implementationAddress?.toLowerCase() ?? "") ||
      !EVM_ADDRESS_RE.test(row.underlyingTokenAddress?.toLowerCase() ?? "") ||
      !EVM_ADDRESS_RE.test(row.controllerAddress?.toLowerCase() ?? "")
    ) {
      return `malformed wM EVM identity for ${row.routeId}`;
    }
    return null;
  }

  if (
    row.programOwner !== expected.programOwner ||
    row.mintAuthority !== expected.mintAuthority ||
    row.controllerAddress !== expected.controllerAddress ||
    row.controllerProgramOwner !== expected.controllerProgramOwner
  ) {
    return `wM Solana identity mismatch for ${row.routeId}`;
  }
  return null;
}

function hasValidBlockHash(
  assetId: string,
  row: ReviewedDeploymentSupplyRow,
): boolean {
  const expected = expectedReviewedDeploymentIdentity(assetId, row.routeId);
  if (!expected) return false;
  return expected.runtime === "evm"
    ? EVM_BLOCK_HASH_RE.test(row.blockHash)
    : SOLANA_BLOCK_HASH_RE.test(row.blockHash);
}

function boundaryRouteId(
  deployments: readonly Pick<ReviewedDeploymentSupplyObservation, "routeId" | "blockTimeSec">[],
  boundary: "earliest" | "latest",
): string | null {
  const sorted = [...deployments].sort(
    (left, right) =>
      left.blockTimeSec - right.blockTimeSec ||
      compareText(left.routeId, right.routeId),
  );
  return (boundary === "earliest" ? sorted[0] : sorted[sorted.length - 1])?.routeId ?? null;
}

export function reviewedDeploymentObservationTimingIssue(input: {
  assetId?: string;
  clockSec: number;
  captureStartedAtSec: number;
  captureEndedAtSec: number;
  observedAtSec: number;
  deployments: readonly Pick<ReviewedDeploymentSupplyObservation, "routeId" | "blockTimeSec">[];
}): ReviewedDeploymentObservationTimingIssue | null {
  if (
    !Number.isInteger(input.clockSec) ||
    input.clockSec < 0 ||
    !Number.isInteger(input.captureStartedAtSec) ||
    !Number.isInteger(input.captureEndedAtSec) ||
    !Number.isInteger(input.observedAtSec) ||
    input.captureStartedAtSec < 0 ||
    input.deployments.length === 0
  ) {
    return { code: "invalid-envelope", failedRouteId: null };
  }
  const invalidDeployment = input.deployments.find(
    (row) => !Number.isInteger(row.blockTimeSec) || row.blockTimeSec < 0,
  );
  if (invalidDeployment) {
    return {
      code: "invalid-envelope",
      failedRouteId: invalidDeployment.routeId,
    };
  }

  const blockTimes = input.deployments.map((row) => row.blockTimeSec);
  const earliestBlockTimeSec = Math.min(...blockTimes);
  const latestBlockTimeSec = Math.max(...blockTimes);
  if (
    input.captureStartedAtSec !== earliestBlockTimeSec ||
    input.captureEndedAtSec !== latestBlockTimeSec ||
    input.captureStartedAtSec > input.captureEndedAtSec ||
    input.observedAtSec !== input.captureEndedAtSec
  ) {
    return { code: "invalid-envelope", failedRouteId: null };
  }
  if (
    (input.assetId ?? "wm-m0") === "wm-m0" &&
    input.observedAtSec - input.clockSec >
      WM_SUPPLY_ATTRIBUTION_MAX_POST_CLOCK_SEC
  ) {
    return {
      code: "future-clock",
      failedRouteId: boundaryRouteId(input.deployments, "latest"),
    };
  }
  if (
    input.captureEndedAtSec - input.captureStartedAtSec >
    REVIEWED_DEPLOYMENT_SUPPLY_MAX_SKEW_SEC
  ) {
    return {
      code: "cross-chain-skew",
      failedRouteId: boundaryRouteId(input.deployments, "latest"),
    };
  }
  if (input.captureStartedAtSec > input.clockSec) {
    return {
      code: "future-clock",
      failedRouteId: boundaryRouteId(input.deployments, "earliest"),
    };
  }
  const futureUnsupportedBySource = input.deployments.find((row) => {
    const assetId = input.assetId ?? "wm-m0";
    const identity = expectedReviewedDeploymentIdentity(
      assetId,
      row.routeId,
    );
    return (
      row.blockTimeSec > input.clockSec &&
      (assetId !== "wm-m0" || identity?.runtime !== "solana")
    );
  });
  if (futureUnsupportedBySource) {
    return {
      code: "future-clock",
      failedRouteId: futureUnsupportedBySource.routeId,
    };
  }
  if (input.clockSec - input.observedAtSec > REVIEWED_DEPLOYMENT_SUPPLY_MAX_AGE_SEC) {
    return {
      code: "stale",
      failedRouteId: boundaryRouteId(input.deployments, "latest"),
    };
  }
  return null;
}

export function reviewedDeploymentAttributionValidationError(input: {
  assetId: string;
  attribution: ReviewedDeploymentUnitPartitionV1;
  aggregateSupplyUsd: number;
  registryFingerprint: string;
  clockSec: number;
}): string | null {
  const { assetId, attribution } = input;
  if (
    attribution.assetId !== assetId ||
    (assetId !== "wm-m0" &&
      CENTRIFUGE_BURN_MINT_DEPLOYMENT_IDENTITIES[assetId] == null)
  ) {
    return `unsupported reviewed deployment attribution asset ${assetId}`;
  }
  if (attribution.registryFingerprint !== input.registryFingerprint) {
    return `reviewed deployment registry fingerprint mismatch for ${assetId}`;
  }
  const inventory = buildReviewedDeploymentRouteInventory(assetId);
  if (!inventory || attribution.routeInventoryDigest !== inventory.digest) {
    return `reviewed deployment route inventory mismatch for ${assetId}`;
  }
  const inventoryError = reviewedDeploymentInventoryValidationError(
    assetId,
    inventory,
    attribution.deployments,
  );
  if (inventoryError) return inventoryError;
  if (attribution.deployments.length !== inventory.routes.length) {
    return `reviewed deployment route count mismatch for ${assetId}`;
  }

  const deployments = [...attribution.deployments].sort((left, right) =>
    compareText(left.routeId, right.routeId),
  );
  if (new Set(deployments.map((row) => row.routeId)).size !== deployments.length) {
    return `duplicate reviewed deployment route for ${assetId}`;
  }
  const timingIssue = reviewedDeploymentObservationTimingIssue({
    assetId,
    clockSec: input.clockSec,
    captureStartedAtSec: attribution.captureStartedAtSec,
    captureEndedAtSec: attribution.captureEndedAtSec,
    observedAtSec: attribution.observedAtSec,
    deployments,
  });
  if (timingIssue) {
    return `reviewed deployment observation time is invalid for ${assetId}: ${timingIssue.code}`;
  }

  for (let index = 0; index < inventory.routes.length; index += 1) {
    const expected = inventory.routes[index]!;
    const row = deployments[index]!;
    if (
      row.routeId !== expected.routeId ||
      row.chainId !== expected.chainId ||
      normalizeAddress(row.chainId, row.contractAddress) !== expected.contractAddress ||
      row.decimals !== expected.decimals ||
      !RAW_SUPPLY_RE.test(row.rawSupply) ||
      !/^(0|[1-9][0-9]*)$/.test(row.blockNumberOrSlot) ||
      !Number.isInteger(row.blockTimeSec) ||
      !hasValidBlockHash(assetId, row) ||
      row.blockTimeSec < attribution.captureStartedAtSec ||
      row.blockTimeSec > attribution.captureEndedAtSec
    ) {
      return `reviewed deployment route observation mismatch for ${assetId}:${row.routeId}`;
    }
    const identityError = reviewedDeploymentIdentityValidationError(
      row,
      assetId,
    );
    if (identityError) return identityError;
  }

  const expectedRows = allocateAggregateSupply(input.aggregateSupplyUsd, deployments);
  if (!expectedRows) return `reviewed deployment allocation is invalid for ${assetId}`;
  const toleranceUsd = Math.max(V9_CANDIDATE_POLICY_V1.policy.semantic.supplyAttribution.conservationAbsoluteToleranceUsd,
    input.aggregateSupplyUsd * V9_CANDIDATE_POLICY_V1.policy.semantic.supplyAttribution.conservationRelativeTolerance);
  for (let index = 0; index < deployments.length; index += 1) {
    if (
      !Number.isFinite(deployments[index]!.currentSupplyUsd) ||
      deployments[index]!.currentSupplyUsd < 0 ||
      Math.abs(deployments[index]!.currentSupplyUsd - expectedRows[index]!.currentSupplyUsd) > toleranceUsd
    ) {
      return `reviewed deployment allocation mismatch for ${assetId}:${deployments[index]!.routeId}`;
    }
  }
  return null;
}

export function deriveReviewedDeploymentUnitPartition(input: {
  assetId: string;
  aggregateSupplyUsd: number;
  registryFingerprint: string;
  scoringClockSec: number;
  observations: readonly ReviewedDeploymentSupplyObservation[];
}): ReviewedDeploymentUnitPartitionV1 | null {
  const inventory = buildReviewedDeploymentRouteInventory(input.assetId);
  if (
    !inventory ||
    reviewedDeploymentInventoryValidationError(input.assetId, inventory, input.observations)
  ) {
    return null;
  }

  const observations = [...input.observations].sort((left, right) =>
    compareText(left.routeId, right.routeId),
  );
  const deployments = allocateAggregateSupply(input.aggregateSupplyUsd, observations);
  if (!deployments || deployments.length === 0) return null;
  const blockTimes = deployments.map((row) => row.blockTimeSec);
  const attribution: ReviewedDeploymentUnitPartitionV1 = {
    model: "reviewed-deployment-unit-partition-v1",
    assetId: input.assetId,
    observedAtSec: Math.max(...blockTimes),
    captureStartedAtSec: Math.min(...blockTimes),
    captureEndedAtSec: Math.max(...blockTimes),
    registryFingerprint: input.registryFingerprint,
    routeInventoryDigest: inventory.digest,
    deployments,
  };

  return reviewedDeploymentAttributionValidationError({
    assetId: input.assetId,
    attribution,
    aggregateSupplyUsd: input.aggregateSupplyUsd,
    registryFingerprint: input.registryFingerprint,
    clockSec: input.scoringClockSec,
  }) === null
    ? attribution
    : null;
}

export function normalizeReviewedDeploymentAttribution(
  attribution: ReviewedDeploymentUnitPartitionV1,
): ReviewedDeploymentUnitPartitionV1 {
  return {
    ...attribution,
    deployments: [...attribution.deployments].sort((left, right) =>
      compareText(left.routeId, right.routeId),
    ),
  };
}

export function normalizeReviewedDeploymentAddress(chainId: string, address: string): string {
  return normalizeAddress(chainId, address);
}

export function expectedWmDeploymentIdentity(routeId: string): WmDeploymentIdentity | undefined {
  return WM_DEPLOYMENT_IDENTITIES[routeId];
}

export function expectedCentrifugeDeploymentIdentity(
  assetId: string,
  routeId: string,
): CentrifugeDeploymentIdentity | undefined {
  return CENTRIFUGE_BURN_MINT_DEPLOYMENT_IDENTITIES[assetId]?.[routeId];
}

export const REVIEWED_ECONOMIC_SUPPLY_PLANS: ReadonlyMap<string, ReviewedEconomicSupplyPlan> = new Map(
  ReviewedEconomicSupplyPlanFileSchema.parse(reviewedEconomicSupplyPlans).reviews.map(plan => [plan.assetId, plan]),
);

/** A native liability can still expose bridge message acceptance or escrow control. */
export function reviewedSupplyRouteKind(route: NonNullable<BridgeRouteRiskProfile["routes"]>[number], profile?: Pick<BridgeRouteRiskProfile, "controls">): "native" | "controlled" {
  const controlled = (profile?.controls ?? []).some(control =>
    control.routeRefs.some(ref => normalizeDeploymentId(ref) === normalizeDeploymentId(route.id)) &&
    control.capabilities.some(capability => capability === "bridge-mint" || capability === "bridge-burn" ||
      capability === "validator" || capability === "escrow" || capability === "peer-config" ||
      capability === "upgrade" || capability === "admin"));
  return !controlled && route.routeClass === "native" && route.semantics === "native-mint" ? "native" : "controlled";
}

export function buildReviewedEconomicDeploymentInventory(
  assetId: string,
  plan = REVIEWED_ECONOMIC_SUPPLY_PLANS.get(assetId),
  meta: Pick<StablecoinMeta, "contracts" | "bridgeRouteRisk"> | undefined = ACTIVE_META_BY_ID.get(assetId),
): { plan: ReviewedEconomicSupplyPlan; planDigest: string; digest: string } | null {
  if (!plan || !meta || plan.assetId !== assetId || !ReviewedEconomicSupplyPlanSchema.safeParse(plan).success) return null;
  const keys = new Set(plan.deployments.map(row => row.deploymentKey));
  const excluded = new Set(plan.excludedRegistryDeploymentKeys);
  if ([...excluded].some(key => keys.has(key))) return null;
  if ((meta.bridgeRouteRisk?.routes ?? []).some(route => route.semantics === "burn-mint") &&
    plan.escrows.length === 0 && plan.liabilityInFlightSource === null) return null;
  const registeredKeys = new Set<string>();
  for (const contract of meta.contracts ?? []) {
    const chain = resolveChainId(contract.chain);
    if (!chain) return null;
    const key = `${chain}:${normalizeAddress(chain, contract.address)}`;
    registeredKeys.add(key);
    if (!keys.has(key) && !excluded.has(key)) return null;
    const row = plan.deployments.find(row => row.deploymentKey === key);
    if (row && ((isFixedDecimalDeployment(contract) && row.decimals !== contract.decimals) ||
      (!isFixedDecimalDeployment(contract) && row.decimals !== null))) return null;
  }
  if ([...excluded].some(key => !registeredKeys.has(key))) return null;
  for (const row of plan.deployments) {
    if (row.holdingKind !== "native-gas" && !registeredKeys.has(row.deploymentKey)) return null;
    if (row.routeId !== null && !(meta.bridgeRouteRisk?.routes ?? []).some(route =>
      route.id === row.routeId && resolveChainId(route.destinationChain) === row.chainId &&
      normalizeAddress(row.chainId, route.contractAddress) === row.address)) return null;
  }
  const canonicalPlan = { ...plan,
    deployments: [...plan.deployments].sort((a, b) => compareText(a.deploymentKey, b.deploymentKey)),
    excludedRegistryDeploymentKeys: [...plan.excludedRegistryDeploymentKeys].sort(compareText),
    exclusions: [...plan.exclusions].sort((a, b) => compareText(a.id, b.id)),
    escrows: plan.escrows.map(row => ({ ...row, receiptDeploymentKeys: [...row.receiptDeploymentKeys].sort(compareText) })).sort((a, b) => compareText(a.id, b.id)),
  };
  const planDigest = sha256Hex(stableJsonStringifyV1(canonicalPlan));
  return { plan, planDigest, digest: sha256Hex(stableJsonStringifyV1({
    domain: "safety-score-v9.economic-deployment-census.v1", planDigest,
    contracts: [...(meta.contracts ?? [])].sort((a, b) => compareText(`${a.chain}:${a.address}`, `${b.chain}:${b.address}`)),
    routes: [...(meta.bridgeRouteRisk?.routes ?? [])].sort((a, b) => compareText(a.id, b.id)),
  })) };
}

interface EconomicFraction { n: bigint; d: bigint }
function economicDecimal(value: string, decimals: number | null = null): EconomicFraction {
  if (decimals !== null) return { n: BigInt(value), d: 10n ** BigInt(decimals) };
  const [whole, fraction = ""] = value.split(".");
  return { n: BigInt(whole + fraction), d: 10n ** BigInt(fraction.length) };
}
function addEconomicUnits(a: EconomicFraction, b: EconomicFraction, subtract = false): EconomicFraction {
  let x = a.d, y = b.d;
  while (y !== 0n) { const remainder = x % y; x = y; y = remainder; }
  const leftScale = b.d / x, rightScale = a.d / x;
  return { n: a.n * leftScale + (subtract ? -b.n : b.n) * rightScale, d: a.d * leftScale };
}

/** Recomputes every USD row; a conserved caller-supplied array alone is never proof. */
export function deriveReviewedEconomicDeploymentPartition(input: {
  plan: ReviewedEconomicSupplyPlan; meta?: Pick<StablecoinMeta, "contracts" | "bridgeRouteRisk">;
  baseInputGenerationId: string; sourceGeneration: string; registryFingerprint: string; clockSec: number;
  aggregate: ReviewedEconomicDeploymentPartition["aggregate"];
  referencePrice: EconomicSupplyReference; conversions: EconomicSupplyReference[];
  observations: EconomicSupplyObservation[]; inFlight: EconomicSupplyObservation[];
}): ReviewedEconomicDeploymentPartition | null {
  const inventory = buildReviewedEconomicDeploymentInventory(input.plan.assetId, input.plan, input.meta);
  const policy = V9_CANDIDATE_POLICY_V1.policy.semantic.supplyAttribution;
  const current = (clock: number, budget: number) => Number.isInteger(clock) && clock <= input.clockSec && input.clockSec - clock <= budget;
  if (!inventory || input.clockSec < input.plan.reviewedAtSec || input.clockSec >= input.plan.expiresAtSec ||
    !current(input.aggregate.observedAtSec, policy.observationMaxAgeSec) ||
    input.aggregate.sourceGeneration !== input.sourceGeneration ||
    !current(input.referencePrice.observedAtSec, policy.referencePriceMaxAgeSec) ||
    input.referencePrice.sourceId !== input.plan.sourceId ||
    input.conversions.some(row => !current(row.observedAtSec, policy.referencePriceMaxAgeSec))) return null;
  if (new Set(input.conversions.map(row => row.sourceId)).size !== input.conversions.length ||
    input.conversions.length !== input.plan.conversionSources.length ||
    input.conversions.some(row => !input.plan.conversionSources.some(source => source.sourceId === row.sourceId))) return null;
  const all = [...input.observations, ...input.inFlight];
  if (all.length === 0 || new Set(all.map(row => row.id)).size !== all.length) return null;
  const observations = new Map(all.map(row => [row.id, row]));
  const units = new Map<string, EconomicFraction>();
  const rawBasis = input.plan.deployments.every(row => row.amountBasis === "circulating-usd");
  if (!rawBasis && input.plan.deployments.some(row => row.amountBasis === "circulating-usd")) return null;
  const convert = (key: string, observation: EconomicSupplyObservation): EconomicFraction | null => {
    const row = input.plan.deployments.find(row => row.deploymentKey === key);
    if (!row || observation.deploymentKey !== key || !current(observation.observedAtSec, policy.observationMaxAgeSec)) return null;
    if (!observation.id.startsWith("in-flight:") && !observation.id.startsWith("receipt:")) {
      if ((row.read.kind === "evm-total-supply" || row.read.kind === "evm-balance") &&
        (!/^(0|[1-9][0-9]*)$/.test(observation.anchor) || !EVM_BLOCK_HASH_RE.test(observation.anchorHash))) return null;
      if (row.read.kind === "solana-mint" && !SOLANA_BLOCK_HASH_RE.test(observation.anchorHash)) return null;
      if (row.read.kind === "xrpl-issued-currency" && !SHA256_RE.test(observation.anchorHash)) return null;
    }
    if (row.decimals !== null && !RAW_SUPPLY_RE.test(observation.amount)) return null;
    let value = economicDecimal(observation.amount, row.decimals);
    if (row.claimUnit !== input.plan.commonClaimUnit) {
      const rates = input.conversions.filter(rate => rate.sourceId === row.conversionSourceId);
      if (rates.length !== 1) return null;
      const rate = economicDecimal(rates[0]!.value);
      value = { n: value.n * rate.n, d: value.d * rate.d };
    }
    return value;
  };
  try {
    for (const row of input.plan.deployments) {
      const observation = observations.get(row.deploymentKey);
      if (!observation) return null;
      const value = convert(row.deploymentKey, observation);
      if (!value) return null;
      units.set(row.deploymentKey, value);
    }
    for (const rule of input.plan.exclusions) {
      const observation = observations.get(rule.id);
      const deduction = observation && convert(rule.deploymentKey, observation);
      if (!deduction) return null;
      const free = addEconomicUnits(units.get(rule.deploymentKey)!, deduction, true);
      if (free.n < 0n) return null;
      units.set(rule.deploymentKey, free);
    }
    let remainder: EconomicFraction = { n: 0n, d: 1n };
    for (const escrow of input.plan.escrows) {
      const observation = observations.get(escrow.id);
      const backing = observation && convert(escrow.canonicalDeploymentKey, observation);
      const pendingObservation = observations.get(`in-flight:${escrow.id}`);
      const pending: EconomicFraction | null | undefined = escrow.inFlightSource === null && input.plan.inFlightTreatment === "atomic-native-wrapper"
        ? { n: 0n, d: 1n } : pendingObservation && convert(escrow.canonicalDeploymentKey, pendingObservation);
      if (!backing || !pending) return null;
      let represented: EconomicFraction = pending;
      for (const key of escrow.receiptDeploymentKeys) {
        const subset = escrow.receiptClaimSources.find(source => source.deploymentKey === key);
        const claimObservation = subset && observations.get(`receipt:${escrow.id}:${key}`);
        const claim = subset ? claimObservation && convert(key, claimObservation) : units.get(key);
        const holding = units.get(key)!;
        if (!claim || claim.n * holding.d > holding.n * claim.d) return null;
        represented = addEconomicUnits(represented, claim);
      }
      if (represented.n * backing.d !== backing.n * represented.d) return null;
      const free = addEconomicUnits(units.get(escrow.canonicalDeploymentKey)!, backing, true);
      if (free.n < 0n) return null;
      units.set(escrow.canonicalDeploymentKey, free);
      remainder = addEconomicUnits(remainder, pending);
    }
    if (input.plan.liabilityInFlightSource !== null) {
      const pendingObservation = observations.get("in-flight:liability");
      const pending = pendingObservation && convert(input.plan.deployments[0]!.deploymentKey, pendingObservation);
      if (!pending) return null;
      remainder = addEconomicUnits(remainder, pending);
    }
    if (input.inFlight.length !== input.plan.escrows.filter(escrow => escrow.inFlightSource !== null).length + (input.plan.liabilityInFlightSource === null ? 0 : 1)) return null;
    const expectedIds = new Set([...input.plan.deployments.map(row => row.deploymentKey), ...input.plan.exclusions.map(row => row.id), ...input.plan.escrows.map(row => row.id), ...input.plan.escrows.filter(escrow => escrow.inFlightSource !== null).map(row => `in-flight:${row.id}`), ...input.plan.escrows.flatMap(escrow => escrow.receiptClaimSources.map(source => `receipt:${escrow.id}:${source.deploymentKey}`)), ...(input.plan.liabilityInFlightSource === null ? [] : ["in-flight:liability"])]);
    if (all.length !== expectedIds.size || all.some(row => !expectedIds.has(row.id))) return null;
    const times = all.map(row => row.observedAtSec);
    const started = Math.min(...times), ended = Math.max(...times);
    if (ended - started > policy.observationMaxSkewSec) return null;
    let total = remainder;
    for (const value of units.values()) total = addEconomicUnits(total, value);
    if (!rawBasis && total.n === 0n && input.aggregate.supplyUsd > 0) return null;
    const tolerance = Math.max(policy.conservationAbsoluteToleranceUsd, input.aggregate.supplyUsd * policy.conservationRelativeTolerance);
    const quantity = (value: EconomicFraction) => Number(value.n) / Number(value.d);
    const amount = (value: EconomicFraction) => rawBasis ? quantity(value) :
      total.n === 0n ? 0 : input.aggregate.supplyUsd * (Number(value.n * total.d) / Number(value.d * total.n));
    const measuredTotal = quantity(total);
    if (rawBasis && (measuredTotal > input.aggregate.supplyUsd + tolerance)) return null;
    const deployments = input.plan.deployments.map(row => ({ deploymentKey: row.deploymentKey, chainId: row.chainId, routeId: row.routeId, holdingKind: row.holdingKind, currentSupplyUsd: amount(units.get(row.deploymentKey)!) }));
    if (deployments.some((row, index) => !Number.isFinite(row.currentSupplyUsd) || row.currentSupplyUsd < 0 || (units.get(input.plan.deployments[index]!.deploymentKey)!.n > 0n && input.aggregate.supplyUsd > 0 && row.currentSupplyUsd === 0))) return null;
    const unattributedSupplyUsd = rawBasis ? Math.max(0, input.aggregate.supplyUsd - deployments.reduce((sum, row) => sum + row.currentSupplyUsd, 0)) : amount(remainder);
    const allocated = deployments.reduce((sum, row) => sum + row.currentSupplyUsd, unattributedSupplyUsd);
    if (!Number.isFinite(allocated) || Math.abs(allocated - input.aggregate.supplyUsd) > tolerance) return null;
    return ReviewedEconomicDeploymentPartitionSchema.parse({
      model: "reviewed-economic-deployment-partition-v1", assetId: input.plan.assetId,
      baseInputGenerationId: input.baseInputGenerationId, sourceGeneration: input.sourceGeneration, registryFingerprint: input.registryFingerprint,
      scoringClockSec: input.clockSec, observedAtSec: started, captureStartedAtSec: started, captureEndedAtSec: ended,
      planDigest: inventory.planDigest, routeInventoryDigest: inventory.digest, aggregate: input.aggregate,
      referencePrice: input.referencePrice, conversions: input.conversions, observations: input.observations, inFlight: input.inFlight,
      deployments, unattributedSupplyUsd, quantitativeCompleteness: true,
    });
  } catch { return null; }
}

export function normalizeReviewedEconomicDeploymentAttribution(packet: ReviewedEconomicDeploymentPartition): ReviewedEconomicDeploymentPartition {
  return { ...packet, deployments: [...packet.deployments].sort((a, b) => compareText(a.deploymentKey, b.deploymentKey)),
    observations: [...packet.observations].sort((a, b) => compareText(a.id, b.id)), inFlight: [...packet.inFlight].sort((a, b) => compareText(a.id, b.id)),
    conversions: [...packet.conversions].sort((a, b) => compareText(a.sourceId, b.sourceId)) };
}

export function reviewedEconomicDeploymentAttributionValidationError(input: {
  assetId: string; attribution: ReviewedEconomicDeploymentPartition; aggregateSupplyUsd: number;
  registryFingerprint: string; clockSec: number; baseInputGenerationId?: string; sourceGeneration?: string;
  aggregateObservedAtSec?: number | null; referencePrice?: { priceUsd: number; sourceId: string; observedAtSec: number } | null;
  chainRows?: Record<string, { current: number }>;
}): string | null {
  const packet = input.attribution;
  const plan = REVIEWED_ECONOMIC_SUPPLY_PLANS.get(input.assetId);
  if (!plan || packet.assetId !== input.assetId || packet.registryFingerprint !== input.registryFingerprint ||
    packet.scoringClockSec !== input.clockSec || packet.aggregate.supplyUsd !== input.aggregateSupplyUsd ||
    (input.baseInputGenerationId !== undefined && packet.baseInputGenerationId !== input.baseInputGenerationId) ||
    (input.sourceGeneration !== undefined && packet.sourceGeneration !== input.sourceGeneration) ||
    (input.aggregateObservedAtSec !== undefined && packet.aggregate.observedAtSec !== input.aggregateObservedAtSec) ||
    (plan.referencePriceSource === null && input.referencePrice !== undefined && (!input.referencePrice || packet.referencePrice.sourceId !== input.referencePrice.sourceId ||
      Number(packet.referencePrice.value) !== input.referencePrice.priceUsd || packet.referencePrice.observedAtSec !== input.referencePrice.observedAtSec))) return "Economic supply attribution identity/source binding mismatch";
  const policy = V9_CANDIDATE_POLICY_V1.policy.semantic.supplyAttribution;
  const tolerance = Math.max(policy.conservationAbsoluteToleranceUsd, input.aggregateSupplyUsd * policy.conservationRelativeTolerance);
  for (const [chain, provider] of Object.entries(input.chainRows ?? {})) {
    const chainId = resolveChainId(chain) ?? chain;
    const rows = packet.deployments.filter(row => row.chainId === chainId);
    if (rows.length === 0 || Math.abs(rows.reduce((sum, row) => sum + row.currentSupplyUsd, 0) - provider.current) > tolerance) return "Economic supply attribution contradicts eligible provider chain";
  }
  const recomputed = deriveReviewedEconomicDeploymentPartition({ plan, baseInputGenerationId: packet.baseInputGenerationId,
    sourceGeneration: packet.sourceGeneration, registryFingerprint: packet.registryFingerprint, clockSec: input.clockSec,
    aggregate: packet.aggregate, referencePrice: packet.referencePrice, conversions: packet.conversions,
    observations: packet.observations, inFlight: packet.inFlight });
  return recomputed && stableJsonStringifyV1(normalizeReviewedEconomicDeploymentAttribution(recomputed)) ===
    stableJsonStringifyV1(normalizeReviewedEconomicDeploymentAttribution(packet)) ? null : "Economic supply attribution accounting/census invalid";
}

/** Full census coverage, not a positive subtotal, permits provider preference. */
export function hasCompleteEligibleProviderSupply(input: {
  clockSec: number; aggregateCirculatingById: Record<string, { circulating: Record<string, number>; observedAtSec: number | null }>;
  chainCirculatingById: Record<string, Record<string, { current: number }>>;
}, assetId: string, meta: Pick<StablecoinMeta, "contracts" | "bridgeRouteRisk"> | undefined = ACTIVE_META_BY_ID.get(assetId)): boolean {
  const aggregate = input.aggregateCirculatingById[assetId];
  const amount = getCirculatingRawOrNull(aggregate ?? {});
  const policy = V9_CANDIDATE_POLICY_V1.policy.semantic.supplyAttribution;
  if (!meta || amount === null || amount <= 0 || aggregate?.observedAtSec == null ||
    aggregate.observedAtSec > input.clockSec || input.clockSec - aggregate.observedAtSec > policy.observationMaxAgeSec) return false;
  const rows = new Map<string, number>();
  for (const [chain, row] of Object.entries(input.chainCirculatingById[assetId] ?? {})) {
    if (!Number.isFinite(row.current) || row.current < 0) return false;
    const key = resolveChainId(chain) ?? chain;
    rows.set(key, (rows.get(key) ?? 0) + row.current);
  }
  const routes = meta.bridgeRouteRisk?.routes ?? [];
  if (routes.length === 0) return false;
  const plan = REVIEWED_ECONOMIC_SUPPLY_PLANS.get(assetId);
  if (plan && (!buildReviewedEconomicDeploymentInventory(assetId, plan, meta) ||
    plan.deployments.some(row => !rows.has(row.chainId) ||
      plan.deployments.filter(other => other.chainId === row.chainId).length !== 1))) return false;
  const routesPerChain = new Map<string, number>();
  for (const route of routes) {
    const chain = resolveChainId(route.destinationChain);
    if (!chain || !rows.has(chain)) return false;
    routesPerChain.set(chain, (routesPerChain.get(chain) ?? 0) + 1);
  }
  if ([...routesPerChain.values()].some(count => count !== 1)) return false;
  for (const contract of meta.contracts ?? []) {
    const chain = resolveChainId(contract.chain);
    if (!chain || !rows.has(chain) || !routes.some(route => resolveChainId(route.destinationChain) === chain &&
      normalizeAddress(chain, route.contractAddress) === normalizeAddress(chain, contract.address))) return false;
  }
  const total = [...rows.values()].reduce((sum, value) => sum + value, 0);
  const tolerance = Math.max(policy.conservationAbsoluteToleranceUsd, amount * policy.conservationRelativeTolerance);
  return Math.abs(total - amount) <= tolerance;
}
