import { afterEach, describe, it, expect, vi } from "vitest";
import { encodeAbiParameters } from "viem/utils";
import { parseEvmLogsWithCoverage } from "../evm-source";
import { CONTRACT_CONFIGS, type ContractEventConfig } from "../../../lib/blacklist-contracts";
import {
  createBudget,
  fetchEvmLogsForTopicWithCompleteness,
  type EtherscanLogEntry,
} from "../../../lib/evm-logs";

const ETH_CHAIN: ContractEventConfig["chain"] = { chainId: "ethereum", chainName: "Ethereum", evmChainId: 1, explorerUrl: "https://etherscan.io", type: "evm" };
const ethConfig = (
  stablecoinId: string,
  stablecoin: ContractEventConfig["stablecoin"],
  contractAddress: string,
  decimals: number,
  events: ContractEventConfig["events"],
): ContractEventConfig => ({ configKey: `ethereum-${contractAddress}`, chain: ETH_CHAIN, stablecoinId, stablecoin, contractAddress, decimals, events });

const USD1_CONFIG = ethConfig("usd1-world-liberty-financial", "USD1", "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d", 18, [
  { signature: "Freeze(address,address)", topicHash: "0x51d18786e9cb144f87d46e7b796309ea84c7c687d91e09c97f051eacf59bc528", eventType: "blacklist", hasAmount: false, addressTopicIndex: 2 },
]);
const USDC_CONFIG = ethConfig("usdc-circle", "USDC", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", 6, [
  { signature: "Blacklisted(address)", topicHash: "0xffa4e6181777692565cf28528fc88fd1516ea86b56da075235fa575af6a4b855", eventType: "blacklist", hasAmount: false },
]);
const RLUSD_CONFIG = ethConfig("rlusd-ripple", "RLUSD", "0x8292bb45bf1ee4d140127049757c2e0ff06317ed", 18, [
  { signature: "AccountPaused(address)", topicHash: "0xae7f60c1b8f645c3beffeb531169cbc446874bbf247698325318879ac850c346", eventType: "blacklist", hasAmount: false },
]);
const USDTB_CONFIG = ethConfig("usdtb-ethena", "USDTB", "0xc139190f447e929f090edeb554d95abb8b18ac1c", 18, [
  { signature: "AccountsBlocked(address[])", topicHash: "0x5444f9841c04ce78987f28701fa07fc4c112840c1c8439e8f52bda50c3788a87", eventType: "blacklist", hasAmount: false, addressArrayData: true },
]);
const A7A5_CONFIG = ethConfig("a7a5-old-vector", "A7A5", "0x6fa0be17e4bea2fcfa22ef89bf8ac9aab0ab0fc9", 6, [
  { signature: "DestroyedBlackFunds(address,uint256)", topicHash: "0x61e6e66b0d6339b2980aecc6ccc0039736791f0ccde9ed512e789a7fbdd698c6", eventType: "destroy", hasAmount: true },
]);
const BUIDL_CONFIG = ethConfig("buidl-blackrock", "BUIDL", "0x7712c34205737192402172409a8f7ccef8aa2aec", 6, [
  { signature: "OmnibusSeize(address,address,uint256,string,uint8)", topicHash: "0x5c719d01bb88860dfca685ad3818d8b61a083caaf8f68abe6fa0fba4e40e33a9", eventType: "destroy", hasAmount: true, addressDataIndex: 0, amountDataIndex: 1 },
]);

function makeEtherscanLog(blockNumber: number, index: number): EtherscanLogEntry {
  return {
    address: `0x${"1".repeat(40)}`,
    topics: [`0x${"a".repeat(64)}`],
    data: "0x",
    blockNumber: `0x${blockNumber.toString(16)}`,
    timeStamp: "0x65000000",
    transactionHash: `0x${index.toString(16).padStart(64, "0")}`,
    logIndex: `0x${index.toString(16)}`,
  };
}

describe("parseEvmLogs", () => {
  it.each(["incoming", "outgoing"] as const)("does not infer an amountless freeze quantity from a preceding same-block %s transfer", (direction) => {
    const affected = "0x" + "11".repeat(20);
    const other = "0x" + "22".repeat(20);
    const affectedTopic = "0x" + affected.slice(2).padStart(64, "0");
    const otherTopic = "0x" + other.slice(2).padStart(64, "0");
    const base = { ...makeEtherscanLog(100, 0), address: USDC_CONFIG.contractAddress };
    const rows = parseEvmLogsWithCoverage(USDC_CONFIG, [{
      ...base, topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        direction === "incoming" ? otherTopic : affectedTopic, direction === "incoming" ? affectedTopic : otherTopic],
      data: "0x" + (50_000000n).toString(16).padStart(64, "0"),
    }, {
      ...base, logIndex: "0x1", topics: [USDC_CONFIG.events[0].topicHash, affectedTopic], data: "0x",
    }]).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event_type: "blacklist", address: affected, amount_native: null,
      amount_source: "unavailable", amount_status: "recoverable_pending",
    });
  });

  it("extracts address from topics[2] when addressTopicIndex is 2 (USD1)", () => {
    const callerAddr = "0x0000000000000000000000001111111111111111111111111111111111111111";
    const frozenAddr = "0x0000000000000000000000002222222222222222222222222222222222222222";
    const rows = parseEvmLogsWithCoverage(USD1_CONFIG, [{
      ...makeEtherscanLog(0x1234, 0), address: USD1_CONFIG.contractAddress, transactionHash: "0x" + "ab".repeat(32),
      topics: [USD1_CONFIG.events[0]!.topicHash, callerAddr, frozenAddr],
    }]).rows;
    expect(rows).toHaveLength(1);
    expect([rows[0].address, rows[0].stablecoin, rows[0].event_type]).toEqual(["0x2222222222222222222222222222222222222222", "USD1", "blacklist"]);
  });

  it("extracts a non-indexed account address from RLUSD AccountPaused data", () => {
    const pausedAddr = "0x4444444444444444444444444444444444444444";
    const rows = parseEvmLogsWithCoverage(RLUSD_CONFIG, [{
      ...makeEtherscanLog(0x1234, 1), address: RLUSD_CONFIG.contractAddress, transactionHash: "0x" + "11".repeat(32),
      topics: [RLUSD_CONFIG.events[0]!.topicHash], data: encodeAbiParameters([{ type: "address" }], [pausedAddr]),
    }]).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stablecoin: "RLUSD", event_type: "blacklist", address: pausedAddr, amount_native: null });
  });

  it("expands USDTB dynamic address array events into unique rows", () => {
    const firstAddr = "0x5555555555555555555555555555555555555555";
    const secondAddr = "0x6666666666666666666666666666666666666666";
    const tx = "0x" + "22".repeat(32);
    const rows = parseEvmLogsWithCoverage(USDTB_CONFIG, [{
      ...makeEtherscanLog(0x1234, 2), address: USDTB_CONFIG.contractAddress, transactionHash: tx,
      topics: [USDTB_CONFIG.events[0]!.topicHash], data: encodeAbiParameters([{ type: "address[]" }], [[firstAddr, secondAddr]]),
    }]).rows;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.address)).toEqual([firstAddr, secondAddr]);
    expect(rows.map((r) => r.id)).toEqual([`ethereum-${tx}-0x2-0`, `ethereum-${tx}-0x2-1`]);
  });

  it("preserves every address in a batch larger than 500", () => {
    const addresses = Array.from({ length: 501 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}` as `0x${string}`);
    const tx = "0x" + "33".repeat(32);
    const rows = parseEvmLogsWithCoverage(USDTB_CONFIG, [{
      ...makeEtherscanLog(0x1234, 2), address: USDTB_CONFIG.contractAddress, transactionHash: tx,
      topics: [USDTB_CONFIG.events[0]!.topicHash], data: encodeAbiParameters([{ type: "address[]" }], [addresses]),
    }]).rows;
    expect(rows).toHaveLength(501);
    expect(rows[500]).toMatchObject({ id: `ethereum-${tx}-0x2-500`, address: addresses[500] });
  });

  it("extracts non-indexed A7A5 destroy address and emitted amount", () => {
    const destroyedAddr = "0x7777777777777777777777777777777777777777";
    const rows = parseEvmLogsWithCoverage(A7A5_CONFIG, [{
      ...makeEtherscanLog(0x1234, 3), address: A7A5_CONFIG.contractAddress, transactionHash: "0x" + "44".repeat(32),
      topics: [A7A5_CONFIG.events[0]!.topicHash], data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [destroyedAddr, 123_000_000n]),
    }]).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stablecoin: "A7A5", event_type: "destroy", address: destroyedAddr, amount_native: 123, amount_source: "event", amount_status: "resolved", amount_usd_at_event: null });
  });

  it("keeps rows recoverable when a configured amount data slot is missing", () => {
    const seizedAddr = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const rows = parseEvmLogsWithCoverage(BUIDL_CONFIG, [{
      ...makeEtherscanLog(0x1234, 6), address: BUIDL_CONFIG.contractAddress, transactionHash: "0x" + "77".repeat(32),
      topics: [BUIDL_CONFIG.events[0]!.topicHash, "0x000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
      data: encodeAbiParameters([{ type: "address" }], [seizedAddr]),
    }]).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ address: seizedAddr, amount_native: null, amount_usd_at_event: null, amount_source: "unavailable", amount_status: "recoverable_pending" });
  });

  it.each(["0x1234", "0x" + "ff".repeat(32)])("skips malformed scalar address data %s instead of creating a bogus 0x row", (data) => {
    const parsed = parseEvmLogsWithCoverage(USDC_CONFIG, [{
      ...makeEtherscanLog(0x1234, 7), address: USDC_CONFIG.contractAddress, transactionHash: "0x" + "88".repeat(32),
      topics: [USDC_CONFIG.events[0]!.topicHash], data,
    }]);
    expect([parsed.rows.length, parsed.coverageCeiling, parsed.failures[0].reason]).toEqual([0, 0x1233, "invalid-address"]);
  });

  it("quarantines a destroy log carrying only the amount word instead of decoding it as an address", () => {
    const usdtConfig = CONTRACT_CONFIGS.find(
      (candidate) => candidate.stablecoinId === "usdt-tether" && candidate.chain.chainId === "ethereum",
    )!;
    const destroyTopic = "0x61e6e66b0d6339b2980aecc6ccc0039736791f0ccde9ed512e789a7fbdd698c6";
    const parsed = parseEvmLogsWithCoverage(usdtConfig, [{
      address: usdtConfig.contractAddress,
      topics: [destroyTopic],
      data: "0x" + (5_000_000_000n).toString(16).padStart(64, "0"),
      blockNumber: "0x200",
      transactionHash: "0x" + "ab".repeat(32),
      logIndex: "0x0",
      timeStamp: "0x2000",
    }]);

    expect(parsed.rows).toEqual([]);
    expect(parsed.failures.map((failure) => failure.reason)).toEqual(["invalid-address"]);
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
    const rows = parseEvmLogsWithCoverage(config, [
      {
        address: config.contractAddress,
        topics: [seizeTopic, fromAddress, toAddress],
        data,
        blockNumber: "0x100",
        transactionHash: "0xdeadbeef".padEnd(66, "0"),
        logIndex: "0x0",
        timeStamp: "0x1000",
      },
    ]).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].amount_native).toBe(25);
    expect(rows[0].event_type).toBe("destroy");
  });

  it("decodes usdf-falcon AddressRestrictionSet, quarantines missing topic[1], and decodes usdgo-osl batch logs", () => {
    const usdf = CONTRACT_CONFIGS.find((c) => c.stablecoinId === "usdf-falcon")!;
    const usdgo = CONTRACT_CONFIGS.find((c) => c.stablecoinId === "usdgo-osl")!;
    const a1 = `0x${"1".repeat(40)}` as const;
    const a2 = `0x${"2".repeat(40)}` as const;
    const t0 = usdf.events[0]!.topicHash;
    const b = (v: boolean) => encodeAbiParameters([{ type: "bool" }], [v]);
    const ok = parseEvmLogsWithCoverage(usdf, [true, false].map((f, i) => (
      { ...makeEtherscanLog(21_818_200, i), topics: [t0, `0x${"0".repeat(24)}${a1.slice(2)}`], data: b(f) }
    )));
    expect([ok.failures, ok.rows.map((r) => [r.stablecoin, r.event_type, r.address])]).toEqual([[], [["USDF", "blacklist", a1], ["USDF", "unblacklist", a1]]]);

    const bad = parseEvmLogsWithCoverage(usdf, [{ ...makeEtherscanLog(21_818_201, 0), topics: [t0], data: b(true) }]);
    expect([bad.rows, bad.failures.map((f) => f.reason)]).toEqual([[], ["invalid-address"]]);

    const batch = parseEvmLogsWithCoverage(usdgo, [
      { ...makeEtherscanLog(26_000_500, 0), topics: [usdgo.events[0]!.topicHash], data: encodeAbiParameters([{ type: "address[]" }], [[a1, a2]]) },
    ]);
    expect([batch.failures, batch.rows.map((r) => [r.stablecoin, r.event_type, r.address])]).toEqual([[], [["USDGO", "blacklist", a1], ["USDGO", "blacklist", a2]]]);
  });
});

describe("fetchEvmLogsForTopicWithCompleteness", () => {
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

    const result = await fetchEvmLogsForTopicWithCompleteness(
      1,
      "0x123",
      "0xabc",
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
    const rows = parseEvmLogsWithCoverage(usd1Config, [
      {
        address: usd1Config.contractAddress,
        topics: [topic0, ("0x" + "0".repeat(24) + caller.slice(2)) as `0x${string}`, ("0x" + "0".repeat(24) + victim.slice(2)) as `0x${string}`],
        data,
        blockNumber: "0x100",
        transactionHash: "0xdeadbeef".padEnd(66, "0"),
        logIndex: "0x0",
        timeStamp: "0x1000",
      },
    ]).rows;
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
    const rows = parseEvmLogsWithCoverage(usd1Config, [
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
    ]).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe("destroy");
    expect(rows[0].address.toLowerCase()).toBe(from);
    expect(rows[0].amount_native).toBe(2);
  });
});

function makeBlacklistLog(overrides: Partial<EtherscanLogEntry> = {}): EtherscanLogEntry {
  return {
    ...makeEtherscanLog(256, 0),
    address: USDC_CONFIG.contractAddress,
    topics: [USDC_CONFIG.events[0]!.topicHash, "0x" + "0".repeat(24) + "aa".repeat(20)],
    ...overrides,
  };
}

describe("parseEvmLogs branch coverage", () => {
  it.each<[string, Partial<EtherscanLogEntry>]>([
    ["malformed blockNumber", { blockNumber: "0xzz" }],
    ["missing timestamp", { timeStamp: undefined }],
    ["unknown topic hash", { topics: ["0x" + "dd".repeat(32)] }],
  ])("skips logs with %s", (_name, overrides) => {
    expect(parseEvmLogsWithCoverage(USDC_CONFIG, [makeBlacklistLog()]).rows).toHaveLength(1);
    expect(parseEvmLogsWithCoverage(USDC_CONFIG, [makeBlacklistLog(overrides)]).rows).toEqual([]);
  });

  it("handles malformed address array data gracefully", () => {
    const parsed = parseEvmLogsWithCoverage(USDTB_CONFIG, [makeBlacklistLog({
      address: USDTB_CONFIG.contractAddress,
      topics: ["0x5444f9841c04ce78987f28701fa07fc4c112840c1c8439e8f52bda50c3788a87"],
      data: "0xdeadbeef",
    })]);
    expect(parsed.rows).toHaveLength(0);
    expect(parsed.coverageCeiling).not.toBeNull();
    expect(parsed.failures[0].reason).toBe("invalid-address-array");
  });


  it("admits a valid empty address array without a frontier fence", () => {
    const parsed = parseEvmLogsWithCoverage(USDTB_CONFIG, [makeBlacklistLog({
      address: USDTB_CONFIG.contractAddress,
      topics: [USDTB_CONFIG.events[0].topicHash],
      data: encodeAbiParameters([{ type: "address[]" }], [[]]),
    })]);
    expect(parsed.rows).toEqual([]);
    expect(parsed.coverageCeiling).toBeNull();
    expect(parsed.failures).toEqual([]);
  });

  it("decodes non-indexed address from data for USDT DestroyedBlackFunds", () => {
    const usdtConfig = CONTRACT_CONFIGS.find(
      (c) => c.stablecoinId === "usdt-tether" && c.chain.chainId === "ethereum",
    )!;
    const destroyTopic = "0x61e6e66b0d6339b2980aecc6ccc0039736791f0ccde9ed512e789a7fbdd698c6";
    const address = "0x" + "bb".repeat(20);
    const amount = encodeAbiParameters([{ type: "uint256" }], [5_000_000n]);
    const data = "0x" + "0".repeat(24) + address.slice(2) + amount.slice(2);
    const rows = parseEvmLogsWithCoverage(usdtConfig, [
      {
        address: usdtConfig.contractAddress,
        topics: [destroyTopic],
        data,
        blockNumber: "0x200",
        transactionHash: "0xcafebabe".padEnd(66, "0"),
        logIndex: "0x0",
        timeStamp: "0x2000",
      },
    ]).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe("destroy");
    expect(rows[0].amount_native).toBe(5);
  });
});
