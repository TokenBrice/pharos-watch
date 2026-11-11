import { resolveRequiredTrackedContractConfig } from "../market-supply/tracked-contract-resolution";
import type {
  MintBurnAdapterKind,
  MintBurnBridgeDetectionConfig,
  MintBurnContractConfig,
  MintBurnContractConfigSpec,
  MintBurnEventDef,
} from "./mint-burn-contracts-types";

const ZERO_ADDRESS_PADDED = "0x0000000000000000000000000000000000000000000000000000000000000000";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export function transferMintBurn(): MintBurnEventDef[] {
  return [
    {
      signature: "Transfer(address,address,uint256)",
      topicHash: TRANSFER_TOPIC,
      direction: "mint",
      amountEncoding: "transfer-value",
      filterTopic: { index: 1, value: ZERO_ADDRESS_PADDED }, // from = zero
    },
    {
      signature: "Transfer(address,address,uint256)",
      topicHash: TRANSFER_TOPIC,
      direction: "burn",
      amountEncoding: "transfer-value",
      filterTopic: { index: 2, value: ZERO_ADDRESS_PADDED }, // to = zero
    },
  ];
}

// Circle's Ethereum deployments: https://developers.circle.com/cctp/references/contract-addresses
export function cctpBridgeDetection(
  knownBridgePoolAddresses: string[],
  stablecoinId: string,
): MintBurnBridgeDetectionConfig {
  const deployments = [
    { version: 1 as const, tokenMessenger: "0xbd3fa81b58ba92a82136038b25adec7066af3155",
      tokenMinter: "0xc4922d64a24675e16e1586e3e3aa56c06fabe907", messageTransmitter: "0x0a992d191deec32afe36203ad87d7d289a738f81" },
    { version: 2 as const, tokenMessenger: "0x28b5a0e9c621a5badaa536219b3a228c8168cf5d",
      tokenMinter: "0xfd78ee919681417d192449715b2594ab58f5d002", messageTransmitter: "0x81d40f21f12a8f0e3252bccb954d722d4c464b64" },
  ];
  return {
    protocol: "cctp",
    tokenAddress: resolveRequiredTrackedContractConfig(stablecoinId, "ethereum").contractAddress,
    knownBridgePoolAddresses: [...new Set([...knownBridgePoolAddresses, ...deployments.map((entry) => entry.tokenMinter)])],
    deployments,
  };
}

export function ccipBridgeDetection(
  knownBridgePoolAddresses: string[],
  stablecoinId: string,
  externalMinterAddress?: string,
  poolKind?: "usdo",
): MintBurnBridgeDetectionConfig {
  return {
    protocol: "ccip",
    tokenAddress: resolveRequiredTrackedContractConfig(stablecoinId, "ethereum").contractAddress,
    knownBridgePoolAddresses,
    ...(externalMinterAddress ? { externalMinterAddress } : {}),
    ...(poolKind ? { poolKind } : {}),
  };
}

export function layerZeroOftBridgeDetection(
  knownBridgeContractAddresses: string[],
  stablecoinId: string,
  chainId: string,
  oappAddress = knownBridgeContractAddresses[0],
  zeroRecipientAddress?: string,
): MintBurnBridgeDetectionConfig {
  const endpointId = ({ ethereum: 30101, arbitrum: 30110 } as Record<string, number | undefined>)[chainId];
  if (!endpointId) throw new Error(`Unreviewed LayerZero endpoint id for ${chainId}`);
  return {
    protocol: "layerzero-oft",
    tokenAddress: resolveRequiredTrackedContractConfig(stablecoinId, chainId).contractAddress,
    knownBridgeContractAddresses,
    endpointAddress: "0x1a44076050125825900e736c501f859c50fe728c",
    oappAddress,
    endpointId,
    ...(zeroRecipientAddress ? { zeroRecipientAddress } : {}),
  };
}

function inferAdapterKind(events: MintBurnEventDef[]): MintBurnAdapterKind {
  const hasTransferZeroAddressOnly = events.length === 2
    && events.every((event) =>
      event.signature === "Transfer(address,address,uint256)"
      && event.amountEncoding === "transfer-value"
      && (
        (event.direction === "mint" && event.filterTopic?.index === 1 && event.filterTopic.value === ZERO_ADDRESS_PADDED)
        || (event.direction === "burn" && event.filterTopic?.index === 2 && event.filterTopic.value === ZERO_ADDRESS_PADDED)
      ),
    );
  if (hasTransferZeroAddressOnly) return "transfer-zero-address";

  const hasTransfer = events.some((event) => event.signature === "Transfer(address,address,uint256)");
  return hasTransfer ? "mixed" : "custom-events";
}

export function resolveMintBurnContractConfig(
  spec: MintBurnContractConfigSpec,
): MintBurnContractConfig {
  const resolvedContract = resolveRequiredTrackedContractConfig(spec.stablecoinId, spec.chain.chainId, {
    source: spec.contractSource,
    addressOverride: spec.contractAddressOverride,
    decimalsOverride: spec.decimalsOverride,
  });

  const adapterKind = spec.adapterKind ?? inferAdapterKind(spec.events);
  const defaultedStartBlock = spec.isDefaultStartBlock === true;

  return {
    chain: spec.chain,
    stablecoinId: spec.stablecoinId,
    symbol: resolvedContract.stablecoin.symbol,
    contractAddress: resolvedContract.contractAddress,
    decimals: resolvedContract.decimals,
    dustThreshold: spec.dustThreshold,
    startBlock: spec.startBlock,
    events: spec.events,
    enabled: spec.enabled,
    tier: spec.tier,
    bridgeDetection: spec.bridgeDetection,
    adapterKind,
    startBlockSource: spec.startBlockSource ?? (
      defaultedStartBlock ? "default-coverage-floor-2026-03-24" : "reviewed-contract-specific"
    ),
    startBlockConfidence: spec.startBlockConfidence ?? (defaultedStartBlock ? "low" : "high"),
  };
}

export function uniqueChainIds(configs: MintBurnContractConfig[]): string[] {
  return [...new Set(configs.map((config) => config.chain.chainId))];
}
