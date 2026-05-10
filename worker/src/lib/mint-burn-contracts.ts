import { CHAIN_META } from "@shared/lib/chains";
import { MINT_BURN_CONFIG_SPECS } from "./mint-burn-contracts-data";
export type {
  MintBurnAdapterKind,
  MintBurnBridgeDetectionConfig,
  MintBurnCcipBridgeDetectionConfig,
  MintBurnCctpBridgeDetectionConfig,
  MintBurnContractConfig,
  MintBurnContractConfigSpec,
  MintBurnDirection,
  MintBurnEventDef,
  MintBurnLayerZeroOftBridgeDetectionConfig,
  MintBurnStartBlockConfidence,
  MintBurnTier,
  MintBurnType,
} from "./mint-burn-contracts-types";
import type {
  MintBurnBridgeDetectionConfig,
  MintBurnContractConfig,
} from "./mint-burn-contracts-types";
import {
  resolveMintBurnContractConfig,
  uniqueChainIds,
} from "./mint-burn-contracts-helpers";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const TOPIC_RE = /^0x[0-9a-fA-F]{64}$/;
const SELECTOR_RE = /^0x[0-9a-fA-F]{8}$/;

function bridgeAddressFields(d: MintBurnBridgeDetectionConfig): string[][] {
  switch (d.protocol) {
    case "ccip":
    case "cctp":
      return [d.knownBridgePoolAddresses, d.knownBridgeRouterAddresses];
    case "layerzero-oft":
      return [d.knownBridgeContractAddresses, d.bridgeSignalEmitterAddresses];
  }
}

/**
 * Validate the hex-string format of every address/topic/selector in a bridge
 * detection config.
 */
export function validateMintBurnBridgeDetection(d: MintBurnBridgeDetectionConfig): void {
  const all: { kind: "address" | "topic" | "selector"; values: string[] }[] = [
    ...bridgeAddressFields(d).map((values) => ({ kind: "address" as const, values })),
    { kind: "topic", values: d.bridgeSignalTopics ?? [] },
    { kind: "selector", values: d.bridgeSignalSelectors ?? [] },
  ];
  for (const { kind, values } of all) {
    for (const v of values) {
      const re = kind === "address" ? ADDRESS_RE : kind === "topic" ? TOPIC_RE : SELECTOR_RE;
      if (!re.test(v)) {
        throw new Error(`mint-burn bridge config: invalid ${kind} "${v}" for protocol ${d.protocol}`);
      }
    }
  }
}

export const MINT_BURN_CONFIGS: MintBurnContractConfig[] = MINT_BURN_CONFIG_SPECS.map(
  resolveMintBurnContractConfig,
);

// Audit-and-report: validate every existing bridge config without aborting the
// worker. Invalid metadata should surface in logs for data cleanup while keeping
// mint/burn sync available for unaffected assets.
const bridgeValidationErrors: string[] = [];
for (const cfg of MINT_BURN_CONFIGS) {
  if (!cfg.bridgeDetection) continue;
  try {
    validateMintBurnBridgeDetection(cfg.bridgeDetection);
  } catch (e) {
    bridgeValidationErrors.push(
      `${cfg.chain.chainId}/${cfg.stablecoinId}: ${(e as Error).message}`,
    );
  }
}
if (bridgeValidationErrors.length > 0) {
  console.error("[mint-burn-contracts] BRIDGE CONFIG VALIDATION ERRORS:", bridgeValidationErrors);
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
