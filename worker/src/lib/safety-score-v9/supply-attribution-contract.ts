import { CHAIN_META, resolveChainId } from "@shared/types/chain-identity";
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
import { ReviewedEconomicSupplyPlanEnvelopeSchema, ReviewedEconomicSupplyPlanSchema, ReviewedEconomicDeploymentPartitionSchema, ReviewedProviderChainPartitionSchema, type ReviewedProviderChainPartition, type ReviewedEconomicSupplyPlan, type ReviewedEconomicDeploymentPartition, type EconomicSupplyObservation, type EconomicSupplyReference } from "@shared/types/safety-score-v9-supply-attribution";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import { normalizeDeploymentId } from "@shared/types/deployment-id";
import { createReviewedAssetRegistry, ReviewedRegistryEntryError } from "./extension-reviewed-registry";
import type { SafetyScoreV9SupplyAttributionInput } from "./supply-attribution-source";
import { authenticateCcipPendingObservation } from "./ccip-pending-observer";
import type { SupplyAttributionAttemptDiagnostic } from "@shared/types/safety-score-v9-supply-attribution";
import { emitSupplyAttributionDiagnostic } from "./supply-attribution-capture-budget";

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
  // Reviewed 2026-10-02: pinned code and controller reads are recorded in the
  // NR wM research packet. Implementation bytecode embeds chain-local addresses.
  "linea:0x437cc33344a0b27a429f795ff6b469c72698b291": {
    runtime: "evm",
    runtimeCodeSha256: "b5edd6d89549e61af7305b88db4145dd7be145a55a885bc1a06560a007f520d0",
    implementationAddress: WM_V1_IMPLEMENTATION,
    implementationCodeSha256: "2be727b90deaf833265b7244a57e241a53f546cabcfd08a7e78ace31b52887cf",
    underlyingTokenAddress: WM_UNDERLYING_M,
    controllerAddress: M0_PORTAL,
    controllerRead: "portal",
  },
  "bsc:0x437cc33344a0b27a429f795ff6b469c72698b291": {
    runtime: "evm",
    runtimeCodeSha256: "19fd56a00588ec4edd82507a33ceba81b33fa5fafb50c17f8421cf08cfadcb12",
    implementationAddress: "0xc4f8649a5fa46f9566541e69d9d89cf7d708d897",
    implementationCodeSha256: "f9b0cc6ab66709038b434a53ed697705a793054bf1c5a9d246ffeb739bfb6f1e",
    underlyingTokenAddress: WM_UNDERLYING_M,
    controllerAddress: M0_PORTAL,
    controllerRead: "portal",
  },
  "hyperevm:0x437cc33344a0b27a429f795ff6b469c72698b291": {
    runtime: "evm",
    runtimeCodeSha256: "692615a84165d49ceb5c60125c65d21c1d379d3d1da7b03c984d6f9951094f58",
    implementationAddress: WM_V1_IMPLEMENTATION,
    implementationCodeSha256: "40453e200a850654c6fbd58b526ee21edcbabda5fe3164f26e3c3d36de21c99b",
    underlyingTokenAddress: WM_UNDERLYING_M,
    controllerAddress: M0_PORTAL,
    controllerRead: "portal",
  },
  "soneium:0x437cc33344a0b27a429f795ff6b469c72698b291": {
    runtime: "evm",
    runtimeCodeSha256: "27108834b1b5961c51c3fe3191717ed463b8d5fc82ebc99f2ed5ed3a554ea65a",
    implementationAddress: WM_V1_IMPLEMENTATION,
    implementationCodeSha256: "8528ef4dca732219a80eaf261fb415bd8c035ce5a80d7aa4db465261ed4099ae",
    underlyingTokenAddress: WM_UNDERLYING_M,
    controllerAddress: M0_PORTAL,
    controllerRead: "portal",
  },
  "plasma:0x437cc33344a0b27a429f795ff6b469c72698b291": {
    runtime: "evm",
    runtimeCodeSha256: "27108834b1b5961c51c3fe3191717ed463b8d5fc82ebc99f2ed5ed3a554ea65a",
    implementationAddress: WM_V1_IMPLEMENTATION,
    implementationCodeSha256: "e44a5e8f7e2c20c5f2991921d3bf6b7b7cfd185c1cfbfd840195a35338865faf",
    underlyingTokenAddress: WM_UNDERLYING_M,
    controllerAddress: M0_PORTAL,
    controllerRead: "portal",
  },
  "citrea:0x437cc33344a0b27a429f795ff6b469c72698b291": {
    runtime: "evm",
    runtimeCodeSha256: "d32711185f0adf2f806435954fae672294674fa6fb9e3b6bd81c5e76581a2b32",
    implementationAddress: WM_V1_IMPLEMENTATION,
    implementationCodeSha256: "65913a1077cd904f6d2b6edf592691bd47ce253b9c87ad5ea50127e4c73541eb",
    underlyingTokenAddress: WM_UNDERLYING_M,
    controllerAddress: M0_PORTAL,
    controllerRead: "portal",
  },
  "monad:0x437cc33344a0b27a429f795ff6b469c72698b291": {
    runtime: "evm",
    runtimeCodeSha256: "d51c343a2e9650f7477923f1a3e293f431072789f5e8e710af9f09b2bf29b9ce",
    implementationAddress: WM_V1_IMPLEMENTATION,
    implementationCodeSha256: "c155fb8038d551417b561c8e485e041858035686e9a2079cc83004a4d3685f17",
    underlyingTokenAddress: WM_UNDERLYING_M,
    controllerAddress: M0_PORTAL,
    controllerRead: "portal",
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
  if (CHAIN_META[chainId]?.nativeDenomRail && !/^0x[0-9a-fA-F]{40}$/.test(address)) return address;
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
      failedRouteId: boundaryRouteId(input.deployments, "earliest"),
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

export function loadReviewedEconomicSupplyPlans(value: unknown) {
  const envelope = ReviewedEconomicSupplyPlanEnvelopeSchema.parse(value);
  const registry = createReviewedAssetRegistry({ rows: envelope.reviews, schema: ReviewedEconomicSupplyPlanSchema, path: "supplyAttribution.reviews" });
  const plans = new Map<string, ReviewedEconomicSupplyPlan>();
  const quarantines = new Map<string, ReviewedRegistryEntryError>();
  for (const row of envelope.reviews) {
    try {
      const plan = registry.get(row.assetId);
      if (plan) plans.set(row.assetId, plan);
    } catch (error) {
      if (!(error instanceof ReviewedRegistryEntryError)) throw error;
      quarantines.set(row.assetId, error);
    }
  }
  return { envelope, plans, quarantines };
}
const economicSupplyRegistry = loadReviewedEconomicSupplyPlans(reviewedEconomicSupplyPlans);
export const REVIEWED_SUPPLY_ATTRIBUTION_ENVELOPE = economicSupplyRegistry.envelope;
export const REVIEWED_ECONOMIC_SUPPLY_PLANS: ReadonlyMap<string, ReviewedEconomicSupplyPlan> = economicSupplyRegistry.plans;
export const REVIEWED_ECONOMIC_SUPPLY_PLAN_QUARANTINES: ReadonlyMap<string, ReviewedRegistryEntryError> = economicSupplyRegistry.quarantines;

export const REVIEWED_PROVIDER_CHAIN_PARTITIONS = createReviewedAssetRegistry({
  rows: REVIEWED_SUPPLY_ATTRIBUTION_ENVELOPE.providerChainPartitionReviews ?? [],
  schema: ReviewedProviderChainPartitionSchema,
  path: "supplyAttribution.providerChainPartitionReviews",
  keyOf: row => typeof row.chainId === "string" ? `${row.assetId}:${row.chainId}` : undefined,
  keyPath: "chainId",
});

/** Preserves a provider row, splitting only a reviewed disjoint same-unit chain census. */
export function deriveReviewedProviderChainPartition(input: {
  review: ReviewedProviderChainPartition;
  meta: Pick<StablecoinMeta, "contracts" | "bridgeRouteRisk">;
  clockSec: number; supplyUsd: number;
  observations: readonly {
    deploymentKey: string; rawTokenUnits: string | null; decimals: number | null;
    blockNumber: string | null; blockHash?: string; observedAtSec: number | null; status: string;
  }[];
}): Array<{ routeId: string; supplyUsd: number }> | null {
  const { review, meta, observations } = input;
  if (!ReviewedProviderChainPartitionSchema.safeParse(review).success ||
    input.clockSec < review.reviewedAtSec || input.clockSec >= review.expiresAtSec ||
    !Number.isFinite(input.supplyUsd) || input.supplyUsd < 0) return null;
  const contracts = (meta.contracts ?? []).filter(row => resolveChainId(row.chain) === review.chainId);
  const routes = (meta.bridgeRouteRisk?.routes ?? []).filter(row => resolveChainId(row.destinationChain) === review.chainId);
  if (contracts.length !== review.deployments.length || routes.length !== review.deployments.length ||
    observations.length !== review.deployments.length ||
    new Set(observations.map(row => row.deploymentKey)).size !== observations.length ||
    new Set(contracts.map(row => normalizeAddress(review.chainId, row.address))).size !== contracts.length ||
    new Set(routes.map(row => row.id)).size !== routes.length) return null;
  const maxDecimals = Math.max(...review.deployments.map(row => row.decimals));
  const quantities: bigint[] = [];
  let anchor: string | null = null;
  for (const deployment of review.deployments) {
    const contract = contracts.find(row => normalizeAddress(review.chainId, row.address) === deployment.address);
    const route = routes.find(row => row.id === deployment.routeId);
    const observation = observations.find(row => row.deploymentKey === deployment.routeId);
    if (!contract || !isFixedDecimalDeployment(contract) || contract.decimals !== deployment.decimals ||
      !route || route.contractAddress.toLowerCase() !== deployment.address || route.reviewDisposition !== "reviewed" ||
      !observation || observation.status !== "accepted" || observation.rawTokenUnits === null ||
      !RAW_SUPPLY_RE.test(observation.rawTokenUnits) || observation.rawTokenUnits.length > 78 || observation.decimals !== deployment.decimals ||
      observation.blockNumber === null || !RAW_SUPPLY_RE.test(observation.blockNumber) ||
      !observation.blockHash || !EVM_BLOCK_HASH_RE.test(observation.blockHash) ||
      observation.observedAtSec === null || !Number.isInteger(observation.observedAtSec) ||
      observation.observedAtSec > input.clockSec ||
      input.clockSec - observation.observedAtSec > REVIEWED_DEPLOYMENT_SUPPLY_MAX_AGE_SEC) return null;
    const pin = `${observation.blockNumber}:${observation.blockHash}:${observation.observedAtSec}`;
    if (anchor !== null && pin !== anchor) return null;
    anchor = pin;
    quantities.push(BigInt(observation.rawTokenUnits) * 10n ** BigInt(maxDecimals - deployment.decimals));
  }
  const total = quantities.reduce((sum, value) => sum + value, 0n);
  if (total === 0n) return input.supplyUsd === 0 ? review.deployments.map(row => ({ routeId: row.routeId, supplyUsd: 0 })) : null;
  if (input.supplyUsd === 0) return null;
  // The adapter proves a common price cancels in this ratio. No whole-asset
  // denominator, escrow subtraction or other-chain liability is inferred.
  let residualIndex = quantities.length - 1;
  while (quantities[residualIndex] === 0n) residualIndex--;
  let allocated = 0;
  const rows = review.deployments.map((row, index) => {
    const supplyUsd = index === residualIndex ? 0 : input.supplyUsd * (Number(quantities[index]!) / Number(total));
    allocated += supplyUsd;
    return { routeId: row.routeId, supplyUsd };
  });
  const residual = input.supplyUsd - allocated;
  const policy = V9_CANDIDATE_POLICY_V1.policy.semantic.supplyAttribution;
  if (!Number.isFinite(residual) || residual < 0 ||
    Math.abs(allocated + residual - input.supplyUsd) > Math.max(policy.conservationAbsoluteToleranceUsd, input.supplyUsd * policy.conservationRelativeTolerance)) return null;
  rows[residualIndex]!.supplyUsd = residual;
  return rows;
}

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
  if ((meta.bridgeRouteRisk?.routes ?? []).some(route => route.semantics === "lock-mint") &&
    plan.escrows.length === 0) return null;
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
    if (row && ((contract.kind === "native-denom" && row.read.kind !== "cosmos-bank-supply" && row.read.kind !== "provider-chain") ||
      (row.read.kind === "cosmos-bank-supply" && CHAIN_META[chain]?.type === "evm" && contract.kind !== "native-denom"))) return null;
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

/** These quantities come from the admitted input, not a reusable chain-state read. */
export function economicSupplyInputReferencePrice(
  fixedInput: Readonly<SafetyScoreV9SupplyAttributionInput>,
  assetId: string,
): EconomicSupplyReference | null {
  const price = fixedInput.navPriceById?.[assetId];
  return price ? { sourceId: price.sourceId, value: String(price.priceUsd),
    sourceGeneration: fixedInput.sourceGeneration, observedAtSec: price.observedAtSec,
    responseSha256: sha256Hex(stableJsonStringifyV1(price)) } : null;
}

export function economicSupplyInputDeploymentObservation(input: {
  fixedInput: Readonly<SafetyScoreV9SupplyAttributionInput>;
  plan: ReviewedEconomicSupplyPlan;
  row: ReviewedEconomicSupplyPlan["deployments"][number];
  referencePrice: EconomicSupplyReference;
}): EconomicSupplyObservation | null {
  const { fixedInput, plan, row, referencePrice } = input;
  const aggregate = fixedInput.aggregateCirculatingById[plan.assetId];
  const aggregateUsd = getCirculatingRawOrNull(aggregate ?? {});
  if (aggregateUsd === null || aggregate?.observedAtSec == null) return null;
  if (row.read.kind === "provider-chain") {
    const amount = fixedInput.chainCirculatingById[plan.assetId]?.[row.read.sourceChain]?.current;
    if (plan.deployments.filter(other => other.chainId === row.chainId).length !== 1 ||
      row.amountBasis !== "circulating-usd" || amount === undefined) return null;
    return { id: row.deploymentKey, deploymentKey: row.deploymentKey, amount: String(amount),
      observedAtSec: aggregate.observedAtSec, anchor: fixedInput.sourceGeneration,
      anchorHash: sha256Hex(stableJsonStringifyV1(fixedInput.chainCirculatingById[plan.assetId])),
      responseSha256: sha256Hex(stableJsonStringifyV1({ sourceChain: row.read.sourceChain, amount })) };
  }
  if (row.read.kind === "native-from-aggregate" && row.holdingKind === "native-gas" && row.amountBasis === "native-ledger") {
    const amount = aggregateUsd / Number(referencePrice.value);
    if (!Number.isFinite(amount) || amount < 0) return null;
    const digest = sha256Hex(stableJsonStringifyV1({ aggregate, referencePrice }));
    return { id: row.deploymentKey, deploymentKey: row.deploymentKey,
      amount: amount.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 }),
      observedAtSec: Math.min(aggregate.observedAtSec, referencePrice.observedAtSec),
      anchor: `attributed:${fixedInput.sourceGeneration}`, anchorHash: digest, responseSha256: digest };
  }
  return null;
}

/** Recomputes every USD row; a conserved caller-supplied array alone is never proof. */
export function deriveReviewedEconomicDeploymentPartition(input: {
  plan: ReviewedEconomicSupplyPlan; meta?: Pick<StablecoinMeta, "contracts" | "bridgeRouteRisk">;
  baseInputGenerationId: string; sourceGeneration: string; registryFingerprint: string; clockSec: number;
  aggregate: ReviewedEconomicDeploymentPartition["aggregate"];
  referencePrice: EconomicSupplyReference; conversions: EconomicSupplyReference[];
  observations: EconomicSupplyObservation[]; inFlight: EconomicSupplyObservation[];
  onDiagnostic?: (diagnostic: SupplyAttributionAttemptDiagnostic) => void;
}): ReviewedEconomicDeploymentPartition | null {
  const inventory = buildReviewedEconomicDeploymentInventory(input.plan.assetId, input.plan, input.meta);
  const policy = V9_CANDIDATE_POLICY_V1.policy.semantic.supplyAttribution;
  const current = (clock: number, budget: number) => Number.isInteger(clock) && clock <= input.clockSec && input.clockSec - clock <= budget;
  const rejected = (failurePredicate: string, operands?: SupplyAttributionAttemptDiagnostic["operands"], laneId: string | null = null): null => {
    emitSupplyAttributionDiagnostic(input.onDiagnostic, { observer: "economic-deployment", sourceId: input.plan.sourceId, laneId, phase: "partition-derivation", method: "exact-unit-reconciliation", hardEvidenceFailure: true, failurePredicate, ...(operands ? { operands } : {}) });
    return null;
  };
  if (!inventory) return rejected("reviewed-inventory-present");
  if (input.clockSec < input.plan.reviewedAtSec || input.clockSec >= input.plan.expiresAtSec) return rejected("review-window-contains-clock", { clockSec: input.clockSec, reviewedAtSec: input.plan.reviewedAtSec, expiresAtSec: input.plan.expiresAtSec });
  if (!current(input.aggregate.observedAtSec, policy.observationMaxAgeSec)) return rejected("aggregate-observation-current", { observedAtSec: input.aggregate.observedAtSec, clockSec: input.clockSec, maxAgeSec: policy.observationMaxAgeSec });
  if (input.aggregate.sourceGeneration !== input.sourceGeneration) return rejected("aggregate-source-generation-equals-input", { actual: input.aggregate.sourceGeneration, expected: input.sourceGeneration });
  if (!current(input.referencePrice.observedAtSec, policy.referencePriceMaxAgeSec)) return rejected("reference-price-current", { observedAtSec: input.referencePrice.observedAtSec, clockSec: input.clockSec, maxAgeSec: policy.referencePriceMaxAgeSec });
  if (input.referencePrice.sourceId !== input.plan.sourceId) return rejected("reference-price-source-identity", { actual: input.referencePrice.sourceId, expected: input.plan.sourceId });
  const staleConversion = input.conversions.find(row => !current(row.observedAtSec, policy.referencePriceMaxAgeSec));
  if (staleConversion) return rejected("conversion-observation-current", { sourceId: staleConversion.sourceId, observedAtSec: staleConversion.observedAtSec, clockSec: input.clockSec, maxAgeSec: policy.referencePriceMaxAgeSec });
  if (new Set(input.conversions.map(row => row.sourceId)).size !== input.conversions.length ||
    input.conversions.length !== input.plan.conversionSources.length ||
    input.conversions.some(row => !input.plan.conversionSources.some(source => source.sourceId === row.sourceId))) return rejected("conversion-roster-equals-review", { actualCount: input.conversions.length, expectedCount: input.plan.conversionSources.length });
  const all = [...input.observations, ...input.inFlight];
  if (all.length === 0 || new Set(all.map(row => row.id)).size !== all.length) return rejected("observation-roster-nonempty-and-unique", { count: all.length });
  const observations = new Map(all.map(row => [row.id, row]));
  const units = new Map<string, EconomicFraction>();
  const rawBasis = input.plan.deployments.every(row => row.amountBasis === "circulating-usd");
  if (!rawBasis && input.plan.deployments.some(row => row.amountBasis === "circulating-usd")) return rejected("amount-bases-not-mixed");
  const chainAnchors = new Map<string, string>();
  const apiObservationIds = new Set([
    ...input.plan.escrows.flatMap(escrow => escrow.receiptClaimSources.map(source => `receipt:${escrow.id}:${source.deploymentKey}`)),
    ...input.plan.escrows.filter(escrow => escrow.inFlightSource !== null && !("kind" in escrow.inFlightSource)).map(escrow => `in-flight:${escrow.id}`),
    ...(input.plan.liabilityInFlightSource === null || "kind" in input.plan.liabilityInFlightSource ? [] : ["in-flight:liability"]),
  ]);
  const convert = (key: string, observation: EconomicSupplyObservation): EconomicFraction | null => {
    const row = input.plan.deployments.find(row => row.deploymentKey === key);
    if (!row || observation.deploymentKey !== key) return rejected("observation-deployment-identity", { expected: key, actual: observation.deploymentKey }, observation.id);
    if (!current(observation.observedAtSec, policy.observationMaxAgeSec)) return rejected("deployment-observation-current", { observedAtSec: observation.observedAtSec, clockSec: input.clockSec, maxAgeSec: policy.observationMaxAgeSec }, observation.id);
    if (!apiObservationIds.has(observation.id)) {
      const evmState = row.read.kind === "evm-total-supply" || row.read.kind === "evm-balance" ||
        (row.holdingKind === "native-gas" && observation.id !== row.deploymentKey);
      if (evmState) {
        if (!/^(0|[1-9][0-9]*)$/.test(observation.anchor) || !EVM_BLOCK_HASH_RE.test(observation.anchorHash)) return rejected("evm-anchor-shape", { anchor: observation.anchor, anchorHash: observation.anchorHash }, observation.id);
        const anchor = `${observation.anchor}:${observation.anchorHash}:${observation.observedAtSec}`;
        const previous = chainAnchors.get(row.chainId);
        if (previous !== undefined && previous !== anchor) return rejected("evm-chain-anchors-equal", { previous, actual: anchor }, observation.id);
        chainAnchors.set(row.chainId, anchor);
      }
      if (row.read.kind === "solana-mint" && !SOLANA_BLOCK_HASH_RE.test(observation.anchorHash)) return rejected("solana-anchor-shape", { anchorHash: observation.anchorHash }, observation.id);
      if (row.read.kind === "xrpl-issued-currency" && !SHA256_RE.test(observation.anchorHash)) return rejected("xrpl-anchor-shape", { anchorHash: observation.anchorHash }, observation.id);
      if (row.read.kind === "cosmos-bank-supply") {
        if (!/^[1-9][0-9]*$/.test(observation.anchor) || !SHA256_RE.test(observation.anchorHash)) return rejected("cosmos-anchor-shape", { anchor: observation.anchor, anchorHash: observation.anchorHash }, observation.id);
        const anchor = `${observation.anchor}:${observation.anchorHash}:${observation.observedAtSec}`;
        const previous = chainAnchors.get(row.chainId);
        if (previous !== undefined && previous !== anchor) return rejected("cosmos-chain-anchors-equal", { previous, actual: anchor }, observation.id);
        chainAnchors.set(row.chainId, anchor);
      }
      if (row.read.kind === "move-fa-supply" &&
        (!RAW_SUPPLY_RE.test(observation.anchor) || !SHA256_RE.test(observation.anchorHash) ||
          observation.anchorHash !== observation.responseSha256)) return rejected("move-anchor-authentication", { anchor: observation.anchor, anchorHash: observation.anchorHash, responseSha256: observation.responseSha256 }, observation.id);
      if (row.read.kind === "ton-jetton-supply" &&
        (!/^[1-9][0-9]*$/.test(observation.anchor) || !/^[A-Za-z0-9+/]{43}=$/.test(observation.anchorHash))) return rejected("ton-anchor-shape", { anchor: observation.anchor, anchorHash: observation.anchorHash }, observation.id);
    }
    if (row.decimals !== null && !RAW_SUPPLY_RE.test(observation.amount)) return rejected("token-amount-unsigned-integer", { amount: observation.amount, decimals: row.decimals }, observation.id);
    let value = economicDecimal(observation.amount, row.decimals);
    if (row.claimUnit !== input.plan.commonClaimUnit) {
      const rates = input.conversions.filter(rate => rate.sourceId === row.conversionSourceId);
      if (rates.length !== 1) return rejected("conversion-source-unique", { rateCount: rates.length, sourceId: row.conversionSourceId }, observation.id);
      const rate = economicDecimal(rates[0]!.value);
      value = { n: value.n * rate.n, d: value.d * rate.d };
    }
    return value;
  };
  const validOftPending = (
    source: Extract<NonNullable<ReviewedEconomicSupplyPlan["liabilityInFlightSource"]>, { kind: "evm-layerzero-oft-pending" }>,
    observation: EconomicSupplyObservation,
  ): boolean => {
    const proof = observation.layerZeroOftPendingProof;
    if (!proof) { rejected("oft-proof-present", { observationId: observation.id }); return false; }
    if (observation.curvePendingProof !== undefined || observation.l2MessengerPendingProof !== undefined || observation.ccipPendingProof !== undefined) { rejected("oft-proof-exclusive", { observationId: observation.id }); return false; }
    const expectedDigest = sha256Hex(stableJsonStringifyV1(source));
    if (proof.sourceDigest !== expectedDigest) { rejected("oft-proof-source-digest", { actual: proof.sourceDigest, expected: expectedDigest }); return false; }
    if (proof.pins.length !== source.sides.length || proof.pathways.length !== source.pathways.length) { rejected("oft-proof-roster-size", { pins: proof.pins.length, expectedPins: source.sides.length, pathways: proof.pathways.length, expectedPathways: source.pathways.length }); return false; }
    for (let index = 0; index < proof.pins.length; index++) {
      const pin = proof.pins[index]!, side = source.sides[index]!, holding = observations.get(`${side.chainId}:${side.tokenAddress}`);
      if (pin.chainId !== side.chainId || pin.eid !== side.eid || pin.anchor < side.deploymentBlock) { rejected("oft-pin-side-identity", { chainId: pin.chainId, expectedChainId: side.chainId, eid: pin.eid, expectedEid: side.eid, anchor: pin.anchor, deploymentBlock: side.deploymentBlock }); return false; }
      if (!holding || holding.anchor !== String(pin.anchor) || holding.anchorHash !== pin.anchorHash || holding.observedAtSec !== pin.observedAtSec) { rejected("oft-pin-equals-holding", { chainId: side.chainId, pinAnchor: pin.anchor, holdingAnchor: holding?.anchor ?? null, pinHash: pin.anchorHash, holdingHash: holding?.anchorHash ?? null, pinObservedAtSec: pin.observedAtSec, holdingObservedAtSec: holding?.observedAtSec ?? null }); return false; }
    }
    for (let index = 0; index < proof.pathways.length; index++) {
      const path = proof.pathways[index]!, reviewed = source.pathways[index]!;
      if (path.sourceIndex !== reviewed.sourceIndex || path.destinationIndex !== reviewed.destinationIndex) { rejected("oft-pathway-identity", { sourceIndex: path.sourceIndex, expectedSourceIndex: reviewed.sourceIndex, destinationIndex: path.destinationIndex, expectedDestinationIndex: reviewed.destinationIndex }); return false; }
      if (BigInt(path.lazyInboundNonce) > BigInt(path.inboundNonce) || BigInt(path.inboundNonce) > BigInt(path.sentNonce) || (path.pendingCount === 0 && BigInt(path.pendingAmountSD) !== 0n)) { rejected("oft-pathway-nonce-and-pending", { lazyInboundNonce: path.lazyInboundNonce, inboundNonce: path.inboundNonce, sentNonce: path.sentNonce, pendingCount: path.pendingCount, pendingAmountSD: path.pendingAmountSD }); return false; }
    }
    const canonical = proof.pins[0]!;
    const amount = proof.pathways.reduce((sum, path) => sum + BigInt(path.pendingAmountSD), 0n) *
      10n ** BigInt(source.localDecimals - source.sharedDecimals);
    if (observation.amount !== amount.toString()) { rejected("oft-amount-equals-pathway-sum", { actual: observation.amount, expected: amount.toString() }); return false; }
    if (observation.anchor !== String(canonical.anchor) || observation.anchorHash !== canonical.anchorHash || observation.observedAtSec !== canonical.observedAtSec) { rejected("oft-observation-equals-canonical-pin", { anchor: observation.anchor, expectedAnchor: canonical.anchor, hash: observation.anchorHash, expectedHash: canonical.anchorHash, observedAtSec: observation.observedAtSec, expectedObservedAtSec: canonical.observedAtSec }); return false; }
    const expectedResponseHash = sha256Hex(stableJsonStringifyV1({ proof, amount: observation.amount }));
    if (observation.responseSha256 !== expectedResponseHash) { rejected("oft-response-hash", { actual: observation.responseSha256, expected: expectedResponseHash }); return false; }
    return true;
  };
  try {
    for (const row of input.plan.deployments) {
      const observation = observations.get(row.deploymentKey);
      if (!observation) return rejected("deployment-observation-present", { deploymentKey: row.deploymentKey });
      const value = convert(row.deploymentKey, observation);
      if (!value) return null;
      units.set(row.deploymentKey, value);
    }
    for (const rule of input.plan.exclusions) {
      const observation = observations.get(rule.id);
      const deduction = observation && convert(rule.deploymentKey, observation);
      if (!deduction) return rejected("exclusion-deduction-present", { observationId: rule.id, deploymentKey: rule.deploymentKey });
      const free = addEconomicUnits(units.get(rule.deploymentKey)!, deduction, true);
      if (free.n < 0n) return rejected("excluded-free-units-nonnegative", { freeNumerator: free.n.toString(), freeDenominator: free.d.toString() }, rule.id);
      units.set(rule.deploymentKey, free);
    }
    let remainder: EconomicFraction = { n: 0n, d: 1n };
    for (const escrow of input.plan.escrows) {
      const observation = observations.get(escrow.id);
      const backing = observation && convert(escrow.canonicalDeploymentKey, observation);
      const pendingObservation = observations.get(`in-flight:${escrow.id}`);
      if (escrow.inFlightSource !== null && "kind" in escrow.inFlightSource) {
        const canonical = observations.get(escrow.canonicalDeploymentKey);
        if (!pendingObservation || !canonical || !observation) return rejected("escrow-observation-roster-present", { hasPending: !!pendingObservation, hasCanonical: !!canonical, hasEscrow: !!observation }, escrow.id);
        if (!/^(0|[1-9][0-9]*)$/.test(pendingObservation.anchor) || !EVM_BLOCK_HASH_RE.test(pendingObservation.anchorHash)) return rejected("pending-anchor-shape", { anchor: pendingObservation.anchor, anchorHash: pendingObservation.anchorHash }, escrow.id);
        if (pendingObservation.anchor !== canonical.anchor || pendingObservation.anchorHash !== canonical.anchorHash || pendingObservation.observedAtSec !== canonical.observedAtSec) return rejected("pending-pin-equals-canonical-holding", { pendingAnchor: pendingObservation.anchor, canonicalAnchor: canonical.anchor, pendingHash: pendingObservation.anchorHash, canonicalHash: canonical.anchorHash, pendingObservedAtSec: pendingObservation.observedAtSec, canonicalObservedAtSec: canonical.observedAtSec }, escrow.id);
        if (pendingObservation.anchor !== observation.anchor || pendingObservation.anchorHash !== observation.anchorHash || pendingObservation.observedAtSec !== observation.observedAtSec) return rejected("pending-pin-equals-escrow", { pendingAnchor: pendingObservation.anchor, escrowAnchor: observation.anchor, pendingHash: pendingObservation.anchorHash, escrowHash: observation.anchorHash, pendingObservedAtSec: pendingObservation.observedAtSec, escrowObservedAtSec: observation.observedAtSec }, escrow.id);
        if (escrow.inFlightSource.kind === "evm-curve-lz-pending") {
          const source = escrow.inFlightSource, proof = pendingObservation.curvePendingProof;
          if (!proof || pendingObservation.l2MessengerPendingProof !== undefined || pendingObservation.layerZeroOftPendingProof !== undefined || pendingObservation.ccipPendingProof !== undefined ||
            proof.sourceDigest !== sha256Hex(stableJsonStringifyV1(source)) ||
            proof.pins.length !== source.sides.length ||
            proof.pins.some((pin, index) => {
              const side = source.sides[index]!;
              const holdings = input.plan.deployments.filter(row => row.chainId === side.chainId);
              return pin.chainId !== side.chainId || pin.anchor < side.deploymentBlock || holdings.length === 0 ||
                holdings.some(row => {
                  const observed = observations.get(row.deploymentKey);
                  return !observed || observed.anchor !== String(pin.anchor) ||
                    observed.anchorHash !== pin.anchorHash || observed.observedAtSec !== pin.observedAtSec;
                });
            }) ||
            pendingObservation.responseSha256 !== sha256Hex(stableJsonStringifyV1({ proof, amount: pendingObservation.amount }))) return null;
        } else if (escrow.inFlightSource.kind === "evm-l2-messenger-pending") {
          const source = escrow.inFlightSource, proof = pendingObservation.l2MessengerPendingProof;
          if (!proof || pendingObservation.curvePendingProof !== undefined || pendingObservation.layerZeroOftPendingProof !== undefined ||
            pendingObservation.ccipPendingProof !== undefined || proof.sourceDigest !== sha256Hex(stableJsonStringifyV1(source)) ||
            BigInt(proof.depositAmount) + BigInt(proof.withdrawalAmount) !== BigInt(pendingObservation.amount) ||
            proof.pins.some((pin, index) => {
              const chainId = index === 0 ? source.chainId : source.l2ChainId;
              const start = index === 0 ? source.l1StartBlock : source.l2StartBlock;
              const holdings = input.plan.deployments.filter(row => row.chainId === chainId);
              return pin.chainId !== chainId || pin.anchor < start || holdings.length === 0 || holdings.some(row => {
                const observed = observations.get(row.deploymentKey);
                return !observed || observed.anchor !== String(pin.anchor) || observed.anchorHash !== pin.anchorHash ||
                  observed.observedAtSec !== pin.observedAtSec;
              });
            }) || pendingObservation.responseSha256 !== sha256Hex(stableJsonStringifyV1({ proof, amount: pendingObservation.amount }))) return null;
        } else if (escrow.inFlightSource.kind === "evm-layerzero-oft-pending") {
          if (!validOftPending(escrow.inFlightSource, pendingObservation)) return null;
        } else if (escrow.inFlightSource.kind === "evm-ccip-pending") {
          if (pendingObservation.curvePendingProof !== undefined || pendingObservation.l2MessengerPendingProof !== undefined ||
            pendingObservation.layerZeroOftPendingProof !== undefined ||
            !authenticateCcipPendingObservation(escrow.inFlightSource, pendingObservation, input.observations, input.plan.deployments)) return null;
        } else if (pendingObservation.curvePendingProof !== undefined || pendingObservation.l2MessengerPendingProof !== undefined ||
          pendingObservation.layerZeroOftPendingProof !== undefined || pendingObservation.ccipPendingProof !== undefined) return null;
      }
      const pending: EconomicFraction | null | undefined = escrow.inFlightSource === null && input.plan.inFlightTreatment === "atomic-native-wrapper"
        ? { n: 0n, d: 1n } : pendingObservation && convert(escrow.canonicalDeploymentKey, pendingObservation);
      if (!backing || !pending) return rejected("escrow-backing-or-pending-conversion", { hasBacking: !!backing, hasPending: !!pending }, escrow.id);
      let represented: EconomicFraction = pending;
      for (const key of escrow.receiptDeploymentKeys) {
        const subset = escrow.receiptClaimSources.find(source => source.deploymentKey === key);
        const claimObservation = subset && observations.get(`receipt:${escrow.id}:${key}`);
        // Excluded receipt holders remain escrow-backed. Exclusions reduce
        // circulating deployment units, never the bridge's gross liabilities.
        const holdingObservation = observations.get(key);
        const holding = holdingObservation && convert(key, holdingObservation);
        const claim = subset ? claimObservation && convert(key, claimObservation) : holding;
        if (!claim || !holding || claim.n * holding.d > holding.n * claim.d) return rejected("receipt-claim-within-holding", { deploymentKey: key, claimNumerator: claim?.n.toString() ?? null, claimDenominator: claim?.d.toString() ?? null, holdingNumerator: holding?.n.toString() ?? null, holdingDenominator: holding?.d.toString() ?? null }, escrow.id);
        represented = addEconomicUnits(represented, claim);
      }
      if (represented.n * backing.d !== backing.n * represented.d) return rejected("escrow-represented-equals-backing", { representedNumerator: represented.n.toString(), representedDenominator: represented.d.toString(), backingNumerator: backing.n.toString(), backingDenominator: backing.d.toString(), pendingNumerator: pending.n.toString(), pendingDenominator: pending.d.toString() }, escrow.id);
      const free = addEconomicUnits(units.get(escrow.canonicalDeploymentKey)!, backing, true);
      if (free.n < 0n) return rejected("escrow-free-units-nonnegative", { freeNumerator: free.n.toString(), freeDenominator: free.d.toString() }, escrow.id);
      units.set(escrow.canonicalDeploymentKey, free);
      remainder = addEconomicUnits(remainder, pending);
    }
    if (input.plan.liabilityInFlightSource !== null) {
      const pendingObservation = observations.get("in-flight:liability");
      const source = input.plan.liabilityInFlightSource;
      if ("kind" in source) {
        if (!pendingObservation) return rejected("liability-pending-observation-present");
        if (source.kind === "evm-layerzero-oft-pending") {
          if (!validOftPending(source, pendingObservation)) return null;
        } else if (source.kind === "evm-ccip-pending") {
          if (pendingObservation.curvePendingProof !== undefined || pendingObservation.layerZeroOftPendingProof !== undefined ||
            !authenticateCcipPendingObservation(source, pendingObservation, input.observations, input.plan.deployments)) return null;
        } else return null;
      } else if (pendingObservation?.layerZeroOftPendingProof !== undefined || pendingObservation?.ccipPendingProof !== undefined) return null;
      const pending = pendingObservation && convert(input.plan.deployments[0]!.deploymentKey, pendingObservation);
      if (!pending) return null;
      remainder = addEconomicUnits(remainder, pending);
    }
    if (input.inFlight.length !== input.plan.escrows.filter(escrow => escrow.inFlightSource !== null).length + (input.plan.liabilityInFlightSource === null ? 0 : 1)) return rejected("in-flight-roster-equals-review", { actualCount: input.inFlight.length });
    const expectedIds = new Set([...input.plan.deployments.map(row => row.deploymentKey), ...input.plan.exclusions.map(row => row.id), ...input.plan.escrows.map(row => row.id), ...input.plan.escrows.filter(escrow => escrow.inFlightSource !== null).map(row => `in-flight:${row.id}`), ...input.plan.escrows.flatMap(escrow => escrow.receiptClaimSources.map(source => `receipt:${escrow.id}:${source.deploymentKey}`)), ...(input.plan.liabilityInFlightSource === null ? [] : ["in-flight:liability"])]);
    if (all.length !== expectedIds.size || all.some(row => !expectedIds.has(row.id))) return rejected("complete-observation-roster-equals-review", { actualCount: all.length, expectedCount: expectedIds.size });
    const times = all.map(row => row.observedAtSec);
    const started = Math.min(...times), ended = Math.max(...times);
    if (ended - started > policy.observationMaxSkewSec) return rejected("observation-skew-within-policy", { started, ended, maxSkewSec: policy.observationMaxSkewSec });
    let total = remainder;
    for (const value of units.values()) total = addEconomicUnits(total, value);
    if (!rawBasis && total.n === 0n && input.aggregate.supplyUsd > 0) return rejected("nonzero-units-for-positive-aggregate", { totalNumerator: total.n.toString(), aggregateSupplyUsd: input.aggregate.supplyUsd });
    const tolerance = Math.max(policy.conservationAbsoluteToleranceUsd, input.aggregate.supplyUsd * policy.conservationRelativeTolerance);
    const quantity = (value: EconomicFraction) => Number(value.n) / Number(value.d);
    const amount = (value: EconomicFraction) => rawBasis ? quantity(value) :
      total.n === 0n ? 0 : input.aggregate.supplyUsd * (Number(value.n * total.d) / Number(value.d * total.n));
    const measuredTotal = quantity(total);
    if (rawBasis && (measuredTotal > input.aggregate.supplyUsd + tolerance)) return rejected("raw-total-within-aggregate", { measuredTotal: String(measuredTotal), aggregateSupplyUsd: input.aggregate.supplyUsd, tolerance });
    const deployments = input.plan.deployments.map(row => ({ deploymentKey: row.deploymentKey, chainId: row.chainId, routeId: row.routeId, holdingKind: row.holdingKind, currentSupplyUsd: amount(units.get(row.deploymentKey)!) }));
    if (deployments.some((row, index) => !Number.isFinite(row.currentSupplyUsd) || row.currentSupplyUsd < 0 || (units.get(input.plan.deployments[index]!.deploymentKey)!.n > 0n && input.aggregate.supplyUsd > 0 && row.currentSupplyUsd === 0))) return rejected("allocated-deployment-values-valid");
    const unattributedSupplyUsd = rawBasis ? Math.max(0, input.aggregate.supplyUsd - deployments.reduce((sum, row) => sum + row.currentSupplyUsd, 0)) : amount(remainder);
    const allocated = deployments.reduce((sum, row) => sum + row.currentSupplyUsd, unattributedSupplyUsd);
    if (!Number.isFinite(allocated) || Math.abs(allocated - input.aggregate.supplyUsd) > tolerance) return rejected("allocated-total-conserved", { allocated: String(allocated), aggregateSupplyUsd: input.aggregate.supplyUsd, tolerance });
    return ReviewedEconomicDeploymentPartitionSchema.parse({
      model: "reviewed-economic-deployment-partition-v1", assetId: input.plan.assetId,
      baseInputGenerationId: input.baseInputGenerationId, sourceGeneration: input.sourceGeneration, registryFingerprint: input.registryFingerprint,
      scoringClockSec: input.clockSec, observedAtSec: started, captureStartedAtSec: started, captureEndedAtSec: ended,
      planDigest: inventory.planDigest, routeInventoryDigest: inventory.digest, aggregate: input.aggregate,
      referencePrice: input.referencePrice, conversions: input.conversions, observations: input.observations, inFlight: input.inFlight,
      deployments, unattributedSupplyUsd, quantitativeCompleteness: true,
    });
  } catch (error) { return rejected("partition-derivation-exception", { errorClass: error instanceof Error ? error.name : "unknown" }); }
}

export function normalizeReviewedEconomicDeploymentAttribution(packet: ReviewedEconomicDeploymentPartition): ReviewedEconomicDeploymentPartition {
  return { ...packet, deployments: [...packet.deployments].sort((a, b) => compareText(a.deploymentKey, b.deploymentKey)),
    observations: [...packet.observations].sort((a, b) => compareText(a.id, b.id)), inFlight: [...packet.inFlight].sort((a, b) => compareText(a.id, b.id)),
    conversions: [...packet.conversions].sort((a, b) => compareText(a.sourceId, b.sourceId)) };
}

/** Alias labels represent a single chain allocation, not competing observations. */
function canonicalEligibleProviderSupply(rows: Record<string, { current: number }>): Map<string, number> | null {
  const totals = new Map<string, number>();
  for (const [label, row] of Object.entries(rows)) {
    if (!Number.isFinite(row.current) || row.current < 0) return null;
    const chainId = resolveChainId(label) ?? label;
    const total = (totals.get(chainId) ?? 0) + row.current;
    if (!Number.isFinite(total)) return null;
    totals.set(chainId, total);
  }
  return totals;
}

export function economicProviderSupplyContradictionChain(
  packet: ReviewedEconomicDeploymentPartition, providerRows: Record<string, { current: number }>,
): string | null {
  const providers = canonicalEligibleProviderSupply(providerRows);
  if (!providers) return "invalid-amount";
  const policy = V9_CANDIDATE_POLICY_V1.policy.semantic.supplyAttribution;
  const tolerance = Math.max(policy.conservationAbsoluteToleranceUsd, packet.aggregate.supplyUsd * policy.conservationRelativeTolerance);
  const attributed = new Map<string, number>();
  for (const row of packet.deployments) attributed.set(row.chainId, (attributed.get(row.chainId) ?? 0) + row.currentSupplyUsd);
  for (const [chainId, amount] of providers) {
    const actual = attributed.get(chainId);
    if (actual === undefined || !Number.isFinite(actual) || Math.abs(actual - amount) > tolerance) {
      return Object.keys(providerRows).find(label => (resolveChainId(label) ?? label) === chainId) ?? chainId;
    }
  }
  return null;
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
  if (economicProviderSupplyContradictionChain(packet, input.chainRows ?? {}) !== null) return "Economic supply attribution contradicts eligible provider chain";
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
  const rows = canonicalEligibleProviderSupply(input.chainCirculatingById[assetId] ?? {});
  if (!rows) return false;
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
