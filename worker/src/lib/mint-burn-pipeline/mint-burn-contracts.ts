import { CHAIN_META } from "@shared/types/chain-identity";
import { MINT_BURN_CONFIG_SPECS } from "./mint-burn-contracts-data";
export type { MintBurnBridgeDetectionConfig, MintBurnCcipBridgeDetectionConfig, MintBurnCctpBridgeDetectionConfig, MintBurnContractConfig, MintBurnEventDef, MintBurnLayerZeroOftBridgeDetectionConfig, MintBurnTier, MintBurnType } from "./mint-burn-contracts-types";
import type {
  MintBurnBridgeDetectionConfig,
  MintBurnContractConfig,
} from "./mint-burn-contracts-types";
import {
  resolveMintBurnContractConfig,
  uniqueChainIds,
} from "./mint-burn-contracts-helpers";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
function bridgeAddressFields(d: MintBurnBridgeDetectionConfig): string[][] {
  switch (d.protocol) {
    case "ccip":
      return [[d.tokenAddress, ...(d.externalMinterAddress ? [d.externalMinterAddress] : [])], d.knownBridgePoolAddresses];
    case "cctp":
      return [[d.tokenAddress], d.knownBridgePoolAddresses, ...d.deployments.map((entry) =>
        [entry.tokenMessenger, entry.tokenMinter, entry.messageTransmitter])];
    case "layerzero-oft":
      return [[d.tokenAddress, d.endpointAddress, d.oappAddress, ...(d.zeroRecipientAddress ? [d.zeroRecipientAddress] : [])], d.knownBridgeContractAddresses];
  }
}

/**
 * Signatures are code-owned; every configurable deployment identity fails closed.
 */
export function validateMintBurnBridgeDetection(d: MintBurnBridgeDetectionConfig): void {
  if (d.protocol === "layerzero-oft" && (!Number.isSafeInteger(d.endpointId) || d.endpointId <= 0)) {
    throw new Error("mint-burn bridge config: invalid LayerZero endpoint id");
  }
  if (d.protocol === "cctp" && (d.deployments.length === 0
    || d.deployments.some((entry) => entry.version !== 1 && entry.version !== 2))) {
    throw new Error("mint-burn bridge config: invalid CCTP deployment version");
  }
  for (const values of bridgeAddressFields(d)) {
    for (const v of values) {
      if (!ADDRESS_RE.test(v)) {
        throw new Error(`mint-burn bridge config: invalid address "${v}" for protocol ${d.protocol}`);
      }
    }
  }
}

export const MINT_BURN_CONFIGS: MintBurnContractConfig[] = MINT_BURN_CONFIG_SPECS.map(
  resolveMintBurnContractConfig,
);

export function collectMintBurnBridgeValidationErrors(
  configs: readonly MintBurnContractConfig[],
): string[] {
  const errors: string[] = [];
  for (const cfg of configs) {
    if (!cfg.bridgeDetection) continue;
    try {
      validateMintBurnBridgeDetection(cfg.bridgeDetection);
    } catch (e) {
      errors.push(
        `${cfg.chain.chainId}/${cfg.stablecoinId}: ${(e as Error).message}`,
      );
    }
  }
  return errors;
}

export const MINT_BURN_BRIDGE_VALIDATION_ERRORS =
  collectMintBurnBridgeValidationErrors(MINT_BURN_CONFIGS);

if (MINT_BURN_BRIDGE_VALIDATION_ERRORS.length > 0) {
  throw new Error(
    "[mint-burn-contracts] BRIDGE CONFIG VALIDATION ERRORS:\n" +
      MINT_BURN_BRIDGE_VALIDATION_ERRORS.join("\n"),
  );
}

export function getMintBurnConfigsForStablecoin(stablecoinId: string): MintBurnContractConfig[] {
  return MINT_BURN_CONFIGS.filter((config) => config.stablecoinId === stablecoinId);
}

export function getMintBurnTrackedPairs(configs: MintBurnContractConfig[] = MINT_BURN_CONFIGS): Set<string> {
  return new Set(
    configs.map((config) => `${config.stablecoinId}|${config.chain.chainId}`),
  );
}

export function buildMintBurnScope(configs: MintBurnContractConfig[] = MINT_BURN_CONFIGS): {
  chainIds: string[];
  label: string;
} {
  const chainIds = uniqueChainIds(configs);
  if (chainIds.length === 0) {
    return { chainIds, label: "No tracked chains" };
  }
  if (chainIds.length === 1) {
    const chainId = chainIds[0]!;
    const chainName = CHAIN_META[chainId]?.name ?? chainId;
    return { chainIds, label: `${chainName}-only` };
  }
  return { chainIds, label: "Configured issuance chains" };
}
