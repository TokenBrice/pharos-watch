import { describe, expect, it } from "vitest";
import { parseMintBurnLogs } from "../mint-burn-pipeline/parse";
import type { MintBurnContractConfig, MintBurnEventDef } from "../mint-burn-contracts";
import type { AlchemyLogEntry } from "../alchemy-logs";

describe("parseMintBurnLogs — custom event encodings", () => {
  const ETHEREUM_CHAIN = {
    chainId: "ethereum",
    chainName: "Ethereum",
    evmChainId: 1,
    explorerUrl: "https://etherscan.io",
    type: "evm" as const,
  };

  // 10,000 USDT = 10_000_000_000 raw (6 decimals)
  const TEN_THOUSAND_USDT_HEX =
    "0x" + "00000000000000000000000000000000000000000000000000000002540be400";
  const USDT_ADDRESS = "0xdac17f958d2ee523a2206206994597c13d831ec7";

  const usdtIssueEventDef: MintBurnEventDef = {
    signature: "Issue(uint256)",
    topicHash: "0xcb8241adb0c3fdb35b70c24ce35c5eb0c17af7431c99f827d44a445ca624176a",
    direction: "mint" as const,
    amountEncoding: "first-data-uint256" as const,
  };

  const usdtRedeemEventDef: MintBurnEventDef = {
    signature: "Redeem(uint256)",
    topicHash: "0x702d5967f45f6513a38ffc42d6ba9bf230bd40e8f53b16363c7eb4fd2deb9a44",
    direction: "burn" as const,
    amountEncoding: "first-data-uint256" as const,
  };

  const makeUsdtConfig = (): MintBurnContractConfig => ({
    stablecoinId: "usdt-tether",
    symbol: "USDT",
    chain: ETHEREUM_CHAIN,
    contractAddress: USDT_ADDRESS,
    decimals: 6,
    dustThreshold: 10_000,
    startBlock: 21_900_000,
    adapterKind: "custom-events",
    startBlockSource: "reviewed-contract-specific",
    startBlockConfidence: "high",
    tier: "critical",
    events: [usdtIssueEventDef, usdtRedeemEventDef],
  });

  const makeLog = (overrides: Partial<AlchemyLogEntry> = {}): AlchemyLogEntry => ({
    address: USDT_ADDRESS,
    topics: [usdtIssueEventDef.topicHash],
    data: TEN_THOUSAND_USDT_HEX,
    blockNumber: "0x14e0001",
    logIndex: "0x5",
    transactionHash: "0xabc1230000000000000000000000000000000000000000000000000000000001",
    blockHash: "0x0",
    transactionIndex: "0x0",
    removed: false,
    ...overrides,
  });

  // 0x14e0001 = 21,889,025
  const blockTimestamps = new Map([
    [21_889_025, 1700000000],
    [24_540_392, 1740578939],
    [25_193_105, 1748509227],
  ]);
  const prices = new Map([["usdt-tether", 1.0]]);
  const priceHistory = new Map<string, []>();
  const runTimestamp = 1700000100;

  it("parses USDT Issue event as mint with correct amount", () => {
    const config = makeUsdtConfig();
    const { rows, dropped } = parseMintBurnLogs(
      config,
      usdtIssueEventDef,
      [makeLog()],
      blockTimestamps,
      prices,
      priceHistory,
      runTimestamp,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].direction).toBe("mint");
    expect(rows[0].amount).toBe(10_000);
    expect(rows[0].amount_usd).toBe(10_000);
    expect(rows[0].symbol).toBe("USDT");
    expect(rows[0].stablecoin_id).toBe("usdt-tether");
    expect(dropped).toBe(0);
  });

  it("parses USDT Redeem event as burn with correct amount", () => {
    const config = makeUsdtConfig();
    const redeemLog = makeLog({
      topics: [usdtRedeemEventDef.topicHash],
      transactionHash: "0xdef4560000000000000000000000000000000000000000000000000000000002",
    });
    const { rows, dropped } = parseMintBurnLogs(
      config,
      usdtRedeemEventDef,
      [redeemLog],
      blockTimestamps,
      prices,
      priceHistory,
      runTimestamp,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].direction).toBe("burn");
    expect(rows[0].amount).toBe(10_000);
    expect(rows[0].burn_type).toBe("effective_burn");
    expect(dropped).toBe(0);
  });

  it("drops Issue events below dust threshold", () => {
    const config = makeUsdtConfig();
    // 9,999 USDT = below 10,000 dust threshold
    const dustHex = "0x" + BigInt(9_999_000_000).toString(16).padStart(64, "0");
    const dustLog = makeLog({ data: dustHex });
    const { rows, dropped } = parseMintBurnLogs(
      config,
      usdtIssueEventDef,
      [dustLog],
      blockTimestamps,
      prices,
      priceHistory,
      runTimestamp,
    );

    expect(rows).toHaveLength(0);
    expect(dropped).toBe(1);
  });

  it("sets counterparty to null for Issue events (no address topics)", () => {
    const config = makeUsdtConfig();
    const log = makeLog({ topics: [usdtIssueEventDef.topicHash] });
    const { rows } = parseMintBurnLogs(
      config,
      usdtIssueEventDef,
      [log],
      blockTimestamps,
      prices,
      priceHistory,
      runTimestamp,
    );

    expect(rows[0].counterparty).toBeNull();
  });

  // --- reUSD token Transfer parsing ---

  const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const ZERO_ADDRESS_PADDED = "0x0000000000000000000000000000000000000000000000000000000000000000";
  const REUSD_TOKEN_ADDRESS = "0x5086bf358635b81d8c47c66d1c8b9e567db70c72";
  const REUSD_USER = "0x0000000000000000000000003f0bf2350a9d2c0e976ca0749d13b732202468a6";

  const reusdTransferMintEventDef: MintBurnEventDef = {
    signature: "Transfer(address,address,uint256)",
    topicHash: TRANSFER_TOPIC,
    direction: "mint" as const,
    amountEncoding: "transfer-value" as const,
    filterTopic: { index: 1, value: ZERO_ADDRESS_PADDED },
  };

  const reusdTransferBurnEventDef: MintBurnEventDef = {
    signature: "Transfer(address,address,uint256)",
    topicHash: TRANSFER_TOPIC,
    direction: "burn" as const,
    amountEncoding: "transfer-value" as const,
    filterTopic: { index: 2, value: ZERO_ADDRESS_PADDED },
  };

  const makeReusdConfig = (
    eventDef: MintBurnEventDef,
    overrides: Partial<Pick<MintBurnContractConfig, "dustThreshold">> = {},
  ): MintBurnContractConfig => ({
    stablecoinId: "reusd-re-protocol",
    symbol: "reUSD",
    chain: ETHEREUM_CHAIN,
    contractAddress: REUSD_TOKEN_ADDRESS,
    decimals: 18,
    dustThreshold: overrides.dustThreshold ?? 10_000,
    startBlock: 21_675_000,
    adapterKind: "transfer-zero-address",
    startBlockSource: "reviewed-contract-specific",
    startBlockConfidence: "high",
    tier: "extended",
    events: [eventDef],
  });

  it("parses issue #143 reUSD USDC deposit from the token Transfer mint amount", () => {
    const config = makeReusdConfig(reusdTransferMintEventDef);
    const log: AlchemyLogEntry = {
      address: REUSD_TOKEN_ADDRESS,
      topics: [
        TRANSFER_TOPIC,
        ZERO_ADDRESS_PADDED,
        REUSD_USER,
      ],
      data: "0x0000000000000000000000000000000000000000000005a4174ed7b223a2d5b9",
      blockNumber: "0x1806a91",
      logIndex: "0x17e",
      transactionHash: "0xef6c0033ae6d3af5acd3f7a84b9903d087e317ff8d2b528a196fbe068644bf63",
      blockHash: "0x0",
      transactionIndex: "0x0",
      removed: false,
    };

    const { rows, dropped } = parseMintBurnLogs(
      config,
      reusdTransferMintEventDef,
      [log],
      blockTimestamps,
      new Map([["reusd-re-protocol", 1.0]]),
      priceHistory,
      runTimestamp,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].direction).toBe("mint");
    expect(rows[0].amount).toBeCloseTo(26_638.777959, 6);
    expect(rows[0].amount_usd).toBeCloseTo(26_638.777959, 6);
    expect(rows[0].stablecoin_id).toBe("reusd-re-protocol");
    expect(rows[0].counterparty).toBe("0x3f0bf2350a9d2c0e976ca0749d13b732202468a6");
    expect(dropped).toBe(0);
  });

  it("parses reUSD redemption burns from the token Transfer burn amount", () => {
    const config = makeReusdConfig(reusdTransferBurnEventDef, { dustThreshold: 1 });
    const log: AlchemyLogEntry = {
      address: REUSD_TOKEN_ADDRESS,
      topics: [
        TRANSFER_TOPIC,
        "0x000000000000000000000000a31deebb3680a3007120e74bcbdf4df36f042a40",
        ZERO_ADDRESS_PADDED,
      ],
      data: "0x0000000000000000000000000000000000000000000001fe0d9b83ef66d20000",
      blockNumber: "0x17674e8",
      logIndex: "0x1",
      transactionHash: "0x831367d37ebb2bd3bf41a1152124a493c309b1f092ce161da578d635b49d23e8",
      blockHash: "0x0",
      transactionIndex: "0x0",
      removed: false,
    };

    const { rows, dropped } = parseMintBurnLogs(
      config,
      reusdTransferBurnEventDef,
      [log],
      blockTimestamps,
      new Map([["reusd-re-protocol", 1.0]]),
      priceHistory,
      runTimestamp,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].direction).toBe("burn");
    expect(rows[0].amount).toBeCloseTo(9_408.82, 6);
    expect(rows[0].burn_type).toBe("effective_burn");
    expect(rows[0].counterparty).toBe("0xa31deebb3680a3007120e74bcbdf4df36f042a40");
    expect(dropped).toBe(0);
  });
});

describe("parseMintBurnLogs — price resolution", () => {
  const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const ZERO_PADDED = "0x0000000000000000000000000000000000000000000000000000000000000000";

  const ETHEREUM_CHAIN = {
    chainId: "ethereum",
    chainName: "Ethereum",
    evmChainId: 1,
    explorerUrl: "https://etherscan.io",
    type: "evm" as const,
  };

  const config: MintBurnContractConfig = {
    stablecoinId: "usdc-circle",
    symbol: "USDC",
    chain: ETHEREUM_CHAIN,
    contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    decimals: 6,
    dustThreshold: 100,
    startBlock: 21_000_000,
    adapterKind: "transfer-zero-address",
    startBlockSource: "reviewed-contract-specific",
    startBlockConfidence: "high",
    tier: "critical",
    events: [],
  };

  const mintEventDef: MintBurnEventDef = {
    signature: "Transfer(address,address,uint256)",
    topicHash: TRANSFER_TOPIC,
    direction: "mint" as const,
    amountEncoding: "first-data-uint256" as const,
  };

  // 1,000 USDC = 1_000_000_000 raw (6 decimals)
  const AMOUNT_1K_HEX = "0x" + BigInt(1_000_000_000).toString(16).padStart(64, "0");

  const makeTransferLog = (): AlchemyLogEntry => ({
    address: config.contractAddress,
    topics: [TRANSFER_TOPIC, ZERO_PADDED, "0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    data: AMOUNT_1K_HEX,
    blockNumber: "0x140a001", // 21_012_481
    logIndex: "0x1",
    transactionHash: "0xprice100000000000000000000000000000000000000000000000000000000001",
    blockHash: "0x0",
    transactionIndex: "0x0",
    removed: false,
  });

  const blockTimestamps = new Map([[21_012_481, 1700000000]]);
  const runTimestamp = 1700000100;

  it("uses current price when no history is available", () => {
    const prices = new Map([["usdc-circle", 0.9998]]);
    const priceHistory = new Map<string, { snapshotDate: number; price: number }[]>();

    const { rows } = parseMintBurnLogs(
      config,
      mintEventDef,
      [makeTransferLog()],
      blockTimestamps,
      prices,
      priceHistory,
      runTimestamp,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].price_used).toBe(0.9998);
    expect(rows[0].price_source).toBe("price-cache-current");
    expect(rows[0].price_timestamp).toBe(runTimestamp);
    expect(rows[0].amount_usd).toBeCloseTo(999.8, 1);
  });

  it("uses historical price when available", () => {
    const dayTs = Math.floor(1700000000 / 86400) * 86400;
    const prices = new Map([["usdc-circle", 0.9998]]);
    const priceHistory = new Map([
      ["usdc-circle", [{ snapshotDate: dayTs, price: 1.0002 }]],
    ]);

    const { rows } = parseMintBurnLogs(
      config,
      mintEventDef,
      [makeTransferLog()],
      blockTimestamps,
      prices,
      priceHistory,
      runTimestamp,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].price_used).toBe(1.0002);
    expect(rows[0].price_source).toBe("supply-history-daily");
    expect(rows[0].price_timestamp).toBe(dayTs);
    expect(rows[0].amount_usd).toBeCloseTo(1000.2, 1);
  });

  it("falls back to current price when historical price is null at runtime", () => {
    const dayTs = Math.floor(1700000000 / 86400) * 86400;
    const prices = new Map([["usdc-circle", 0.9998]]);
    // Simulate runtime drift: price is null despite the type saying number
    const priceHistory = new Map([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentional: simulates runtime schema drift
      ["usdc-circle", [{ snapshotDate: dayTs, price: null as any }]],
    ]);

    const { rows } = parseMintBurnLogs(
      config,
      mintEventDef,
      [makeTransferLog()],
      blockTimestamps,
      prices,
      priceHistory,
      runTimestamp,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].price_used).toBe(0.9998);
    expect(rows[0].price_source).toBe("price-cache-current");
    expect(rows[0].price_timestamp).toBe(runTimestamp);
    expect(rows[0].amount_usd).toBeCloseTo(999.8, 1);
  });
});
