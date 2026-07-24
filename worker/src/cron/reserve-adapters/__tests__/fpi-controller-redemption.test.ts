import type { LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import { describe, expect, it, vi } from "vitest";
import {
  decodeFunctionData,
  encodeFunctionResult,
  keccak256,
  parseAbi,
  type Hex,
} from "viem";
import type { EvmMulticall3Call, EvmMulticall3Result } from "../../../lib/evm-rpc";
import {
  observeFpiControllerRedemptionRoute,
  type FpiControllerRouteReadClient,
} from "../fpi-controller-redemption";

const CONTROLLER_ABI = parseAbi([
  "function FPI_TKN() view returns (address)",
  "function FRAX() view returns (address)",
  "function priceFeedFRAXUSD() view returns (address)",
  "function priceFeedFPIUSD() view returns (address)",
  "function cpiTracker() view returns (address)",
  "function chainlink_frax_usd_decimals() view returns (uint256)",
  "function chainlink_fpi_usd_decimals() view returns (uint256)",
  "function redeem_fee() view returns (uint256)",
  "function redeems_paused() view returns (bool)",
  "function peg_band_mint_redeem() view returns (uint256)",
  "function pegStatusMntRdm() view returns (uint256 cpiPegPrice, uint256 diffFracAbs, bool withinRange)",
  "function calcRedeemFPI(uint256 fpiIn, uint256 minFraxOut) view returns (uint256 fraxOut)",
  "function getFRAXPriceE18() view returns (uint256)",
  "function getFPIPriceE18() view returns (uint256)",
]);
const ERC20_ABI = parseAbi(["function balanceOf(address account) view returns (uint256)"]);
const PRICE_FEED_ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);
const CPI_TRACKER_ABI = parseAbi([
  "function currPegPrice() view returns (uint256)",
  "function lastUpdateTime() view returns (uint256)",
]);

const NOW = 1_790_000_000;
const BLOCK = 25_600_682;
const CONTROLLER_CODE = "0x6001600055" as Hex;
const FRAX_PRICE_FEED_CODE = "0x6002600055" as Hex;
const FPI_PRICE_FEED_CODE = "0x6003600055" as Hex;
const CPI_TRACKER_CODE = "0x6004600055" as Hex;
const CONTROLLER = "0x2397321b301b80a1c0911d6f9ed4b6033d43cf51";
const FPI = "0x5ca135cb8527d76e932f34b5145575f9d8cbe08e";
const FRAX = "0x853d955acef822db058eb8505911ed77f175b99e";
const FRAX_PRICE_FEED = "0xb9e1e3a9feff48998e45fa90847ed4d467e8bcfd";
const FPI_PRICE_FEED = "0x59985d79e1e69f659f4ab97db07a35ce73d9174b";
const CPI_TRACKER = "0x66b7dff2ac66dc4d6fbb3db1cb627bbb01ff3146";
const PEG = 1_157_936_071_624_911_625n;
const FPI_PRICE = 1_153_952_308_925_149_559n;
const FEE = 3_000n;
const PEG_DIFFERENCE = 3_452n;
const PEG_BAND = 50_000n;
const OUTPUT_PRICE = 988_398_750_000_000_000n;
const FRAX_FEED_ANSWER = 98_839_875n;
const FRAX_FEED_ROUND = 36_893_488_147_419_121_260n;
const FPI_FEED_ROUND = 0n;
const FRAX_FEED_UPDATED_AT = NOW - 120;
const FPI_FEED_UPDATED_AT = NOW - 30;
const CPI_TRACKER_UPDATED_AT = NOW - 90 * 86_400;
const BALANCE = 621_116_754_320_155_679_341_723n;
const SCALE = 10n ** 18n;
const FEE_SCALE = 1_000_000n;

type Params = LiveReserveAdapterParamsByKey["frax-fpi-collateral"];
type ResultOverrides = Partial<{
  fpiAddress: string;
  fraxAddress: string;
  fraxPriceFeedAddress: string;
  fpiPriceFeedAddress: string;
  cpiTrackerAddress: string;
  controllerFraxFeedDecimals: bigint;
  controllerFpiFeedDecimals: bigint;
  fraxFeedDecimals: number;
  fpiFeedDecimals: number;
  fraxFeedRound: readonly [bigint, bigint, bigint, bigint, bigint];
  fpiFeedRound: readonly [bigint, bigint, bigint, bigint, bigint];
  cpiTrackerPegPrice: bigint;
  cpiTrackerUpdatedAt: bigint;
  fee: bigint;
  paused: boolean;
  pegBand: bigint;
  pegStatus: readonly [bigint, bigint, boolean];
  unitQuote: bigint;
  outputPrice: bigint;
  fpiPrice: bigint;
  balance: bigint;
}>;

const params: Params = {
  controllerAddress: CONTROLLER,
  fpiTokenAddress: FPI,
  fraxTokenAddress: FRAX,
  expectedControllerCodeHash: keccak256(CONTROLLER_CODE),
  expectedFraxPriceFeedAddress: FRAX_PRICE_FEED,
  expectedFraxPriceFeedCodeHash: keccak256(FRAX_PRICE_FEED_CODE),
  expectedFraxPriceFeedDecimals: 8,
  expectedFpiPriceFeedAddress: FPI_PRICE_FEED,
  expectedFpiPriceFeedCodeHash: keccak256(FPI_PRICE_FEED_CODE),
  expectedFpiPriceFeedDecimals: 18,
  expectedCpiTrackerAddress: CPI_TRACKER,
  expectedCpiTrackerCodeHash: keccak256(CPI_TRACKER_CODE),
  maxPriceFeedAgeSec: 7_200,
  fullConfidenceCpiTrackerAgeSec: 62 * 86_400,
  maxCpiTrackerAgeSec: 366 * 86_400,
  expectedRedeemFeeE6: Number(FEE),
  outputTrackedAssetId: "frax-frax",
  minOutputPriceUsd: 0.98,
  maxOutputPriceUsd: 1.02,
  sourceUrls: [
    "https://docs.frax.finance/frax-price-index/fpi-controller-pool",
    "https://github.com/FraxFinance/frax-solidity/blob/master/src/hardhat/contracts/FPI/FPIControllerPool.sol",
  ],
  rpcUrl: "https://rpc.example",
};

function expectedOutput(input: bigint, peg = PEG, fee = FEE): bigint {
  const beforeFee = (input * peg) / SCALE;
  return beforeFee - (beforeFee * fee) / FEE_SCALE;
}

function encodedResults(calls: readonly EvmMulticall3Call[], overrides: ResultOverrides = {}): EvmMulticall3Result[] {
  const unitQuote = overrides.unitQuote ?? expectedOutput(SCALE);
  const values: Record<string, Hex> = {
    "controller-fpi-token": encodeFunctionResult({
      abi: CONTROLLER_ABI,
      functionName: "FPI_TKN",
      result: (overrides.fpiAddress ?? FPI) as Hex,
    }),
    "controller-frax-token": encodeFunctionResult({
      abi: CONTROLLER_ABI,
      functionName: "FRAX",
      result: (overrides.fraxAddress ?? FRAX) as Hex,
    }),
    "controller-frax-price-feed": encodeFunctionResult({
      abi: CONTROLLER_ABI,
      functionName: "priceFeedFRAXUSD",
      result: (overrides.fraxPriceFeedAddress ?? FRAX_PRICE_FEED) as Hex,
    }),
    "controller-fpi-price-feed": encodeFunctionResult({
      abi: CONTROLLER_ABI,
      functionName: "priceFeedFPIUSD",
      result: (overrides.fpiPriceFeedAddress ?? FPI_PRICE_FEED) as Hex,
    }),
    "controller-cpi-tracker": encodeFunctionResult({
      abi: CONTROLLER_ABI,
      functionName: "cpiTracker",
      result: (overrides.cpiTrackerAddress ?? CPI_TRACKER) as Hex,
    }),
    "controller-frax-feed-decimals": encodeFunctionResult({
      abi: CONTROLLER_ABI,
      functionName: "chainlink_frax_usd_decimals",
      result: overrides.controllerFraxFeedDecimals ?? 8n,
    }),
    "controller-fpi-feed-decimals": encodeFunctionResult({
      abi: CONTROLLER_ABI,
      functionName: "chainlink_fpi_usd_decimals",
      result: overrides.controllerFpiFeedDecimals ?? 18n,
    }),
    "controller-redeem-fee": encodeFunctionResult({
      abi: CONTROLLER_ABI,
      functionName: "redeem_fee",
      result: overrides.fee ?? FEE,
    }),
    "controller-redeems-paused": encodeFunctionResult({
      abi: CONTROLLER_ABI,
      functionName: "redeems_paused",
      result: overrides.paused ?? false,
    }),
    "controller-peg-band": encodeFunctionResult({
      abi: CONTROLLER_ABI,
      functionName: "peg_band_mint_redeem",
      result: overrides.pegBand ?? PEG_BAND,
    }),
    "controller-peg-status": encodeFunctionResult({
      abi: CONTROLLER_ABI,
      functionName: "pegStatusMntRdm",
      result: overrides.pegStatus ?? [PEG, PEG_DIFFERENCE, true],
    }),
    "controller-unit-redeem-quote": encodeFunctionResult({
      abi: CONTROLLER_ABI,
      functionName: "calcRedeemFPI",
      result: unitQuote,
    }),
    "controller-frax-price": encodeFunctionResult({
      abi: CONTROLLER_ABI,
      functionName: "getFRAXPriceE18",
      result: overrides.outputPrice ?? OUTPUT_PRICE,
    }),
    "controller-fpi-price": encodeFunctionResult({
      abi: CONTROLLER_ABI,
      functionName: "getFPIPriceE18",
      result: overrides.fpiPrice ?? FPI_PRICE,
    }),
    "frax-price-feed-decimals": encodeFunctionResult({
      abi: PRICE_FEED_ABI,
      functionName: "decimals",
      result: overrides.fraxFeedDecimals ?? 8,
    }),
    "frax-price-feed-round": encodeFunctionResult({
      abi: PRICE_FEED_ABI,
      functionName: "latestRoundData",
      result:
        overrides.fraxFeedRound ??
        [
          FRAX_FEED_ROUND,
          FRAX_FEED_ANSWER,
          BigInt(FRAX_FEED_UPDATED_AT),
          BigInt(FRAX_FEED_UPDATED_AT),
          FRAX_FEED_ROUND,
        ],
    }),
    "fpi-price-feed-decimals": encodeFunctionResult({
      abi: PRICE_FEED_ABI,
      functionName: "decimals",
      result: overrides.fpiFeedDecimals ?? 18,
    }),
    "fpi-price-feed-round": encodeFunctionResult({
      abi: PRICE_FEED_ABI,
      functionName: "latestRoundData",
      result:
        overrides.fpiFeedRound ??
        [
          FPI_FEED_ROUND,
          FPI_PRICE,
          0n,
          BigInt(FPI_FEED_UPDATED_AT),
          FPI_FEED_ROUND,
        ],
    }),
    "cpi-tracker-peg-price": encodeFunctionResult({
      abi: CPI_TRACKER_ABI,
      functionName: "currPegPrice",
      result: overrides.cpiTrackerPegPrice ?? PEG,
    }),
    "cpi-tracker-updated-at": encodeFunctionResult({
      abi: CPI_TRACKER_ABI,
      functionName: "lastUpdateTime",
      result: overrides.cpiTrackerUpdatedAt ?? BigInt(CPI_TRACKER_UPDATED_AT),
    }),
    "controller-frax-balance": encodeFunctionResult({
      abi: ERC20_ABI,
      functionName: "balanceOf",
      result: overrides.balance ?? BALANCE,
    }),
  };
  return calls.map((call) => ({
    label: call.label,
    success: true,
    returnData: values[call.label] ?? "0x",
  }));
}

function client(args: {
  controllerCode?: Hex | null;
  dependencyCodeOverrides?: Partial<Record<string, Hex | null>>;
  blockTimestamp?: number | null;
  results?: ResultOverrides | null;
  capacityQuoteDelta?: bigint;
} = {}): FpiControllerRouteReadClient {
  return {
    blockNumber: vi.fn().mockResolvedValue(BLOCK),
    blockTimestamp: vi.fn().mockResolvedValue(args.blockTimestamp === undefined ? NOW - 30 : args.blockTimestamp),
    code: vi.fn().mockImplementation((address: string) => {
      const normalized = address.toLowerCase();
      if (normalized === CONTROLLER) {
        return Promise.resolve(
          args.controllerCode === undefined ? CONTROLLER_CODE : args.controllerCode,
        );
      }
      const defaultCodes: Record<string, Hex> = {
        [FRAX_PRICE_FEED]: FRAX_PRICE_FEED_CODE,
        [FPI_PRICE_FEED]: FPI_PRICE_FEED_CODE,
        [CPI_TRACKER]: CPI_TRACKER_CODE,
      };
      return Promise.resolve(
        Object.prototype.hasOwnProperty.call(args.dependencyCodeOverrides ?? {}, normalized)
          ? args.dependencyCodeOverrides?.[normalized] ?? null
          : defaultCodes[normalized] ?? null,
      );
    }),
    multicall: vi.fn().mockImplementation((calls: readonly EvmMulticall3Call[]) =>
      Promise.resolve(args.results === null ? null : encodedResults(calls, args.results)),
    ),
    call: vi.fn().mockImplementation((_address: string, data: string) => {
      const decoded = decodeFunctionData({ abi: CONTROLLER_ABI, data: data as Hex });
      const input = decoded.args?.[0] as bigint;
      return Promise.resolve(
        encodeFunctionResult({
          abi: CONTROLLER_ABI,
          functionName: "calcRedeemFPI",
          result: expectedOutput(input) + (args.capacityQuoteDelta ?? 0n),
        }),
      );
    }),
  };
}

describe("observeFpiControllerRedemptionRoute", () => {
  it("accepts one internally consistent controller state pinned to one block", async () => {
    const readClient = client();
    const attempt = await observeFpiControllerRedemptionRoute(
      params,
      new AbortController().signal,
      undefined,
      { attemptedAtSec: NOW, client: readClient },
    );

    expect(attempt).toMatchObject({
      status: "accepted",
      attemptedAtSec: NOW,
      state: {
        kind: "fpi-controller-v1",
        chain: "ethereum",
        controllerAddress: CONTROLLER,
        controllerCodeHash: params.expectedControllerCodeHash,
        blockNumber: BLOCK,
        blockTimestamp: NOW - 30,
        inputTokenAddress: FPI,
        outputTokenAddress: FRAX,
        outputTrackedAssetId: "frax-frax",
        fraxPriceFeedAddress: FRAX_PRICE_FEED,
        fraxPriceFeedCodeHash: params.expectedFraxPriceFeedCodeHash,
        fraxPriceFeedRoundId: FRAX_FEED_ROUND.toString(),
        fraxPriceFeedUpdatedAt: FRAX_FEED_UPDATED_AT,
        fpiPriceFeedAddress: FPI_PRICE_FEED,
        fpiPriceFeedCodeHash: params.expectedFpiPriceFeedCodeHash,
        fpiPriceFeedRoundId: FPI_FEED_ROUND.toString(),
        fpiPriceFeedUpdatedAt: FPI_FEED_UPDATED_AT,
        cpiTrackerAddress: CPI_TRACKER,
        cpiTrackerCodeHash: params.expectedCpiTrackerCodeHash,
        cpiTrackerUpdatedAt: CPI_TRACKER_UPDATED_AT,
        cpiTrackerFreshness: "stale-bounded",
        modelConfidence: "medium",
        feeBps: 30,
        pegDifferenceBps: 34.52,
        pegBandBps: 500,
        outputPriceUsd: 0.98839875,
      },
    });
    expect(attempt.status === "accepted" && attempt.state.capacityUsd).toBeGreaterThan(600_000);
    expect(attempt.status === "accepted" && attempt.state.allInCostBps).toBeCloseTo(
      (1 - 0.997 * 0.98839875) * 10_000,
      6,
    );
    expect(readClient.blockTimestamp).toHaveBeenCalledWith(BLOCK, expect.any(Object));
    expect(readClient.code).toHaveBeenCalledWith(CONTROLLER, BLOCK, expect.any(Object));
    expect(readClient.multicall).toHaveBeenCalledWith(expect.any(Array), BLOCK, expect.any(Object));
    expect(readClient.call).toHaveBeenCalledWith(CONTROLLER, expect.any(String), BLOCK, expect.any(Object));
  });

  it.each([
    ["interface-identity-mismatch", { fpiAddress: "0x0000000000000000000000000000000000000001" }],
    ["oracle-identity-mismatch", { fraxPriceFeedAddress: "0x0000000000000000000000000000000000000001" }],
    ["fee-drift", { fee: 3_001n }],
    ["redemption-paused", { paused: true }],
    ["peg-band-invalid", { pegBand: 3_000n, pegStatus: [PEG, PEG_DIFFERENCE, false] as const }],
    ["calculation-mismatch", { unitQuote: expectedOutput(SCALE) - 1n }],
    [
      "output-price-invalid",
      {
        outputPrice: 970_000_000_000_000_000n,
        fraxFeedRound: [
          FRAX_FEED_ROUND,
          97_000_000n,
          BigInt(FRAX_FEED_UPDATED_AT),
          BigInt(FRAX_FEED_UPDATED_AT),
          FRAX_FEED_ROUND,
        ] as const,
      },
    ],
    [
      "all-in-cost-exceeds-request",
      {
        outputPrice: 981_000_000_000_000_000n,
        fraxFeedRound: [
          FRAX_FEED_ROUND,
          98_100_000n,
          BigInt(FRAX_FEED_UPDATED_AT),
          BigInt(FRAX_FEED_UPDATED_AT),
          FRAX_FEED_ROUND,
        ] as const,
      },
    ],
  ] as const)("rejects %s state drift", async (rejectionCode, results) => {
    const attempt = await observeFpiControllerRedemptionRoute(
      params,
      new AbortController().signal,
      undefined,
      { attemptedAtSec: NOW, client: client({ results }) },
    );

    expect(attempt).toMatchObject({ status: "rejected", rejectionCode, blockNumber: BLOCK });
  });

  it("rejects controller bytecode drift", async () => {
    const attempt = await observeFpiControllerRedemptionRoute(
      params,
      new AbortController().signal,
      undefined,
      { attemptedAtSec: NOW, client: client({ controllerCode: "0x6002" }) },
    );
    expect(attempt).toMatchObject({
      status: "rejected",
      rejectionCode: "controller-code-drift",
      blockNumber: BLOCK,
    });
  });

  it("rejects dependency bytecode drift", async () => {
    const attempt = await observeFpiControllerRedemptionRoute(
      params,
      new AbortController().signal,
      undefined,
      {
        attemptedAtSec: NOW,
        client: client({
          dependencyCodeOverrides: { [FRAX_PRICE_FEED]: "0x6005" },
        }),
      },
    );
    expect(attempt).toMatchObject({
      status: "rejected",
      rejectionCode: "dependency-code-drift",
      blockNumber: BLOCK,
    });
  });

  it.each([
    [
      "oracle-round-invalid",
      {
        fraxFeedRound: [
          FRAX_FEED_ROUND,
          FRAX_FEED_ANSWER,
          BigInt(FRAX_FEED_UPDATED_AT),
          BigInt(FRAX_FEED_UPDATED_AT),
          FRAX_FEED_ROUND - 1n,
        ] as const,
      },
    ],
    [
      "oracle-stale",
      {
        fraxFeedRound: [
          FRAX_FEED_ROUND,
          FRAX_FEED_ANSWER,
          BigInt(NOW - 7_300),
          BigInt(NOW - 7_300),
          FRAX_FEED_ROUND,
        ] as const,
      },
    ],
    ["controller-oracle-disagreement", { outputPrice: OUTPUT_PRICE - 1n }],
    ["cpi-tracker-stale", { cpiTrackerUpdatedAt: BigInt(NOW - 367 * 86_400) }],
  ] as const)("rejects %s oracle evidence", async (rejectionCode, results) => {
    const attempt = await observeFpiControllerRedemptionRoute(
      params,
      new AbortController().signal,
      undefined,
      { attemptedAtSec: NOW, client: client({ results }) },
    );

    expect(attempt).toMatchObject({ status: "rejected", rejectionCode, blockNumber: BLOCK });
  });

  it("retains high model confidence only for a current CPI tracker update", async () => {
    const attempt = await observeFpiControllerRedemptionRoute(
      params,
      new AbortController().signal,
      undefined,
      {
        attemptedAtSec: NOW,
        client: client({
          results: { cpiTrackerUpdatedAt: BigInt(NOW - 30 * 86_400) },
        }),
      },
    );

    expect(attempt).toMatchObject({
      status: "accepted",
      state: {
        cpiTrackerFreshness: "current",
        modelConfidence: "high",
      },
    });
  });

  it("rejects stale blocks and capacity-quote disagreement", async () => {
    const stale = await observeFpiControllerRedemptionRoute(
      params,
      new AbortController().signal,
      undefined,
      { attemptedAtSec: NOW, client: client({ blockTimestamp: NOW - 301 }) },
    );
    const mismatched = await observeFpiControllerRedemptionRoute(
      params,
      new AbortController().signal,
      undefined,
      { attemptedAtSec: NOW, client: client({ capacityQuoteDelta: 1n }) },
    );

    expect(stale).toMatchObject({ status: "rejected", rejectionCode: "block-time-out-of-range" });
    expect(mismatched).toMatchObject({ status: "rejected", rejectionCode: "capacity-mismatch" });
  });

  it("fails closed when controller state is unavailable", async () => {
    const attempt = await observeFpiControllerRedemptionRoute(
      params,
      new AbortController().signal,
      undefined,
      { attemptedAtSec: NOW, client: client({ results: null }) },
    );
    expect(attempt).toMatchObject({
      status: "rejected",
      rejectionCode: "controller-state-unavailable",
      blockNumber: BLOCK,
    });
  });
});
