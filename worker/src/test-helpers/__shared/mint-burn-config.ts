import type {
  MintBurnBridgeDetectionConfig,
  MintBurnContractConfig,
  MintBurnEventDef,
} from "../../lib/mint-burn-contracts-types";

export interface MakeMintBurnConfigOverrides {
  chain?: Partial<MintBurnContractConfig["chain"]>;
  asset?: Partial<
    Pick<
      MintBurnContractConfig,
      | "stablecoinId"
      | "symbol"
      | "contractAddress"
      | "decimals"
      | "dustThreshold"
      | "startBlock"
      | "enabled"
      | "tier"
      | "startBlockSource"
      | "startBlockConfidence"
    >
  >;
  adapter?: MintBurnContractConfig["adapterKind"];
  events?: MintBurnEventDef[];
  bridgeDetection?: MintBurnBridgeDetectionConfig | null;
}

const DEFAULT_MINT_BURN_CHAIN: MintBurnContractConfig["chain"] = {
  chainId: "ethereum",
  chainName: "Ethereum",
  evmChainId: 1,
  explorerUrl: "https://etherscan.io",
  type: "evm",
};

const DEFAULT_MINT_BURN_ASSET: Pick<
  MintBurnContractConfig,
  | "stablecoinId"
  | "symbol"
  | "contractAddress"
  | "decimals"
  | "dustThreshold"
  | "startBlock"
  | "startBlockSource"
  | "startBlockConfidence"
> = {
  stablecoinId: "usdt-tether",
  symbol: "USDT",
  contractAddress: "0x0000000000000000000000000000000000000001",
  decimals: 6,
  dustThreshold: 10_000,
  startBlock: 21_900_000,
  startBlockSource: "reviewed-contract-specific",
  startBlockConfidence: "high",
};

export function makeMintBurnConfig({
  chain,
  asset,
  adapter = "transfer-zero-address",
  events = [],
  bridgeDetection,
}: MakeMintBurnConfigOverrides = {}): MintBurnContractConfig {
  return {
    chain: { ...DEFAULT_MINT_BURN_CHAIN, ...chain },
    ...DEFAULT_MINT_BURN_ASSET,
    ...asset,
    adapterKind: adapter,
    events,
    ...(bridgeDetection ? { bridgeDetection } : {}),
  };
}

/** A zero-address `Transfer` event definition: mints filter `from`, burns filter `to`. */
export function makeMintBurnTransferEvent(direction: "mint" | "burn"): MintBurnEventDef {
  return {
    signature: "Transfer(address,address,uint256)",
    topicHash: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
    direction, amountEncoding: "transfer-value",
    filterTopic: { index: direction === "mint" ? 1 : 2,
      value: "0x0000000000000000000000000000000000000000000000000000000000000000" },
  };
}
