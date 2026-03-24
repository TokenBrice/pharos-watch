import { describe, it, expect } from "vitest";
import { parseEvmLogs } from "../evm-source";
import type { ContractEventConfig } from "../../../lib/blacklist-contracts";

const USD1_CONFIG: ContractEventConfig = {
  configKey: "ethereum-0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d",
  chain: { chainId: "ethereum", chainName: "Ethereum", evmChainId: 1, explorerUrl: "https://etherscan.io", type: "evm" },
  stablecoinId: "usd1-world-liberty-financial",
  stablecoin: "USD1",
  contractAddress: "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d",
  decimals: 18,
  events: [
    {
      signature: "Freeze(address,address)",
      topicHash: "0x51d18786e9cb144f87d46e7b796309ea84c7c687d91e09c97f051eacf59bc528",
      eventType: "blacklist",
      hasAmount: false,
      addressTopicIndex: 2,
    },
  ],
};

const USDC_CONFIG: ContractEventConfig = {
  configKey: "ethereum-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  chain: { chainId: "ethereum", chainName: "Ethereum", evmChainId: 1, explorerUrl: "https://etherscan.io", type: "evm" },
  stablecoinId: "usdc-circle",
  stablecoin: "USDC",
  contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  decimals: 6,
  events: [
    {
      signature: "Blacklisted(address)",
      topicHash: "0xffa4e6181777692565cf28528fc88fd1516ea86b56da075235fa575af6a4b855",
      eventType: "blacklist",
      hasAmount: false,
    },
  ],
};

describe("parseEvmLogs", () => {
  it("extracts address from topics[2] when addressTopicIndex is 2 (USD1)", () => {
    const callerAddr = "0x0000000000000000000000001111111111111111111111111111111111111111";
    const frozenAddr = "0x0000000000000000000000002222222222222222222222222222222222222222";
    const logs = [{
      address: "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d",
      topics: [
        "0x51d18786e9cb144f87d46e7b796309ea84c7c687d91e09c97f051eacf59bc528",
        callerAddr,
        frozenAddr,
      ],
      data: "0x",
      blockNumber: "0x1234",
      transactionHash: "0xabc",
      logIndex: "0x0",
      timeStamp: "0x65000000",
    }];
    const rows = parseEvmLogs(USD1_CONFIG, logs);
    expect(rows).toHaveLength(1);
    expect(rows[0].address).toBe("0x2222222222222222222222222222222222222222");
    expect(rows[0].stablecoin).toBe("USD1");
    expect(rows[0].event_type).toBe("blacklist");
  });

  it("extracts address from topics[1] by default (USDC regression)", () => {
    const blacklistedAddr = "0x0000000000000000000000003333333333333333333333333333333333333333";
    const logs = [{
      address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      topics: [
        "0xffa4e6181777692565cf28528fc88fd1516ea86b56da075235fa575af6a4b855",
        blacklistedAddr,
      ],
      data: "0x",
      blockNumber: "0x1234",
      transactionHash: "0xdef",
      logIndex: "0x0",
      timeStamp: "0x65000000",
    }];
    const rows = parseEvmLogs(USDC_CONFIG, logs);
    expect(rows).toHaveLength(1);
    expect(rows[0].address).toBe("0x3333333333333333333333333333333333333333");
  });
});
