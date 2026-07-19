import { afterEach, describe, it, expect, vi } from "vitest";
import { encodeAbiParameters } from "viem/utils";
import { parseEvmLogs } from "../evm-source";
import { CONTRACT_CONFIGS, type ContractEventConfig } from "../../../lib/blacklist-contracts";
import {
  createBudget,
  fetchEvmLogsForTopicsWithCompleteness,
  type EtherscanLogEntry,
} from "../../../lib/evm-logs";

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

const INDEXED_AMOUNT_CONFIG: ContractEventConfig = {
  configKey: "ethereum-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48-indexed-amount-fixture",
  chain: { chainId: "ethereum", chainName: "Ethereum", evmChainId: 1, explorerUrl: "https://etherscan.io", type: "evm" },
  stablecoinId: "usdc-circle",
  stablecoin: "USDC",
  contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  decimals: 6,
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

function makeEtherscanLog(blockNumber: number, index: number): EtherscanLogEntry {
  return {
    address: "0x123",
    topics: ["0xabc"],
    data: "0x",
    blockNumber: `0x${blockNumber.toString(16)}`,
    timeStamp: "0x65000000",
    transactionHash: `0xhash${index}`,
    logIndex: `0x${index.toString(16)}`,
  };
}

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
    const amountTopic = `0x${(5n * 10n ** 6n).toString(16).padStart(64, "0")}`;
    const logs = [{
      address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      topics: [
        "0x5a592536e075e29026312219123e24de374314962469686d4c992d3c7292c1b4",
        `0x000000000000000000000000${confiscatedAddr.slice(2)}`,
        amountTopic,
        "0x0000000000000000000000009999999999999999999999999999999999999999",
      ],
      data: "0x",
      blockNumber: "0x1234",
      transactionHash: "0xindexed",
      logIndex: "0x4",
      timeStamp: "0x65000000",
    }];

    const rows = parseEvmLogs(INDEXED_AMOUNT_CONFIG, logs);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      stablecoin: "USDC",
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

  it("keeps rows recoverable when a configured amount data slot is missing", () => {
    const seizedAddr = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const rows = parseEvmLogs(BUIDL_CONFIG, [{
      address: BUIDL_CONFIG.contractAddress,
      topics: [
        "0x5c719d01bb88860dfca685ad3818d8b61a083caaf8f68abe6fa0fba4e40e33a9",
        "0x000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      ],
      data: encodeAbiParameters([{ type: "address" }], [seizedAddr]),
      blockNumber: "0x1234",
      transactionHash: "0xbuidl-short",
      logIndex: "0x6",
      timeStamp: "0x65000000",
    }]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      address: seizedAddr,
      amount_native: null,
      amount_usd_at_event: null,
      amount_source: "unavailable",
      amount_status: "recoverable_pending",
    });
  });

  it("skips malformed scalar address data instead of creating a bogus 0x row", () => {
    const rows = parseEvmLogs(USDC_CONFIG, [{
      address: USDC_CONFIG.contractAddress,
      topics: ["0xffa4e6181777692565cf28528fc88fd1516ea86b56da075235fa575af6a4b855"],
      data: "0x1234",
      blockNumber: "0x1234",
      transactionHash: "0xshort-address",
      logIndex: "0x7",
      timeStamp: "0x65000000",
    }]);

    expect(rows).toHaveLength(0);
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

describe("fetchEvmLogsForTopicsWithCompleteness", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const noopLimiter = <T>(fn: () => Promise<T>) => fn();

  it("returns incomplete split coverage when a recursive half fails", async () => {
    const saturated = Array.from({ length: 1000 }, (_, index) => makeEtherscanLog(index, index));
    const firstHalf = [makeEtherscanLog(10, 1001)];
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ status: "1", message: "OK", result: saturated }), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ status: "1", message: "OK", result: firstHalf }), { status: 200 }),
        )
        .mockResolvedValueOnce(new Response("server error", { status: 500 })),
    );

    const result = await fetchEvmLogsForTopicsWithCompleteness(
      1,
      "0x123",
      [{ index: 0, value: "0xabc" }],
      null,
      0,
      100,
      0,
      noopLimiter,
      createBudget(10),
    );

    expect(result.complete).toBe(false);
    expect(result.scannedToBlock).toBe(50);
    expect(result.logs).toEqual(firstHalf);
  });
});

describe("wlfi-freeze destroy events", () => {
  const usd1Config = CONTRACT_CONFIGS.find(
    (c) => c.stablecoinId === "usd1-world-liberty-financial" && c.chain.chainId === "ethereum",
  )!;

  it("parses FrozenAccountDrained with victim at topics[2] and amount at data slot 0", () => {
    const victim = "0x" + "aa".repeat(20);
    const caller = "0x" + "bb".repeat(20);
    const topic0 = "0x76fa81ac53e82d7102caacc3866ae3ca5684caa4c24d995ff4d76ce8a10fbfef";
    const data = encodeAbiParameters([{ type: "uint256" }], [1_000_000_000_000_000_000n]);
    const rows = parseEvmLogs(usd1Config, [
      {
        address: usd1Config.contractAddress,
        topics: [topic0, ("0x" + "0".repeat(24) + caller.slice(2)) as `0x${string}`, ("0x" + "0".repeat(24) + victim.slice(2)) as `0x${string}`],
        data,
        blockNumber: "0x100",
        transactionHash: "0xdeadbeef".padEnd(66, "0"),
        logIndex: "0x0",
        timeStamp: "0x1000",
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe("destroy");
    expect(rows[0].address.toLowerCase()).toBe(victim);
    expect(rows[0].amount_native).toBe(1);
  });

  it("parses FrozenFundsReallocated with `from` at topics[2] and amount at data slot 0", () => {
    const caller = "0x" + "11".repeat(20);
    const from = "0x" + "22".repeat(20);
    const to = "0x" + "33".repeat(20);
    const topic0 = "0x10aa54b8d21641b161adf6251c11512c46fcf822feaf6f66057c006dc29def4a";
    const data = encodeAbiParameters([{ type: "uint256" }], [2_000_000_000_000_000_000n]);
    const rows = parseEvmLogs(usd1Config, [
      {
        address: usd1Config.contractAddress,
        topics: [
          topic0,
          ("0x" + "0".repeat(24) + caller.slice(2)) as `0x${string}`,
          ("0x" + "0".repeat(24) + from.slice(2)) as `0x${string}`,
          ("0x" + "0".repeat(24) + to.slice(2)) as `0x${string}`,
        ],
        data,
        blockNumber: "0x101",
        transactionHash: "0xfeedface".padEnd(66, "0"),
        logIndex: "0x0",
        timeStamp: "0x1001",
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe("destroy");
    expect(rows[0].address.toLowerCase()).toBe(from);
    expect(rows[0].amount_native).toBe(2);
  });
});

describe("parseEvmLogs branch coverage", () => {
  it("skips logs with malformed blockNumber", () => {
    const rows = parseEvmLogs(USDC_CONFIG, [
      {
        address: USDC_CONFIG.contractAddress,
        topics: ["0xffa4e6181777692565cf28528fc88fd1516ea86b56da075235fa575af6a4b855", "0x" + "0".repeat(24) + "aa".repeat(20)],
        data: "0x",
        blockNumber: "0xzz",
        transactionHash: "0xdeadbeef".padEnd(66, "0"),
        logIndex: "0x0",
        timeStamp: "0x1000",
      },
    ]);
    expect(rows).toHaveLength(0);
  });

  it("skips logs with missing timestamp", () => {
    const rows = parseEvmLogs(USDC_CONFIG, [
      {
        address: USDC_CONFIG.contractAddress,
        topics: ["0xffa4e6181777692565cf28528fc88fd1516ea86b56da075235fa575af6a4b855", "0x" + "0".repeat(24) + "aa".repeat(20)],
        data: "0x",
        blockNumber: "0x100",
        transactionHash: "0xdeadbeef".padEnd(66, "0"),
        logIndex: "0x0",
      },
    ]);
    expect(rows).toHaveLength(0);
  });

  it("returns undefined for unknown topic hash", () => {
    const rows = parseEvmLogs(USDC_CONFIG, [
      {
        address: USDC_CONFIG.contractAddress,
        topics: ["0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"],
        data: "0x",
        blockNumber: "0x100",
        transactionHash: "0xdeadbeef".padEnd(66, "0"),
        logIndex: "0x0",
        timeStamp: "0x1000",
      },
    ]);
    expect(rows).toHaveLength(0);
  });

  it("handles malformed address array data gracefully", () => {
    const rows = parseEvmLogs(USDTB_CONFIG, [
      {
        address: USDTB_CONFIG.contractAddress,
        topics: ["0x5444f9841c04ce78987f28701fa07fc4c112840c1c8439e8f52bda50c3788a87"],
        data: "0xdeadbeef",
        blockNumber: "0x100",
        transactionHash: "0xdeadbeef".padEnd(66, "0"),
        logIndex: "0x0",
        timeStamp: "0x1000",
      },
    ]);
    expect(rows).toHaveLength(0);
  });

  it("caps decoded address[] event to MAX_DECODED_ADDRESS_ARRAY", () => {
    const addresses = Array.from({ length: 1000 }, (_, i) =>
      "0x" + (i + 1).toString(16).padStart(40, "0"),
    );
    const encoded = encodeAbiParameters(
      [{ type: "address[]" }],
      [addresses as `0x${string}`[]],
    );
    const rows = parseEvmLogs(USDTB_CONFIG, [
      {
        address: USDTB_CONFIG.contractAddress,
        topics: ["0x5444f9841c04ce78987f28701fa07fc4c112840c1c8439e8f52bda50c3788a87"],
        data: encoded,
        blockNumber: "0x1",
        transactionHash: "0xdead",
        logIndex: "0x0",
        timeStamp: "0x61000000",
      },
    ]);
    expect(rows.length).toBe(500);
  });

  it("resolves eventType from data bool slot (bool=true => blacklist)", () => {
    const tusdBlacklistedTopic = "0xcf3473b85df1594d47b6958f29a32bea0abff9dd68296f7bf33443646793cfd8";
    const account = "0x0000000000000000000000001111111111111111111111111111111111111111";
    const config: ContractEventConfig = {
      configKey: "ethereum-0x0000000000085d4780b73119b644ae5ecd22b376",
      chain: { chainId: "ethereum", chainName: "Ethereum", evmChainId: 1, explorerUrl: "https://etherscan.io", type: "evm" },
      stablecoinId: "tusd-trueusd",
      stablecoin: "USDC", // placeholder — we only care about event_type resolution here
      contractAddress: "0x0000000000085d4780b73119b644ae5ecd22b376",
      decimals: 18,
      events: [
        {
          signature: "Blacklisted(address,bool)",
          topicHash: tusdBlacklistedTopic,
          eventType: "blacklist",
          hasAmount: false,
          eventTypeFromDataBoolIndex: 0,
        },
      ],
    };
    const rows = parseEvmLogs(config, [
      {
        address: config.contractAddress,
        topics: [tusdBlacklistedTopic, account],
        data: "0x" + "01".padStart(64, "0"),
        blockNumber: "0x1",
        transactionHash: "0xtusd-on",
        logIndex: "0x0",
        timeStamp: "0x61000000",
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe("blacklist");
    expect(rows[0].address).toBe("0x1111111111111111111111111111111111111111");
  });

  it("resolves eventType from data bool slot (bool=false => unblacklist)", () => {
    const tusdBlacklistedTopic = "0xcf3473b85df1594d47b6958f29a32bea0abff9dd68296f7bf33443646793cfd8";
    const account = "0x0000000000000000000000002222222222222222222222222222222222222222";
    const config: ContractEventConfig = {
      configKey: "ethereum-0x0000000000085d4780b73119b644ae5ecd22b376",
      chain: { chainId: "ethereum", chainName: "Ethereum", evmChainId: 1, explorerUrl: "https://etherscan.io", type: "evm" },
      stablecoinId: "tusd-trueusd",
      stablecoin: "USDC", // placeholder — we only care about event_type resolution here
      contractAddress: "0x0000000000085d4780b73119b644ae5ecd22b376",
      decimals: 18,
      events: [
        {
          signature: "Blacklisted(address,bool)",
          topicHash: tusdBlacklistedTopic,
          eventType: "blacklist",
          hasAmount: false,
          eventTypeFromDataBoolIndex: 0,
        },
      ],
    };
    const rows = parseEvmLogs(config, [
      {
        address: config.contractAddress,
        topics: [tusdBlacklistedTopic, account],
        data: "0x" + "00".repeat(32),
        blockNumber: "0x1",
        transactionHash: "0xtusd-off",
        logIndex: "0x0",
        timeStamp: "0x61000000",
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe("unblacklist");
    expect(rows[0].address).toBe("0x2222222222222222222222222222222222222222");
  });

  it("treats high-bit-set data slot as truthy (uint256 max => blacklist)", () => {
    const tusdBlacklistedTopic = "0xcf3473b85df1594d47b6958f29a32bea0abff9dd68296f7bf33443646793cfd8";
    const account = "0x0000000000000000000000003333333333333333333333333333333333333333";
    const config: ContractEventConfig = {
      configKey: "ethereum-0x0000000000085d4780b73119b644ae5ecd22b376",
      chain: { chainId: "ethereum", chainName: "Ethereum", evmChainId: 1, explorerUrl: "https://etherscan.io", type: "evm" },
      stablecoinId: "tusd-trueusd",
      stablecoin: "USDC",
      contractAddress: "0x0000000000085d4780b73119b644ae5ecd22b376",
      decimals: 18,
      events: [
        {
          signature: "Blacklisted(address,bool)",
          topicHash: tusdBlacklistedTopic,
          eventType: "blacklist",
          hasAmount: false,
          eventTypeFromDataBoolIndex: 0,
        },
      ],
    };
    const rows = parseEvmLogs(config, [
      {
        address: config.contractAddress,
        topics: [tusdBlacklistedTopic, account],
        data: "0x" + "ff".repeat(32),
        blockNumber: "0x1",
        transactionHash: "0xtusd-maxuint",
        logIndex: "0x0",
        timeStamp: "0x61000000",
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe("blacklist");
  });

  it("decodes non-indexed address from data for USDT DestroyedBlackFunds", () => {
    const usdtConfig = CONTRACT_CONFIGS.find(
      (c) => c.stablecoinId === "usdt-tether" && c.chain.chainId === "ethereum",
    )!;
    const destroyTopic = "0x61e6e66b0d6339b2980aecc6ccc0039736791f0ccde9ed512e789a7fbdd698c6";
    const address = "0x" + "bb".repeat(20);
    const amount = encodeAbiParameters([{ type: "uint256" }], [5_000_000n]);
    const data = "0x" + "0".repeat(24) + address.slice(2) + amount.slice(2);
    const rows = parseEvmLogs(usdtConfig, [
      {
        address: usdtConfig.contractAddress,
        topics: [destroyTopic],
        data,
        blockNumber: "0x200",
        transactionHash: "0xcafebabe".padEnd(66, "0"),
        logIndex: "0x0",
        timeStamp: "0x2000",
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe("destroy");
    expect(rows[0].amount_native).toBe(5);
  });
});
