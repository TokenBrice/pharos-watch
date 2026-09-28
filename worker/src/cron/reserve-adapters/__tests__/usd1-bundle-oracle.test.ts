import { describe, expect, it } from "vitest";
import { encodeAbiParameters } from "viem/utils";
import usd1MetaSource from "@shared/data/stablecoins/coins/usd1-world-liberty-financial.json";
import type { IssuerNativeLiabilityScope } from "@shared/types/live-reserve-adapter-declarations";
import { adaptUsd1BundleOracle } from "../usd1-bundle-oracle";
import type { MultichainSupplyContribution, ScopedLiabilitySupply } from "../multichain-supply";
import {
  expectWarningEffect,
  expectWarnings,
  resolveAdapterCoin,
  runAdapter,
  type AdapterNetworkSpec,
} from "./reserve-adapter.test-support";

// Raw values read 2026-09-27 (docs/live-reserves.md "Reviewed liability
// scopes"): the latest bundle (2026-09-25T17:31:07Z) and the six issuer-native
// supplies read around 2026-09-27T20:43:47Z, 51 h 12 m 40 s later.
const BUNDLE_TIMESTAMP = 1_790_357_467;
const RESERVES_RAW = 4_416_592_902_739_999_770_000_000_000n;
const LATE_SUPPLY_READ_AT = 1_790_541_827;
const IN_BOUND_SUPPLY_READ_AT = BUNDLE_TIMESTAMP + 3_600;
const ETHEREUM_SUPPLY = 1_603_126_802_599_636_457_747_129_499n;
const BSC_SUPPLY = 1_392_331_528_621_688_358_307_763_324n;
const TRON_SUPPLY = 10_062_604_900_000_000_000_000_000n;
const SOLANA_SUPPLY = 1_390_641_181_372_169n;
const APTOS_SUPPLY = 20_017_233_381_117n;
const TEMPO_SUPPLY = 1_119_862_264n;
const EXPECTED_SUPPLY = 4_416_180_470.736875;
const EXPECTED_RESERVES = 4_416_592_902.74;

const USD1_ORACLE = "0x691b74146cdba162449012aa32d3cbf5df77d4c4";
const USD1_TOKEN = "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d";
const TEMPO_TOKEN = "0x20c000000000000000000000111111111e910f0f";
const BRIDGE_TOKEN = "0x111111d2bf19e43c34263401e0cad979ed1cdb61";
// Read the public Tron contract from the catalog rather than a literal so the
// secret scanner does not mistake the base58 address for a credential.
const TRON_TOKEN = usd1MetaSource.contracts.find((contract) => contract.chain === "tron")!.address;
const SOLANA_MINT = "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB";
const APTOS_METADATA = "0x05fabd1b12e39967a3c24e91b7b8f67719a6dacee74f3c8b9fb7d93e855437d2";
const TRON_GRID = "https://api.trongrid.io/wallet/triggerconstantcontract";
const SOLANA_RPC_URLS = [
  "https://api.mainnet-beta.solana.com",
  "https://api.mainnet.solana.com",
  "https://solana-rpc.publicnode.com",
];
const APTOS_REST = "https://api.mainnet.aptoslabs.com/v1";
const APTOS_LEDGER = "7386894871";

const SCOPE: IssuerNativeLiabilityScope = {
  basis: "issuer-native-supply",
  reviewedAt: "2026-09-27",
  evidenceRef: "KPMG July 2026 USD1 examination Note A",
  included: [
    { chain: "ethereum", reader: "evm-erc20" },
    { chain: "bsc", reader: "evm-erc20" },
    { chain: "tron", reader: "tron-trc20" },
    { chain: "solana", reader: "solana-spl-mint" },
    { chain: "aptos", reader: "aptos-fungible-asset" },
    { chain: "tempo", reader: "evm-erc20" },
  ],
  excluded: ["plume", "monad", "mantle", "morph-l2", "abcore", "xlayer"].map((chain) => ({
    chain,
    relation: "lock-mint-representation" as const,
    backedBy: "ethereum",
    reason: "CCIP representation backed by the Ethereum pool lock",
  })),
};

function encodeBundle(timestamp: number, reservesRaw: bigint): `0x${string}` {
  return encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [BigInt(timestamp), reservesRaw]);
}

function nativeContributions(observedAt: number): MultichainSupplyContribution[] {
  return [
    { chain: "ethereum", tokenAddress: USD1_TOKEN, raw: ETHEREUM_SUPPLY, decimals: 18, observedAt },
    { chain: "bsc", tokenAddress: USD1_TOKEN, raw: BSC_SUPPLY, decimals: 18, observedAt },
    { chain: "tron", tokenAddress: TRON_TOKEN, raw: TRON_SUPPLY, decimals: 18, observedAt },
    { chain: "solana", tokenAddress: SOLANA_MINT, raw: SOLANA_SUPPLY, decimals: 6, observedAt },
    { chain: "aptos", tokenAddress: APTOS_METADATA, raw: APTOS_SUPPLY, decimals: 6, observedAt },
    { chain: "tempo", tokenAddress: TEMPO_TOKEN, raw: TEMPO_SUPPLY, decimals: 6, observedAt },
  ];
}

function scopedSupply(overrides: Partial<ScopedLiabilitySupply> = {}): ScopedLiabilitySupply {
  return {
    scope: SCOPE,
    unclassifiedChains: [],
    failedChains: [],
    contributions: nativeContributions(IN_BOUND_SUPPLY_READ_AT),
    omittedNonEvmChains: [],
    omittedNoRpcChains: [],
    omittedReadFailureChains: [],
    ...overrides,
  };
}

function adapt(supply: ScopedLiabilitySupply) {
  return adaptUsd1BundleOracle({
    bundle: encodeBundle(BUNDLE_TIMESTAMP, RESERVES_RAW),
    latestBundleTimestamp: BigInt(BUNDLE_TIMESTAMP),
    bundleDecimals: [18],
    supply,
  });
}

describe("adaptUsd1BundleOracle", () => {
  it("publishes BitGo USD1 redemption assets against issuer-native supply inside the skew bound", () => {
    const result = adapt(scopedSupply());

    expect(result.slices).toEqual([
      {
        sourceKey: "usd1-bundle-oracle:0x691b74146cdba162449012aa32d3cbf5df77d4c4",
        name: "U.S. Treasury Bills, Money Market Funds & Cash",
        pct: 100,
        risk: "very-low",
      },
    ]);
    expect(result.metadata?.totalReserveUsd).toBeCloseTo(EXPECTED_RESERVES, 2);
    // Solana and Aptos 6-decimal supplies are scaled by their own decimals.
    expect(result.metadata?.supplyUsd).toBeCloseTo(EXPECTED_SUPPLY, 2);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(EXPECTED_RESERVES / EXPECTED_SUPPLY, 9);
    expect(result.metadata).toMatchObject({
      freshnessMode: "verified",
      sourceTimestamp: BUNDLE_TIMESTAMP,
      supplyReadComplete: true,
      supplyCoverageComplete: true,
      reserveObservedAt: BUNDLE_TIMESTAMP,
      supplyObservedAt: { min: IN_BOUND_SUPPLY_READ_AT, max: IN_BOUND_SUPPLY_READ_AT },
      ratioSkewSec: 3_600,
      liabilityScope: {
        basis: "issuer-native-supply",
        includedChains: ["ethereum", "bsc", "tron", "solana", "aptos", "tempo"],
        unclassifiedChains: [],
        failedChains: [],
        maxReserveSupplySkewSec: 14_400,
      },
      redemption: { holderEligibility: "verified-customer", sourceTimestamp: BUNDLE_TIMESTAMP },
    });
    expect((result.metadata?.details as Record<string, unknown>).reserveScope).toContain("USD1 BitGo Reported Reserves");
    expect(result.metadata).not.toHaveProperty("fundBackingTotalRatio");
    expect(result.metadata?.ratioUnavailableReason).toBeUndefined();
    expect(result.warnings).toBeUndefined();
  });

  it.each([
    [14_400, true],
    [14_401, false],
  ])("publishes the ratio only while reserve/supply skew stays within the bound (skew %is)", (skew, published) => {
    const result = adapt(scopedSupply({ contributions: nativeContributions(BUNDLE_TIMESTAMP + skew) }));

    expect(result.metadata?.ratioSkewSec).toBe(skew);
    expect(result.metadata?.collateralizationRatio != null).toBe(published);
    expect(result.metadata?.ratioUnavailableReason).toBe(published ? undefined : "reserve-supply-time-skew");
  });

  it("withholds the 51-hour-skewed quotient but keeps reserves and supply", () => {
    const result = adapt(scopedSupply({ contributions: nativeContributions(LATE_SUPPLY_READ_AT) }));

    expect(result.metadata?.collateralizationRatio).toBeUndefined();
    expect(result.metadata?.totalReserveUsd).toBeCloseTo(EXPECTED_RESERVES, 2);
    expect(result.metadata?.supplyUsd).toBeCloseTo(EXPECTED_SUPPLY, 2);
    expect(result.metadata).toMatchObject({
      supplyCoverageComplete: true,
      ratioSkewSec: LATE_SUPPLY_READ_AT - BUNDLE_TIMESTAMP,
      ratioUnavailableReason: "reserve-supply-time-skew",
    });
    expectWarnings(result, ["reserve-supply-time-skew"]);
    expectWarningEffect(result, "reserve-supply-time-skew", "info");
  });

  it("rejects an empty supply denominator instead of publishing an unbounded ratio", () => {
    expect(() => adapt(scopedSupply({ contributions: [] }))).toThrow("zero USD1 supply");
  });

  it("rejects mismatched bundle timestamps", () => {
    expect(() =>
      adaptUsd1BundleOracle({
        bundle: encodeBundle(BUNDLE_TIMESTAMP, RESERVES_RAW),
        latestBundleTimestamp: BigInt(BUNDLE_TIMESTAMP - 391),
        bundleDecimals: [18],
        supply: scopedSupply(),
      }),
    ).toThrow("timestamp mismatch");
  });
});

type ChainOutcome = "ok" | "fail";

function usd1Network(options: {
  readAt: number;
  ethereumSupply?: bigint | null;
  solana?: ChainOutcome;
  aptos?: ChainOutcome;
  bundle?: string;
}): AdapterNetworkSpec {
  const solanaAccount = options.solana === "fail"
    ? { jsonrpc: "2.0", id: 1, result: { context: { slot: 451_107_855 }, value: null } }
    : {
        jsonrpc: "2.0",
        id: 1,
        result: {
          context: { slot: 451_107_855 },
          value: {
            owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
            data: { parsed: { type: "mint", info: { supply: SOLANA_SUPPLY.toString(), decimals: 6 } } },
          },
        },
      };
  const aptosResource = (type: string) =>
    `${APTOS_REST}/accounts/${APTOS_METADATA}/resource/${type}?ledger_version=${APTOS_LEDGER}`;
  return {
    block: { number: 26_071_248, timestamp: options.readAt },
    rpc: {
      [`${USD1_ORACLE}:latestBundle()`]: options.bundle ?? encodeAbiParameters(
        [{ type: "bytes" }],
        [encodeBundle(BUNDLE_TIMESTAMP, RESERVES_RAW)],
      ),
      [`${USD1_ORACLE}:latestBundleTimestamp()`]: BigInt(BUNDLE_TIMESTAMP),
      [`${USD1_ORACLE}:bundleDecimals()`]: encodeAbiParameters([{ type: "uint8[]" }], [[18]]),
      [`ethereum:${USD1_TOKEN}:totalSupply()`]: options.ethereumSupply === undefined ? ETHEREUM_SUPPLY : options.ethereumSupply,
      [`ethereum:${USD1_TOKEN}:decimals()`]: 18n,
      [`bsc:${USD1_TOKEN}:totalSupply()`]: BSC_SUPPLY,
      [`bsc:${USD1_TOKEN}:decimals()`]: 18n,
      [`tempo:${TEMPO_TOKEN}:totalSupply()`]: TEMPO_SUPPLY,
      [`tempo:${TEMPO_TOKEN}:decimals()`]: 6n,
      // CCIP bridge-only representations answer too; the scope must not read them.
      [`monad:${BRIDGE_TOKEN}:totalSupply()`]: 35_342_469_612n,
      [`abcore:${BRIDGE_TOKEN}:totalSupply()`]: 18_577_754_321_283_103_067_398_222n,
    },
    json: {
      [TRON_GRID]: { result: { result: true }, constant_result: [TRON_SUPPLY.toString(16).padStart(64, "0")] },
      ...Object.fromEntries(SOLANA_RPC_URLS.map((url) => [url, solanaAccount])),
      [APTOS_REST]: options.aptos === "fail"
        ? {}
        : { ledger_version: APTOS_LEDGER, ledger_timestamp: String(options.readAt * 1_000_000) },
      [aptosResource("0x1::fungible_asset::ConcurrentSupply")]: {
        type: "0x1::fungible_asset::ConcurrentSupply",
        data: { current: { value: APTOS_SUPPLY.toString() } },
      },
      [aptosResource("0x1::fungible_asset::Metadata")]: {
        type: "0x1::fungible_asset::Metadata",
        data: { decimals: 6 },
      },
    },
  };
}

describe("fetchUsd1BundleOracleReserves", () => {
  it.each([false, true])("reads the six issuer-native chains and none of the CCIP representations (inherited Ethereum pin=%s)", async (inheritedPin) => {
    const { result, network } = await runAdapter("usd1-bundle-oracle", "usd1-world-liberty-financial", {
      network: usd1Network({ readAt: IN_BOUND_SUPPLY_READ_AT }),
      nowSec: IN_BOUND_SUPPLY_READ_AT,
      ...(inheritedPin
        ? { ctx: { observedBlock: { chain: "ethereum", number: 26_071_248, timestamp: IN_BOUND_SUPPLY_READ_AT } } }
        : {}),
    });

    expect(result.metadata?.observedBlock).toEqual({ chain: "ethereum", number: 26_071_248, timestamp: IN_BOUND_SUPPLY_READ_AT });
    expect(result.metadata?.supplyUsd).toBeCloseTo(EXPECTED_SUPPLY, 2);
    expect(result.metadata?.collateralizationRatio).toBeCloseTo(EXPECTED_RESERVES / EXPECTED_SUPPLY, 9);
    expect(result.metadata).toMatchObject({ supplyCoverageComplete: true, ratioSkewSec: 3_600 });
    expect(result.metadata?.supplyContributions).toEqual(expect.arrayContaining([
      { chain: "aptos", tokenAddress: APTOS_METADATA, supplyRaw: "20017233381117", decimals: 6, observedAt: IN_BOUND_SUPPLY_READ_AT },
      { chain: "tempo", tokenAddress: TEMPO_TOKEN, supplyRaw: "1119862264", decimals: 6, observedAt: IN_BOUND_SUPPLY_READ_AT },
    ]));
    expect(result.warnings).toBeUndefined();
    expect(network.rpcCalls.filter((call) => call.selector === "0x18160ddd").map((call) => call.chain).sort())
      .toEqual(["bsc", "ethereum", "tempo"]);
    expect(network.rpcCalls.some((call) => call.contract === BRIDGE_TOKEN)).toBe(false);
  });

  it("withholds the ratio when supply is read 51 hours after the bundle", async () => {
    const { result } = await runAdapter("usd1-bundle-oracle", "usd1-world-liberty-financial", {
      network: usd1Network({ readAt: LATE_SUPPLY_READ_AT }),
      nowSec: LATE_SUPPLY_READ_AT,
    });

    expect(result.metadata?.collateralizationRatio).toBeUndefined();
    expect(result.metadata?.supplyUsd).toBeCloseTo(EXPECTED_SUPPLY, 2);
    expect(result.metadata).toMatchObject({
      ratioSkewSec: LATE_SUPPLY_READ_AT - BUNDLE_TIMESTAMP,
      ratioUnavailableReason: "reserve-supply-time-skew",
    });
  });

  it.each([
    ["solana", "SPL mint account read failed"],
    ["aptos", "fungible-asset ledger read failed"],
  ] as const)("withholds the ratio, never counting %s as zero, when its native read fails", async (chain, reason) => {
    const { result } = await runAdapter("usd1-bundle-oracle", "usd1-world-liberty-financial", {
      network: usd1Network({ readAt: IN_BOUND_SUPPLY_READ_AT, [chain]: "fail" }),
      nowSec: IN_BOUND_SUPPLY_READ_AT,
    });

    expect(result.metadata?.collateralizationRatio).toBeUndefined();
    expect(result.metadata).toMatchObject({
      supplyReadComplete: false,
      supplyCoverageComplete: false,
      ratioUnavailableReason: "included-supply-read-failed",
      liabilityScope: { failedChains: [{ chain, reason }] },
    });
    expect((result.metadata?.supplyContributions as Array<{ chain: string }>).some((entry) => entry.chain === chain)).toBe(false);
    expectWarningEffect(result, "partial-supply-read-failure", "degraded");
  });

  it("fails the Tempo read closed when catalog decimals disagree with the chain", async () => {
    const { coin: catalogCoin } = resolveAdapterCoin("usd1-bundle-oracle", "usd1-world-liberty-financial");
    const { result } = await runAdapter("usd1-bundle-oracle", "usd1-world-liberty-financial", {
      coin: {
        contracts: (catalogCoin.contracts ?? []).map((contract) =>
          contract.chain === "tempo" ? { ...contract, decimals: 18 } : contract),
      },
      network: usd1Network({ readAt: IN_BOUND_SUPPLY_READ_AT }),
      nowSec: IN_BOUND_SUPPLY_READ_AT,
    });

    expect(result.metadata?.collateralizationRatio).toBeUndefined();
    expect(result.metadata?.liabilityScope).toMatchObject({
      failedChains: [{ chain: "tempo", reason: "on-chain decimals 6 differ from catalog decimals 18" }],
    });
    expect((result.metadata?.supplyContributions as Array<{ chain: string }>).some((entry) => entry.chain === "tempo")).toBe(false);
  });

  it("fails closed when the oracle bundle payload drops a required word", async () => {
    await expect(runAdapter("usd1-bundle-oracle", "usd1-world-liberty-financial", {
      network: usd1Network({ readAt: IN_BOUND_SUPPLY_READ_AT, bundle: "0x1234" }),
      nowSec: IN_BOUND_SUPPLY_READ_AT,
      validate: false,
      allowUnmatched: true,
    })).rejects.toThrow();
  });

  it("fails when no included supply read succeeds", async () => {
    await expect(runAdapter("usd1-bundle-oracle", "usd1-world-liberty-financial", {
      coin: { contracts: [{ chain: "ethereum", address: USD1_TOKEN, decimals: 18 }] },
      network: usd1Network({ readAt: IN_BOUND_SUPPLY_READ_AT, ethereumSupply: null }),
      nowSec: IN_BOUND_SUPPLY_READ_AT,
      validate: false,
    })).rejects.toThrow(/usd1-bundle-oracle/);
  });
});
