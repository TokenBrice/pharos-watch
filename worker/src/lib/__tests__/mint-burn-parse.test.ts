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
  const blockTimestamps = new Map([[21_889_025, 1700000000]]);
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

  // --- reUSD custom event parsing ---

  const REUSD_DEPOSITED_TOPIC = "0x8752a472e571a816aea92eec8dae9baf628e840f4929fbcc2d155e6233ff68a7";
  const REUSD_INSTANT_REDEEM_TOPIC = "0xa58dba63852b106a5b3bbc558fa3fbcfe606497cbc0af66837a83c3560ec6220";

  const reusdDepositEventDef: MintBurnEventDef = {
    signature: "Deposited(address,address,uint256)",
    topicHash: REUSD_DEPOSITED_TOPIC,
    direction: "mint" as const,
    amountEncoding: "nth-data-uint256" as const,
    dataSlot: 2,
  };

  const reusdRedeemEventDef: MintBurnEventDef = {
    signature: "InstantRedemptionProcessed(address,uint256,uint256)",
    topicHash: REUSD_INSTANT_REDEEM_TOPIC,
    direction: "burn" as const,
    amountEncoding: "first-data-uint256" as const,
  };

  // 50,000 reUSD (18 decimals) = 50_000 * 10^18
  const DEPOSITOR_SLOT = "0000000000000000000000001111111111111111111111111111111111111111";
  const RECEIVER_SLOT  = "0000000000000000000000002222222222222222222222222222222222222222";
  const AMOUNT_50K_18DEC = BigInt("50000000000000000000000").toString(16).padStart(64, "0");
  const REUSD_DEPOSIT_DATA = "0x" + DEPOSITOR_SLOT + RECEIVER_SLOT + AMOUNT_50K_18DEC;

  const REUSD_VAULT_ADDRESS = "0x4691c475be804fa85f91c2d6d0adf03114de3093";

  const makeReusdConfig = (eventDef: MintBurnEventDef, address: string): MintBurnContractConfig => ({
    stablecoinId: "reusd-re-protocol",
    symbol: "reUSD",
    chain: ETHEREUM_CHAIN,
    contractAddress: address,
    decimals: 18,
    dustThreshold: 10_000,
    startBlock: 21_675_000,
    adapterKind: "custom-events",
    startBlockSource: "reviewed-contract-specific",
    startBlockConfidence: "high",
    tier: "extended",
    events: [eventDef],
  });

  it("parses reUSD Deposited event with dataSlot=2 as mint", () => {
    const config = makeReusdConfig(reusdDepositEventDef, REUSD_VAULT_ADDRESS);
    const log: AlchemyLogEntry = {
      address: REUSD_VAULT_ADDRESS,
      topics: [REUSD_DEPOSITED_TOPIC],
      data: REUSD_DEPOSIT_DATA,
      blockNumber: "0x14e0001",
      logIndex: "0x3",
      transactionHash: "0xreusd10000000000000000000000000000000000000000000000000000000001",
      blockHash: "0x0",
      transactionIndex: "0x0",
      removed: false,
    };

    const { rows, dropped } = parseMintBurnLogs(
      config,
      reusdDepositEventDef,
      [log],
      blockTimestamps,
      new Map([["reusd-re-protocol", 1.0]]),
      priceHistory,
      runTimestamp,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].direction).toBe("mint");
    expect(rows[0].amount).toBe(50_000);
    expect(rows[0].amount_usd).toBe(50_000);
    expect(rows[0].stablecoin_id).toBe("reusd-re-protocol");
    expect(dropped).toBe(0);
  });

  it("parses reUSD InstantRedemptionProcessed as burn from slot 0", () => {
    const REDEEM_VAULT = "0x8aeb9453ef22cb38abc7a3af9c208f65c1bfe31e";
    const config = makeReusdConfig(reusdRedeemEventDef, REDEEM_VAULT);

    const SHARES_25K = BigInt("25000000000000000000000").toString(16).padStart(64, "0");
    const PAYOUT_SLOT = "0".repeat(64);
    const redeemData = "0x" + SHARES_25K + PAYOUT_SLOT;

    const log: AlchemyLogEntry = {
      address: REDEEM_VAULT,
      topics: [REUSD_INSTANT_REDEEM_TOPIC],
      data: redeemData,
      blockNumber: "0x14e0001",
      logIndex: "0x7",
      transactionHash: "0xreusd20000000000000000000000000000000000000000000000000000000002",
      blockHash: "0x0",
      transactionIndex: "0x0",
      removed: false,
    };

    const { rows, dropped } = parseMintBurnLogs(
      config,
      reusdRedeemEventDef,
      [log],
      blockTimestamps,
      new Map([["reusd-re-protocol", 1.0]]),
      priceHistory,
      runTimestamp,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].direction).toBe("burn");
    expect(rows[0].amount).toBe(25_000);
    expect(rows[0].burn_type).toBe("effective_burn");
    expect(dropped).toBe(0);
  });

  it("drops event when dataSlot points beyond available data", () => {
    const config = makeReusdConfig(reusdDepositEventDef, REUSD_VAULT_ADDRESS);
    // Only 2 slots of data (128 hex chars) — slot 2 is missing
    const shortData = "0x" + DEPOSITOR_SLOT + RECEIVER_SLOT;
    const log: AlchemyLogEntry = {
      address: REUSD_VAULT_ADDRESS,
      topics: [REUSD_DEPOSITED_TOPIC],
      data: shortData,
      blockNumber: "0x14e0001",
      logIndex: "0x4",
      transactionHash: "0xreusd30000000000000000000000000000000000000000000000000000000003",
      blockHash: "0x0",
      transactionIndex: "0x0",
      removed: false,
    };

    const { rows, dropped } = parseMintBurnLogs(
      config,
      reusdDepositEventDef,
      [log],
      blockTimestamps,
      new Map([["reusd-re-protocol", 1.0]]),
      priceHistory,
      runTimestamp,
    );

    expect(rows).toHaveLength(0);
    expect(dropped).toBe(1);
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
