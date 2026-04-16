import { resolveRequiredTrackedContractConfig } from "./tracked-contract-resolution";
import type {
  MintBurnAdapterKind,
  MintBurnBridgeDetectionConfig,
  MintBurnContractConfig,
  MintBurnContractConfigSpec,
  MintBurnEventDef,
} from "./mint-burn-contracts-types";

const ZERO_ADDRESS_PADDED = "0x0000000000000000000000000000000000000000000000000000000000000000";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const CCIP_ETHEREUM_ROUTER = "0x80226fc0ee2b096224eeac085bb9a8cba1146f7d";
const CCIP_SEND_REQUESTED_TOPIC = "0xd0c3c799bf9e2639de44391e7f524d229b2b55f5b1ea94b2bf7da42f7243dddd";
const CCIP_SEND_SELECTOR = "0x96f4e9f9";
const LAYERZERO_ENDPOINT_V2 = "0x1a44076050125825900e736c501f859c50fe728c";
const LAYERZERO_PACKET_SENT_TOPIC = "0x1ab700d4ced0c005b164c0f789fd09fcbb0156d4c2041b8a3bfbcd961cd1567f";
const LAYERZERO_PACKET_DELIVERED_TOPIC = "0x3cd5e48f9730b129dc7550f0fcea9c767b7be37837cd10e55eb35f734f4bca04";
const LAYERZERO_SEND_SELECTOR = "0xc7c7f5b3";
const LAYERZERO_EXECUTE302_SELECTOR = "0xcfc32570";
const LAYERZERO_LOCAL_COMPOSE_SELECTOR = "0x7cd44734";

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

const CCTP_ETHEREUM_TOKEN_MESSENGER_V2 = "0x28b5a0e9c621a5badaa536219b3a228c8168cf5d";
const CCTP_DEPOSIT_FOR_BURN_TOPIC = "0x2fa9ca894982930190727e75500a97d8dc500233a5065e0f3126c48fbe0343c0";
const CCTP_DEPOSIT_FOR_BURN_SELECTOR = "0x6fd3504e";
const CCTP_DEPOSIT_FOR_BURN_WITH_CALLER_SELECTOR = "0xf856ddb6";

export function cctpBridgeDetection(
  knownBridgePoolAddresses: string[],
): MintBurnBridgeDetectionConfig {
  return {
    protocol: "cctp",
    knownBridgePoolAddresses,
    knownBridgeRouterAddresses: [CCTP_ETHEREUM_TOKEN_MESSENGER_V2],
    bridgeSignalTopics: [CCTP_DEPOSIT_FOR_BURN_TOPIC],
    bridgeSignalSelectors: [CCTP_DEPOSIT_FOR_BURN_SELECTOR, CCTP_DEPOSIT_FOR_BURN_WITH_CALLER_SELECTOR],
  };
}

export function ccipBridgeDetection(
  knownBridgePoolAddresses: string[],
): MintBurnBridgeDetectionConfig {
  return {
    protocol: "ccip",
    knownBridgePoolAddresses,
    knownBridgeRouterAddresses: [CCIP_ETHEREUM_ROUTER],
    bridgeSignalTopics: [CCIP_SEND_REQUESTED_TOPIC],
    bridgeSignalSelectors: [CCIP_SEND_SELECTOR],
  };
}

export function layerZeroOftBridgeDetection(
  knownBridgeContractAddresses: string[],
): MintBurnBridgeDetectionConfig {
  return {
    protocol: "layerzero-oft",
    knownBridgeContractAddresses,
    bridgeSignalEmitterAddresses: [LAYERZERO_ENDPOINT_V2],
    bridgeSignalTopics: [LAYERZERO_PACKET_SENT_TOPIC, LAYERZERO_PACKET_DELIVERED_TOPIC],
    bridgeSignalSelectors: [
      LAYERZERO_SEND_SELECTOR,
      LAYERZERO_EXECUTE302_SELECTOR,
      LAYERZERO_LOCAL_COMPOSE_SELECTOR,
    ],
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
