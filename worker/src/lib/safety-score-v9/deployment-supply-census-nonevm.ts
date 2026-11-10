import { CHAIN_META } from "@shared/types/chain-identity";
import type {
  V9DeploymentSupplyCensusRejectionReason,
  V9DeploymentSupplyCensusRow,
} from "@shared/types/safety-score-v9-deployment-supply-census";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { rethrowIfAborted, throwIfAborted } from "../abort";
import { registryRpcUrls, type ChainRpcConfig } from "../chain-registry";
import type { DwellirNativeCapability } from "../dwellir-native";
import { getPublicRpcUrl } from "../public-rpc-registry";
import { fetchSafetyScoreV9SolanaRpc } from "./supply-observation-primitives";
import { fetchMoveFungibleAssetSupply, type MoveFungibleAssetSupplyObservation } from "../../cron/reserve-adapters/token-supply";
import type {
  DeploymentSupplyCensusChainRead,
  DeploymentSupplyCensusMeasuredRow,
  DeploymentSupplyCensusReadTarget,
} from "./deployment-supply-census-evm";

/**
 * Non-EVM half of the v10.38 deployment supply census (`deployment-supply-census-v1`).
 *
 * One pinned supply read per reviewed deployment:
 * - Solana: `getMultipleAccounts` at `commitment: "finalized"`, batched by the
 *   policy account cap (100), with one produced finalized block anchor for the
 *   whole batch. A finalized bank slot is not necessarily a produced block, so
 *   the pin names the anchor block whose slot/hash/time can be re-fetched.
 * - Move (Aptos, Movement): the Aptos-framework fungible-asset supply resource
 *   at one `ledger_version` chosen at or before the census clock.
 *
 * Only chains with a reviewed reader are read. Every other chain family
 * (Sui, Cosmos, Tron, Stellar, NEAR, ...) returns an asset-level
 * `census-rejected:read-unavailable`; a missing read is never zero. Pin age is
 * enforced here; cross-chain skew and conservation belong to the partition
 * assembler (SA-5), which can share this module's admission helpers.
 */

const CENSUS_POLICY = V9_CANDIDATE_POLICY_V1.policy.semantic.supplyAttribution.deploymentSupplyCensus;
// Age/skew are supply-attribution authorities; the census block only names caps.
const SUPPLY_POLICY = V9_CANDIDATE_POLICY_V1.policy.semantic.supplyAttribution;

const SOLANA_MINT_PROGRAM_OWNERS: Readonly<Record<string, true>> = {
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: true,
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: true,
};
/** Same bounded anchor window as the reviewed economic mint reader. */
const SOLANA_BLOCK_ANCHOR_LOOKBACK_SLOTS = 64;
const CENSUS_MAX_RESPONSE_BYTES = 128 * 1024;
const CENSUS_MAX_QUANTITY_DIGITS = 78;
const CENSUS_MAX_LEDGER_IDENTIFIER_DIGITS = 20;
const MOVE_LEDGER_CHAIN_IDS = { aptos: 1, movement: 126 } as const;

const CANONICAL_UNSIGNED_INTEGER = /^(0|[1-9][0-9]*)$/;
const SOLANA_BLOCKHASH = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;
const MOVE_ADDRESS = /^0x[0-9a-f]{1,64}$/;

/**
 * The single chain-family dispatch for the census. `null` means no reviewed
 * reader exists; the caller records `census-rejected:read-unavailable` for
 * every deployment on that chain instead of inventing a quantity.
 */
export function deploymentSupplyCensusChainReadKind(
  chainId: string,
): V9DeploymentSupplyCensusRow["readKind"] | null {
  if (chainId === "solana") return "solana-mint";
  if (chainId === "aptos" || chainId === "movement") return "move-fa-supply";
  if (CHAIN_META[chainId]?.type === "evm") return "evm-total-supply";
  return null;
}

/** Pin age: one authority for both readers and the assembler. */
export function deploymentSupplyCensusPinAgeIssue(
  scoringClockSec: number,
  pin: { blockTimeSec: number },
): "future-dated-pin" | "observation-stale" | null {
  const ageSec = scoringClockSec - pin.blockTimeSec;
  if (ageSec < 0) return "future-dated-pin";
  if (ageSec > SUPPLY_POLICY.observationMaxAgeSec) return "observation-stale";
  return null;
}

/** Cross-chain skew inside one asset's partition; the assembler owns the pin set. */
export function deploymentSupplyCensusPinSkewIssue(
  pins: readonly { blockTimeSec: number }[],
): "cross-chain-skew" | null {
  if (pins.length < 2) return null;
  let oldest = pins[0]!.blockTimeSec;
  let newest = oldest;
  for (const pin of pins.slice(1)) {
    if (pin.blockTimeSec < oldest) oldest = pin.blockTimeSec;
    if (pin.blockTimeSec > newest) newest = pin.blockTimeSec;
  }
  return newest - oldest > SUPPLY_POLICY.observationMaxSkewSec ? "cross-chain-skew" : null;
}

interface SolanaMintAccountValue {
  owner?: string;
  data?: {
    parsed?: {
      type?: string;
      info?: { supply?: string; decimals?: number };
    };
  };
}

interface SolanaMintSnapshot {
  context?: { slot?: number };
  value?: (SolanaMintAccountValue | null | undefined)[];
}

interface SolanaBlockAnchor {
  slot: number;
  blockHash: string;
  blockTimeSec: number;
}

type SolanaPinResolution =
  | { anchor: SolanaBlockAnchor }
  | { reason: V9DeploymentSupplyCensusRejectionReason };

export interface DeploymentSupplyCensusNonEvmDependencies {
  fetchSafetyScoreV9SolanaRpc: typeof fetchSafetyScoreV9SolanaRpc;
  fetchMoveFungibleAssetSupply: typeof fetchMoveFungibleAssetSupply;
}

const DEFAULT_DEPENDENCIES: DeploymentSupplyCensusNonEvmDependencies = {
  fetchSafetyScoreV9SolanaRpc,
  fetchMoveFungibleAssetSupply,
};

export interface ObserveDeploymentSupplyCensusNonEvmChainInput {
  chainId: string;
  targets: readonly DeploymentSupplyCensusReadTarget[];
  scoringClockSec: number;
  chainRpcs: Map<string, ChainRpcConfig>;
  dwellirNative?: DwellirNativeCapability;
  signal?: AbortSignal;
}

type MeasuredDeployment = DeploymentSupplyCensusMeasuredRow;

/**
 * One chain's measured reads (or per-deployment rejections). Supply only: the
 * caller applies the reference price, USD/share arithmetic and conservation.
 */
export async function observeDeploymentSupplyCensusNonEvmChain(
  input: ObserveDeploymentSupplyCensusNonEvmChainInput,
  dependencyOverrides: Partial<DeploymentSupplyCensusNonEvmDependencies> = {},
): Promise<DeploymentSupplyCensusChainRead> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  throwIfAborted(input.signal);
  const readKind = deploymentSupplyCensusChainReadKind(input.chainId);
  if (readKind !== "solana-mint" && readKind !== "move-fa-supply") {
    // No reviewed non-EVM reader for this chain family. The assembler records
    // `census-rejected:read-unavailable` per deployment; the quantity stays null.
    return { kind: "rejected", reason: "read-unavailable" };
  }
  const rows = new Map<string, MeasuredDeployment>();
  const rejected = new Map<string, V9DeploymentSupplyCensusRejectionReason>();
  const targets: DeploymentSupplyCensusReadTarget[] = [];
  for (const target of input.targets) {
    if (target.chainId !== input.chainId) {
      // A target from another chain cannot be measured by this chain read.
      rejected.set(target.routeId, "route-unreviewed");
      continue;
    }
    targets.push(target);
  }
  if (readKind === "solana-mint") {
    await readSolanaDeployments(input, targets, dependencies, rows, rejected);
  } else {
    await readMoveDeployments(input, input.chainId as keyof typeof MOVE_LEDGER_CHAIN_IDS,
      targets, dependencies, rows, rejected);
  }
  return { kind: "measured", rows, rejected };
}

async function readSolanaDeployments(
  input: ObserveDeploymentSupplyCensusNonEvmChainInput,
  targets: readonly DeploymentSupplyCensusReadTarget[],
  dependencies: DeploymentSupplyCensusNonEvmDependencies,
  rows: Map<string, MeasuredDeployment>,
  rejected: Map<string, V9DeploymentSupplyCensusRejectionReason>,
): Promise<void> {
  const batchSize = CENSUS_POLICY.solanaMaxAccountsPerRequest;
  for (let offset = 0; offset < targets.length; offset += batchSize) {
    throwIfAborted(input.signal);
    const batch = targets.slice(offset, offset + batchSize);
    let snapshot: SolanaMintSnapshot | null = null;
    try {
      snapshot = await dependencies.fetchSafetyScoreV9SolanaRpc<SolanaMintSnapshot>(
        "getMultipleAccounts",
        [
          batch.map(target => target.tokenAddress),
          { commitment: CENSUS_POLICY.solanaCommitment, encoding: "jsonParsed" },
        ],
        input.signal,
        input.chainRpcs,
      );
    } catch (error) {
      rethrowIfAborted(error, input.signal);
    }
    const contextSlot = snapshot?.context?.slot;
    if (
      !snapshot ||
      !Array.isArray(snapshot.value) ||
      snapshot.value.length !== batch.length ||
      !Number.isSafeInteger(contextSlot) ||
      contextSlot! < 0
    ) {
      for (const target of batch) rejected.set(target.routeId, "read-unavailable");
      continue;
    }
    let resolution: SolanaPinResolution;
    try {
      resolution = await resolveSolanaPin(contextSlot!, input.scoringClockSec, input, dependencies);
    } catch (error) {
      rethrowIfAborted(error, input.signal);
      resolution = { reason: "read-unavailable" };
    }
    if ("reason" in resolution) {
      for (const target of batch) rejected.set(target.routeId, resolution.reason);
      continue;
    }
    const { anchor } = resolution;
    for (const [index, target] of batch.entries()) {
      const value: SolanaMintAccountValue | null | undefined = snapshot.value[index];
      const info = value?.data?.parsed?.info;
      const owner = value?.owner;
      // A missing, malformed or non-mint account is an unavailable read. The
      // reviewed identity check below can only compare observed values.
      if (
        value === null ||
        value === undefined ||
        value.data?.parsed?.type !== "mint" ||
        !info ||
        typeof info.supply !== "string" ||
        !CANONICAL_UNSIGNED_INTEGER.test(info.supply) ||
        typeof owner !== "string" ||
        SOLANA_MINT_PROGRAM_OWNERS[owner] !== true
      ) {
        rejected.set(target.routeId, "read-unavailable");
        continue;
      }
      if (target.programOwner !== undefined && owner !== target.programOwner) {
        rejected.set(target.routeId, "route-unreviewed");
        continue;
      }
      const decimals = info.decimals;
      if (
        typeof decimals !== "number" ||
        !Number.isInteger(decimals) ||
        decimals < 0 ||
        decimals > 36 ||
        (target.expectedDecimals !== null && decimals !== target.expectedDecimals)
      ) {
        rejected.set(target.routeId, "route-unreviewed");
        continue;
      }
      if (info.supply.length > CENSUS_MAX_QUANTITY_DIGITS) {
        rejected.set(target.routeId, "read-unavailable");
        continue;
      }
      rows.set(target.routeId, {
        decimals,
        totalSupplyRaw: info.supply,
        pin: {
          kind: "solana-finalized-slot",
          slot: anchor.slot,
          blockHash: anchor.blockHash,
          blockTimeSec: anchor.blockTimeSec,
          mintProgramOwner: owner,
        },
      });
    }
  }
}

/**
 * One produced finalized block per snapshot batch. The account snapshot is
 * finalized at `contextSlot`; leaders can skip slots, so the latest produced
 * block at or before that slot is the verifiable chronology pin.
 */
async function resolveSolanaPin(
  contextSlot: number,
  scoringClockSec: number,
  input: ObserveDeploymentSupplyCensusNonEvmChainInput,
  dependencies: DeploymentSupplyCensusNonEvmDependencies,
): Promise<SolanaPinResolution> {
  const startSlot = Math.max(0, contextSlot - SOLANA_BLOCK_ANCHOR_LOOKBACK_SLOTS);
  const blockSlots = await dependencies.fetchSafetyScoreV9SolanaRpc<number[]>(
    "getBlocks",
    [startSlot, contextSlot, { commitment: CENSUS_POLICY.solanaCommitment, minContextSlot: contextSlot }],
    input.signal,
    input.chainRpcs,
  );
  if (blockSlots === null || !Array.isArray(blockSlots)) return { reason: "read-unavailable" };
  const slot = blockSlots
    .filter(candidate => Number.isSafeInteger(candidate) && candidate >= startSlot && candidate <= contextSlot)
    .reduce<number | null>((latest, candidate) => (latest === null || candidate > latest ? candidate : latest), null);
  if (slot === null) return { reason: "missing-block-pin" };
  const block = await dependencies.fetchSafetyScoreV9SolanaRpc<{ blockTime?: unknown; blockhash?: unknown }>(
    "getBlock",
    [slot, {
      commitment: CENSUS_POLICY.solanaCommitment,
      transactionDetails: "none",
      rewards: false,
      maxSupportedTransactionVersion: 0,
    }],
    input.signal,
    input.chainRpcs,
  );
  if (block === null) return { reason: "read-unavailable" };
  if (
    typeof block.blockTime !== "number" ||
    !Number.isInteger(block.blockTime) ||
    block.blockTime < 0 ||
    typeof block.blockhash !== "string" ||
    !SOLANA_BLOCKHASH.test(block.blockhash)
  ) {
    return { reason: "missing-block-pin" };
  }
  const ageIssue = deploymentSupplyCensusPinAgeIssue(scoringClockSec, { blockTimeSec: block.blockTime });
  if (ageIssue !== null) return { reason: ageIssue };
  return { anchor: { slot, blockHash: block.blockhash, blockTimeSec: block.blockTime } };
}

/**
 * Move read identity: `packageAddress` present means the reviewed route
 * address is an OFT package whose mint/burn refs bind the fungible asset; a
 * differing `tokenAddress` must equal the metadata the package resolves to.
 * Absent, the route address is read as the fungible-asset metadata object.
 */
function movePackageAddress(tokenAddress: string): string | null {
  const candidate = tokenAddress.split("::")[0]?.toLowerCase() ?? "";
  return MOVE_ADDRESS.test(candidate) ? candidate : null;
}

async function readMoveDeployments(
  input: ObserveDeploymentSupplyCensusNonEvmChainInput,
  chainId: keyof typeof MOVE_LEDGER_CHAIN_IDS,
  targets: readonly DeploymentSupplyCensusReadTarget[],
  dependencies: DeploymentSupplyCensusNonEvmDependencies,
  rows: Map<string, MeasuredDeployment>,
  rejected: Map<string, V9DeploymentSupplyCensusRejectionReason>,
): Promise<void> {
  const urls = [...new Set([
    ...registryRpcUrls(input.chainRpcs.get(chainId)),
    getPublicRpcUrl(chainId),
  ].filter((url): url is string => typeof url === "string" && url.length > 0))];
  if (urls.length === 0) {
    for (const target of targets) rejected.set(target.routeId, "read-unavailable");
    return;
  }
  const expectedChainId = MOVE_LEDGER_CHAIN_IDS[chainId];
  for (const target of targets) {
    throwIfAborted(input.signal);
    const oftPackage = target.packageAddress?.toLowerCase();
    const packageAddress = oftPackage ?? movePackageAddress(target.tokenAddress);
    if (packageAddress === null || !MOVE_ADDRESS.test(packageAddress)) {
      rejected.set(target.routeId, "route-unreviewed");
      continue;
    }
    let measured: MeasuredDeployment | null = null;
    let failure: V9DeploymentSupplyCensusRejectionReason | null = null;
    for (const url of urls) {
      let observation: MoveFungibleAssetSupplyObservation | null = null;
      try {
        observation = await dependencies.fetchMoveFungibleAssetSupply(
          oftPackage ?? target.tokenAddress,
          input.signal ?? new AbortController().signal,
          url,
          input.dwellirNative ? { dwellirNative: input.dwellirNative } : undefined,
          {
            clockSec: input.scoringClockSec,
            expectedChainId,
            ...(target.expectedDecimals === null ? {} : { expectedDecimals: target.expectedDecimals }),
            identityKind: oftPackage === undefined ? "metadata-address" : "oft-package",
            ...(oftPackage !== undefined && oftPackage !== target.tokenAddress.toLowerCase()
              ? { expectedMetadataAddress: target.tokenAddress.toLowerCase() }
              : {}),
            maxResponseBytes: CENSUS_MAX_RESPONSE_BYTES,
          },
        );
      } catch (error) {
        rethrowIfAborted(error, input.signal);
        observation = null;
      }
      if (observation === null) continue;
      if (
        observation.rawSupply < 0n ||
        observation.rawSupply.toString().length > CENSUS_MAX_QUANTITY_DIGITS
      ) {
        failure = "read-unavailable";
        continue;
      }
      if (
        !Number.isInteger(observation.decimals) ||
        observation.decimals < 0 ||
        observation.decimals > 36 ||
        (target.expectedDecimals !== null && observation.decimals !== target.expectedDecimals)
      ) {
        failure = "route-unreviewed";
        continue;
      }
      const ledgerVersion = observation.ledgerVersion;
      if (
        typeof ledgerVersion !== "string" ||
        !CANONICAL_UNSIGNED_INTEGER.test(ledgerVersion) ||
        ledgerVersion.length > CENSUS_MAX_LEDGER_IDENTIFIER_DIGITS
      ) {
        failure = "missing-block-pin";
        continue;
      }
      const blockTimeSec = observation.ledgerTimestampSec;
      if (
        typeof blockTimeSec !== "number" ||
        !Number.isSafeInteger(blockTimeSec) ||
        blockTimeSec < 0
      ) {
        failure = "missing-block-pin";
        continue;
      }
      const ageIssue = deploymentSupplyCensusPinAgeIssue(input.scoringClockSec, { blockTimeSec });
      if (ageIssue !== null) {
        failure = ageIssue;
        continue;
      }
      measured = {
        decimals: observation.decimals,
        totalSupplyRaw: observation.rawSupply.toString(),
        pin: { kind: "move-ledger-version", ledgerVersion, blockTimeSec, packageAddress },
      };
      break;
    }
    if (measured !== null) rows.set(target.routeId, measured);
    else rejected.set(target.routeId, failure ?? "read-unavailable");
  }
}
