import { describe, it, expect } from "vitest";
import { encodeAbiParameters } from "viem/utils";
import { parseEvmLogs } from "../evm-source";
import { CONTRACT_CONFIGS, type ContractEventConfig } from "../../../lib/blacklist-contracts";

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

const RLUSD_CONFIG: ContractEventConfig = {
  configKey: "ethereum-0x8292bb45bf1ee4d140127049757c2e0ff06317ed",
  chain: { chainId: "ethereum", chainName: "Ethereum", evmChainId: 1, explorerUrl: "https://etherscan.io", type: "evm" },
  stablecoinId: "rlusd-ripple",
  stablecoin: "RLUSD",
  contractAddress: "0x8292bb45bf1ee4d140127049757c2e0ff06317ed",
  decimals: 18,
  events: [
    {
      signature: "AccountPaused(address)",
      topicHash: "0xae7f60c1b8f645c3beffeb531169cbc446874bbf247698325318879ac850c346",
      eventType: "blacklist",
      hasAmount: false,
    },
  ],
};

const USDTB_CONFIG: ContractEventConfig = {
  configKey: "ethereum-0xc139190f447e929f090edeb554d95abb8b18ac1c",
  chain: { chainId: "ethereum", chainName: "Ethereum", evmChainId: 1, explorerUrl: "https://etherscan.io", type: "evm" },
  stablecoinId: "usdtb-ethena",
  stablecoin: "USDTB",
  contractAddress: "0xc139190f447e929f090edeb554d95abb8b18ac1c",
  decimals: 18,
  events: [
    {
      signature: "AccountsBlocked(address[])",
      topicHash: "0x5444f9841c04ce78987f28701fa07fc4c112840c1c8439e8f52bda50c3788a87",
      eventType: "blacklist",
      hasAmount: false,
      addressArrayData: true,
    },
  ],
};

const A7A5_CONFIG: ContractEventConfig = {
  configKey: "ethereum-0x6fa0be17e4bea2fcfa22ef89bf8ac9aab0ab0fc9",
  chain: { chainId: "ethereum", chainName: "Ethereum", evmChainId: 1, explorerUrl: "https://etherscan.io", type: "evm" },
  stablecoinId: "a7a5-old-vector",
  stablecoin: "A7A5",
  contractAddress: "0x6fa0be17e4bea2fcfa22ef89bf8ac9aab0ab0fc9",
  decimals: 6,
  events: [
    {
      signature: "DestroyedBlackFunds(address,uint256)",
      topicHash: "0x61e6e66b0d6339b2980aecc6ccc0039736791f0ccde9ed512e789a7fbdd698c6",
      eventType: "destroy",
      hasAmount: true,
    },
  ],
};

const MNEE_CONFIG: ContractEventConfig = {
  configKey: "ethereum-0x8ccedbae4916b79da7f3f612efb2eb93a2bfd6cf",
  chain: { chainId: "ethereum", chainName: "Ethereum", evmChainId: 1, explorerUrl: "https://etherscan.io", type: "evm" },
  stablecoinId: "mnee-mnee",
  stablecoin: "MNEE",
  contractAddress: "0x8ccedbae4916b79da7f3f612efb2eb93a2bfd6cf",
  decimals: 18,
  events: [
    {
      signature: "FundsConfiscated(address,uint256,address)",
      topicHash: "0x5a592536e075e29026312219123e24de374314962469686d4c992d3c7292c1b4",
      eventType: "destroy",
      hasAmount: true,
      amountTopicIndex: 2,
    },
  ],
};

const BUIDL_CONFIG: ContractEventConfig = {
  configKey: "ethereum-0x7712c34205737192402172409a8f7ccef8aa2aec",
  chain: { chainId: "ethereum", chainName: "Ethereum", evmChainId: 1, explorerUrl: "https://etherscan.io", type: "evm" },
  stablecoinId: "buidl-blackrock",
  stablecoin: "BUIDL",
  contractAddress: "0x7712c34205737192402172409a8f7ccef8aa2aec",
  decimals: 6,
  events: [
    {
      signature: "OmnibusSeize(address,address,uint256,string,uint8)",
      topicHash: "0x5c719d01bb88860dfca685ad3818d8b61a083caaf8f68abe6fa0fba4e40e33a9",
      eventType: "destroy",
      hasAmount: true,
      addressDataIndex: 0,
      amountDataIndex: 1,
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

  it("extracts a non-indexed account address from RLUSD AccountPaused data", () => {
    const pausedAddr = "0x4444444444444444444444444444444444444444";
    const logs = [{
      address: "0x8292bb45bf1ee4d140127049757c2e0ff06317ed",
      topics: ["0xae7f60c1b8f645c3beffeb531169cbc446874bbf247698325318879ac850c346"],
      data: encodeAbiParameters([{ type: "address" }], [pausedAddr]),
      blockNumber: "0x1234",
      transactionHash: "0xrlusd",
      logIndex: "0x1",
      timeStamp: "0x65000000",
    }];

    const rows = parseEvmLogs(RLUSD_CONFIG, logs);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      stablecoin: "RLUSD",
      event_type: "blacklist",
      address: pausedAddr,
      amount_native: null,
    });
  });

  it("expands USDTB dynamic address array events into unique rows", () => {
    const firstAddr = "0x5555555555555555555555555555555555555555";
    const secondAddr = "0x6666666666666666666666666666666666666666";
    const logs = [{
      address: "0xc139190f447e929f090edeb554d95abb8b18ac1c",
      topics: ["0x5444f9841c04ce78987f28701fa07fc4c112840c1c8439e8f52bda50c3788a87"],
      data: encodeAbiParameters([{ type: "address[]" }], [[firstAddr, secondAddr]]),
      blockNumber: "0x1234",
      transactionHash: "0xusdtb",
      logIndex: "0x2",
      timeStamp: "0x65000000",
    }];

    const rows = parseEvmLogs(USDTB_CONFIG, logs);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.address)).toEqual([firstAddr, secondAddr]);
    expect(rows.map((row) => row.id)).toEqual([
      "ethereum-0xusdtb-0x2-0",
      "ethereum-0xusdtb-0x2-1",
    ]);
  });

  it("extracts non-indexed A7A5 destroy address and emitted amount", () => {
    const destroyedAddr = "0x7777777777777777777777777777777777777777";
    const logs = [{
      address: "0x6fa0be17e4bea2fcfa22ef89bf8ac9aab0ab0fc9",
      topics: ["0x61e6e66b0d6339b2980aecc6ccc0039736791f0ccde9ed512e789a7fbdd698c6"],
      data: encodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }],
        [destroyedAddr, 123_000_000n],
      ),
      blockNumber: "0x1234",
      transactionHash: "0xa7a5",
      logIndex: "0x3",
      timeStamp: "0x65000000",
    }];

    const rows = parseEvmLogs(A7A5_CONFIG, logs);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      stablecoin: "A7A5",
      event_type: "destroy",
      address: destroyedAddr,
      amount_native: 123,
      amount_source: "event",
      amount_status: "resolved",
    });
    expect(rows[0].amount_usd_at_event).toBeNull();
  });

  it("extracts indexed uint256 amounts from configured amount topics", () => {
    const confiscatedAddr = "0x8888888888888888888888888888888888888888";
    const amountTopic = `0x${(5n * 10n ** 18n).toString(16).padStart(64, "0")}`;
    const logs = [{
      address: "0x8ccedbae4916b79da7f3f612efb2eb93a2bfd6cf",
      topics: [
        "0x5a592536e075e29026312219123e24de374314962469686d4c992d3c7292c1b4",
        `0x000000000000000000000000${confiscatedAddr.slice(2)}`,
        amountTopic,
        "0x0000000000000000000000009999999999999999999999999999999999999999",
      ],
      data: "0x",
      blockNumber: "0x1234",
      transactionHash: "0xmnee",
      logIndex: "0x4",
      timeStamp: "0x65000000",
    }];

    const rows = parseEvmLogs(MNEE_CONFIG, logs);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      stablecoin: "MNEE",
      event_type: "destroy",
      address: confiscatedAddr,
      amount_native: 5,
      amount_usd_at_event: 5,
    });
  });

  it("extracts address and amount from configured data slots when indexed topics are not the subject", () => {
    const seizedAddr = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const logs = [{
      address: "0x7712c34205737192402172409a8f7ccef8aa2aec",
      topics: [
        "0x5c719d01bb88860dfca685ad3818d8b61a083caaf8f68abe6fa0fba4e40e33a9",
        "0x000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      ],
      data: encodeAbiParameters(
        [
          { type: "address" },
          { type: "uint256" },
          { type: "string" },
          { type: "uint8" },
        ],
        [seizedAddr, 25_000_000n, "test", 0],
      ),
      blockNumber: "0x1234",
      transactionHash: "0xbuidl",
      logIndex: "0x5",
      timeStamp: "0x65000000",
    }];

    const rows = parseEvmLogs(BUIDL_CONFIG, logs);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      stablecoin: "BUIDL",
      event_type: "destroy",
      address: seizedAddr,
      amount_native: 25,
      amount_usd_at_event: 25,
    });
  });

  it("decodes BUIDL Seize with amountDataIndex=0 (regression for Agent A C1)", async () => {
    const { encodeAbiParameters, keccak256, toBytes } = await import("viem");
    const seizeTopic = keccak256(toBytes("Seize(address,address,uint256,string)"));
    // data layout: [uint256 value, string reason] — ABI-encoded
    const data = encodeAbiParameters(
      [{ type: "uint256" }, { type: "string" }],
      [25_000_000n, "test"],
    );
    const fromAddress = "0x000000000000000000000000" + "a".repeat(40);
    const toAddress = "0x000000000000000000000000" + "b".repeat(40);
    const config = CONTRACT_CONFIGS.find((c) => c.stablecoinId === "buidl-blackrock" && c.chain.chainId === "ethereum")!;
    const rows = parseEvmLogs(config, [
      {
        address: config.contractAddress,
        topics: [seizeTopic, fromAddress, toAddress],
        data,
        blockNumber: "0x100",
        transactionHash: "0xdeadbeef".padEnd(66, "0"),
        logIndex: "0x0",
        timeStamp: "0x1000",
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].amount_native).toBe(25);
    expect(rows[0].event_type).toBe("destroy");
  });
});
