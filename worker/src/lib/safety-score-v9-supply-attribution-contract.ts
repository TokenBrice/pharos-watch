import { CHAIN_META, resolveChainId } from "@shared/lib/chains";
import { compareText } from "@shared/lib/safety-score-v9/primitives";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";

const REVIEWED_DEPLOYMENT_SUPPLY_MAX_AGE_SEC = 1_800;
const REVIEWED_DEPLOYMENT_SUPPLY_MAX_SKEW_SEC = 120;

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
const WM_UNDERLYING_M = "0x866a2bf4e572cbcf37d5071a7a58503bfb36be1b";
const M0_PORTAL = "0xd925c84b55e4e44a53749ff5f2a5a13f63d128fd";

const WM_DEPLOYMENT_IDENTITIES: Readonly<Record<string, WmDeploymentIdentity>> = {
  "ethereum:0x437cc33344a0b27a429f795ff6b469c72698b291": {
    runtime: "evm",
    runtimeCodeSha256: "ef515e6adf8e4349bd060bbfe7472b8cb69b4ca89db7f94af138a0c82cfaa63a",
    implementationAddress: WM_V1_IMPLEMENTATION,
    implementationCodeSha256: "5120fd4e1b25e5b1e0822a332d5c67d11093d7af243ba0cb6b0ebb2bcfd5fcc5",
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
    implementationAddress: WM_V1_IMPLEMENTATION,
    implementationCodeSha256: "cf480dfabed7c96872ef9aa2af6e9f78c2b0184210c8440a97cb129741d5af88",
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
      extraRpcUrls: ["https://rpc.plume.org"],
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
      extraRpcUrls: [
        "https://rpc.monad.xyz",
        "https://rpc1.monad.xyz",
      ],
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
      extraRpcUrls: ["https://rpc.plume.org"],
    },
    "monad:0x2fabf1c784b8583d63c00c5c9c0377d8cf1a3245": {
      runtime: "evm",
      liabilityModel: "protocol-burn-mint",
      runtimeCodeSha256:
        "5c903ebeaedc9bbbef618bab8106f93c4fae50fb2b8e15870bf346056f9bd1c5",
      controllerAddress: CENTRIFUGE_V3_SPOKE_ADDRESS,
      safeBlockLag: 10,
      extraRpcUrls: [
        "https://rpc.monad.xyz",
        "https://rpc1.monad.xyz",
      ],
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

  const remainingContracts = contracts.map((contract) => {
    const chainId = resolveChainId(contract.chain) ?? contract.chain.toLowerCase();
    return {
      chainId,
      contractAddress: normalizeAddress(chainId, contract.address),
      decimals: contract.decimals,
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
    if (!contract || !Number.isInteger(contract.decimals) || contract.decimals < 0 || contract.decimals > 36) {
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
): string | null {
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
  const toleranceUsd = Math.max(0.000001, input.aggregateSupplyUsd * 1e-12);
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
    reviewedDeploymentInventoryValidationError(input.assetId, inventory)
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
