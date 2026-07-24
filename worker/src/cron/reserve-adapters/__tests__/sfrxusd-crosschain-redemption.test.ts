import sfrxusd from "@shared/data/stablecoins/coins/sfrxusd-frax.json";
import {
  parseLiveReserveAdapterParams,
  type LiveReserveAdapterParamsByKey,
} from "@shared/lib/live-reserve-adapters";
import { getRedemptionBackstopConfig } from "@shared/lib/redemption-backstops";
import { describe, expect, it, vi } from "vitest";
import {
  encodeFunctionResult,
  keccak256,
  parseAbi,
} from "viem/utils";
import type {
  EvmMulticall3Call,
  EvmMulticall3Result,
} from "../../../lib/evm-rpc";
import {
  observeSfrxusdCrosschainRedemptionRoute,
  type SfrxusdCrosschainRouteReadClient,
} from "../sfrxusd-crosschain-redemption";
import { buildSfrxusdCrosschainV9ExitRouteObservation } from "../../../lib/sfrxusd-crosschain-redemption-route";
import { readRedemptionBackstopLiveMetadata } from "../../../lib/redemption-backstop-live-metadata";
import { buildRedemptionBackstopEntry } from "../../../lib/redemption-backstop-sources";

const ABI = parseAbi([
  "function paused() view returns (bool)",
  "function fraxtalHop() view returns (bytes32)",
  "function EID() view returns (uint32)",
  "function frxUsdOft() view returns (address)",
  "function sfrxUsdOft() view returns (address)",
  "function quoteHop() view returns (uint256)",
  "function quote(address oft,bytes32 to,uint256 amount) view returns ((uint256 nativeFee,uint256 lzTokenFee))",
  "function quote(address oft,uint32 dstEid,bytes32 to,uint256 amount) view returns ((uint256 nativeFee,uint256 lzTokenFee))",
  "function token() view returns (address)",
  "function decimalConversionRate() view returns (uint256)",
  "function asset() view returns (address)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function aggregator() view returns (address)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  "function fraxtalERC4626MintRedeemer() view returns (address)",
  "function frxUsdLockbox() view returns (address)",
  "function sfrxUsdLockbox() view returns (address)",
  "function remoteHop(uint32 eid) view returns (bytes32)",
  "function underlyingTkn() view returns (address)",
  "function vaultTkn() view returns (address)",
  "function priceFeedUnderlying() view returns (address)",
  "function priceFeedVault() view returns (address)",
  "function fee() view returns (uint256)",
  "function oracleTimeTolerance() view returns (uint256)",
  "function lastVaultTknOracleRead() view returns (uint256)",
  "function getLatestUnderlyingPriceE18() view returns (int256)",
  "function getLatestVaultTknPriceE18() view returns (int256)",
  "function getVaultTknPriceStoredE18() view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function mdwrComboView() view returns (uint256,uint256,uint256,uint256)",
  "function previewRedeem(uint256 shares) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function getEthBalance(address account) view returns (uint256)",
]);

type Erc4626Params = LiveReserveAdapterParamsByKey["erc4626-single-asset"];
type Hex = `0x${string}`;
type Params = Extract<
  NonNullable<Erc4626Params["redemptionLiquidity"]>,
  { source: "fraxtal-hop-withdrawable" }
>;

const NOW = 1_790_000_000;
const ETHEREUM_BLOCK = 25_700_000;
const FRAXTAL_BLOCK = 39_000_000;
const E18 = 10n ** 18n;
const CONVERSION_RATE = 10n ** 12n;
const ETHEREUM_SUPPLY = 2_000_000n * E18;
const MAX_REDEEM_SHARES = 1_500_000n * E18;
const INVENTORY = 1_800_000n * E18;
const PRICE = 1_200_000_000_000_000_000n;
const FEE_RAW = 100_000_000_000n;
const REMOTE_SERVICE_FEE = 400_000_000_000_000n;
const USER_NATIVE_FEE = 500_000_000_000_000n;
const RETURN_NATIVE_FEE = 1n * E18;
const HOP_NATIVE_BALANCE = 10n * E18;
const ETH_USD_E8 = 200_000_000_000n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const SFRXUSD = "0xcf62f905562626cfcdd2261162a51fd02fc9c5b6";
const CODE = "0x6001600055" as Hex;
const DRIFT_CODE = "0x6002600055" as Hex;
const CODE_HASH = keccak256(CODE);

const parsed = parseLiveReserveAdapterParams(
  "erc4626-single-asset",
  sfrxusd.liveReservesConfig.params,
);
if (parsed.redemptionLiquidity?.source !== "fraxtal-hop-withdrawable") {
  throw new Error("sfrxUSD production config must use the Fraxtal hop observer");
}
const params: Params = {
  ...parsed.redemptionLiquidity,
  expectedRemoteHopCodeHash: CODE_HASH,
  expectedEthereumSfrxUsdProxyCodeHash: CODE_HASH,
  expectedEthereumSfrxUsdImplementationCodeHash: CODE_HASH,
  expectedEthereumFrxUsdOftProxyCodeHash: CODE_HASH,
  expectedEthereumFrxUsdOftImplementationCodeHash: CODE_HASH,
  expectedEthereumSfrxUsdOftProxyCodeHash: CODE_HASH,
  expectedEthereumSfrxUsdOftImplementationCodeHash: CODE_HASH,
  expectedEthUsdFeedCodeHash: CODE_HASH,
  expectedEthUsdAggregatorCodeHash: CODE_HASH,
  expectedFraxtalHopCodeHash: CODE_HASH,
  expectedMintRedeemerProxyCodeHash: CODE_HASH,
  expectedMintRedeemerImplementationCodeHash: CODE_HASH,
  expectedFrxUsdLockboxProxyCodeHash: CODE_HASH,
  expectedFrxUsdLockboxImplementationCodeHash: CODE_HASH,
  expectedSfrxUsdLockboxProxyCodeHash: CODE_HASH,
  expectedSfrxUsdLockboxImplementationCodeHash: CODE_HASH,
  expectedVaultOracleCodeHash: CODE_HASH,
};

function asBytes32(address: string): Hex {
  return `0x${address.slice(2).padStart(64, "0")}`;
}

function previewRedeem(shares: bigint, feeRaw = FEE_RAW): bigint {
  return (((shares * PRICE) / E18) * (E18 - feeRaw)) / E18;
}

interface StateOverrides {
  remotePaused?: boolean;
  fraxtalPaused?: boolean;
  remoteEid?: number;
  ethereumSfrxAsset?: string;
  ethereumSfrxDecimals?: number;
  ethAggregator?: string;
  ethUpdatedAt?: bigint;
  feeRaw?: bigint;
  vaultUpdatedAt?: bigint;
  lastOracleRead?: bigint;
  totalAssets?: bigint;
  underlyingBalance?: bigint;
  mdwr?: readonly [bigint, bigint, bigint, bigint];
  quoteLzTokenFee?: bigint;
  hopNativeBalance?: bigint;
}

function valueForLabel(
  label: string,
  overrides: StateOverrides,
): Hex {
  const feeRaw = overrides.feeRaw ?? FEE_RAW;
  if (label.startsWith("ethereum-quote:")) {
    return encodeFunctionResult({
      abi: ABI,
      functionName: "quote",
      result: {
        nativeFee: USER_NATIVE_FEE,
        lzTokenFee: overrides.quoteLzTokenFee ?? 0n,
      },
    });
  }
  if (label.startsWith("fraxtal-return-quote:")) {
    return encodeFunctionResult({
      abi: ABI,
      functionName: "quote",
      result: {
        nativeFee: RETURN_NATIVE_FEE,
        lzTokenFee: overrides.quoteLzTokenFee ?? 0n,
      },
    });
  }
  if (label.startsWith("preview:")) {
    const index = Number(label.split(":")[1]);
    const request = [100_000n, 1_000_000n, 5_000_000n, 25_000_000n][index];
    const shares = (request * E18 * E18 + PRICE - 1n) / PRICE;
    return encodeFunctionResult({
      abi: ABI,
      functionName: "previewRedeem",
      result: previewRedeem(shares, feeRaw),
    });
  }
  const values: Record<string, Hex> = {
    "remote-paused": encodeFunctionResult({
      abi: ABI,
      functionName: "paused",
      result: overrides.remotePaused ?? false,
    }),
    "remote-fraxtal-hop": encodeFunctionResult({
      abi: ABI,
      functionName: "fraxtalHop",
      result: asBytes32(params.expectedFraxtalHopAddress),
    }),
    "remote-eid": encodeFunctionResult({
      abi: ABI,
      functionName: "EID",
      result: overrides.remoteEid ?? params.expectedEthereumEid,
    }),
    "remote-frx-oft": encodeFunctionResult({
      abi: ABI,
      functionName: "frxUsdOft",
      result: params.expectedEthereumFrxUsdOftAddress as Hex,
    }),
    "remote-sfrx-oft": encodeFunctionResult({
      abi: ABI,
      functionName: "sfrxUsdOft",
      result: params.expectedEthereumSfrxUsdOftAddress as Hex,
    }),
    "remote-service-fee": encodeFunctionResult({
      abi: ABI,
      functionName: "quoteHop",
      result: REMOTE_SERVICE_FEE,
    }),
    "frx-oft-token": encodeFunctionResult({
      abi: ABI,
      functionName: "token",
      result: params.expectedEthereumFrxUsdAddress as Hex,
    }),
    "frx-oft-conversion-rate": encodeFunctionResult({
      abi: ABI,
      functionName: "decimalConversionRate",
      result: CONVERSION_RATE,
    }),
    "sfrx-oft-token": encodeFunctionResult({
      abi: ABI,
      functionName: "token",
      result: SFRXUSD,
    }),
    "sfrx-oft-conversion-rate": encodeFunctionResult({
      abi: ABI,
      functionName: "decimalConversionRate",
      result: CONVERSION_RATE,
    }),
    "ethereum-frx-decimals": encodeFunctionResult({
      abi: ABI,
      functionName: "decimals",
      result: 18,
    }),
    "ethereum-sfrx-decimals": encodeFunctionResult({
      abi: ABI,
      functionName: "decimals",
      result: overrides.ethereumSfrxDecimals ?? 18,
    }),
    "ethereum-sfrx-asset": encodeFunctionResult({
      abi: ABI,
      functionName: "asset",
      result: (overrides.ethereumSfrxAsset ??
        params.expectedEthereumFrxUsdAddress) as Hex,
    }),
    "ethereum-sfrx-total-supply": encodeFunctionResult({
      abi: ABI,
      functionName: "totalSupply",
      result: ETHEREUM_SUPPLY,
    }),
    "ethereum-supply-assets": encodeFunctionResult({
      abi: ABI,
      functionName: "convertToAssets",
      result: (ETHEREUM_SUPPLY * PRICE) / E18,
    }),
    "eth-usd-aggregator": encodeFunctionResult({
      abi: ABI,
      functionName: "aggregator",
      result: (overrides.ethAggregator ??
        params.expectedEthUsdAggregatorAddress) as Hex,
    }),
    "eth-usd-decimals": encodeFunctionResult({
      abi: ABI,
      functionName: "decimals",
      result: 8,
    }),
    "eth-usd-round": encodeFunctionResult({
      abi: ABI,
      functionName: "latestRoundData",
      result: [
        100n,
        ETH_USD_E8,
        BigInt(NOW - 60),
        overrides.ethUpdatedAt ?? BigInt(NOW - 60),
        100n,
      ],
    }),
    "fraxtal-hop-paused": encodeFunctionResult({
      abi: ABI,
      functionName: "paused",
      result: overrides.fraxtalPaused ?? false,
    }),
    "fraxtal-hop-redeemer": encodeFunctionResult({
      abi: ABI,
      functionName: "fraxtalERC4626MintRedeemer",
      result: params.mintRedeemerProxyAddress as Hex,
    }),
    "fraxtal-hop-frx-lockbox": encodeFunctionResult({
      abi: ABI,
      functionName: "frxUsdLockbox",
      result: params.expectedFrxUsdLockboxAddress as Hex,
    }),
    "fraxtal-hop-sfrx-lockbox": encodeFunctionResult({
      abi: ABI,
      functionName: "sfrxUsdLockbox",
      result: params.expectedSfrxUsdLockboxAddress as Hex,
    }),
    "fraxtal-hop-remote": encodeFunctionResult({
      abi: ABI,
      functionName: "remoteHop",
      result: asBytes32(params.remoteHopAddress),
    }),
    "fraxtal-hop-native-balance": encodeFunctionResult({
      abi: ABI,
      functionName: "getEthBalance",
      result: overrides.hopNativeBalance ?? HOP_NATIVE_BALANCE,
    }),
    "fraxtal-frx-lockbox-token": encodeFunctionResult({
      abi: ABI,
      functionName: "token",
      result: params.expectedFraxtalFrxUsdAddress as Hex,
    }),
    "fraxtal-frx-lockbox-conversion-rate": encodeFunctionResult({
      abi: ABI,
      functionName: "decimalConversionRate",
      result: CONVERSION_RATE,
    }),
    "fraxtal-sfrx-lockbox-token": encodeFunctionResult({
      abi: ABI,
      functionName: "token",
      result: params.expectedFraxtalSfrxUsdAddress as Hex,
    }),
    "fraxtal-sfrx-lockbox-conversion-rate": encodeFunctionResult({
      abi: ABI,
      functionName: "decimalConversionRate",
      result: CONVERSION_RATE,
    }),
    "fraxtal-frx-decimals": encodeFunctionResult({
      abi: ABI,
      functionName: "decimals",
      result: 18,
    }),
    "fraxtal-sfrx-decimals": encodeFunctionResult({
      abi: ABI,
      functionName: "decimals",
      result: 18,
    }),
    "redeemer-underlying": encodeFunctionResult({
      abi: ABI,
      functionName: "underlyingTkn",
      result: params.expectedFraxtalFrxUsdAddress as Hex,
    }),
    "redeemer-vault": encodeFunctionResult({
      abi: ABI,
      functionName: "vaultTkn",
      result: params.expectedFraxtalSfrxUsdAddress as Hex,
    }),
    "redeemer-underlying-oracle": encodeFunctionResult({
      abi: ABI,
      functionName: "priceFeedUnderlying",
      result: ZERO_ADDRESS,
    }),
    "redeemer-vault-oracle": encodeFunctionResult({
      abi: ABI,
      functionName: "priceFeedVault",
      result: params.expectedVaultOracleAddress as Hex,
    }),
    "redeemer-fee": encodeFunctionResult({
      abi: ABI,
      functionName: "fee",
      result: feeRaw,
    }),
    "redeemer-oracle-tolerance": encodeFunctionResult({
      abi: ABI,
      functionName: "oracleTimeTolerance",
      result: 86_400n,
    }),
    "redeemer-stored-price": encodeFunctionResult({
      abi: ABI,
      functionName: "getVaultTknPriceStoredE18",
      result: PRICE,
    }),
    "redeemer-latest-vault-price": encodeFunctionResult({
      abi: ABI,
      functionName: "getLatestVaultTknPriceE18",
      result: PRICE,
    }),
    "redeemer-latest-underlying-price": encodeFunctionResult({
      abi: ABI,
      functionName: "getLatestUnderlyingPriceE18",
      result: E18,
    }),
    "redeemer-last-oracle-read": encodeFunctionResult({
      abi: ABI,
      functionName: "lastVaultTknOracleRead",
      result: overrides.lastOracleRead ?? BigInt(NOW - 60),
    }),
    "redeemer-total-assets": encodeFunctionResult({
      abi: ABI,
      functionName: "totalAssets",
      result: overrides.totalAssets ?? INVENTORY,
    }),
    "redeemer-mdwr": encodeFunctionResult({
      abi: ABI,
      functionName: "mdwrComboView",
      result:
        overrides.mdwr ??
        ([0n, 0n, INVENTORY, MAX_REDEEM_SHARES] as const),
    }),
    "redeemer-underlying-balance": encodeFunctionResult({
      abi: ABI,
      functionName: "balanceOf",
      result: overrides.underlyingBalance ?? INVENTORY,
    }),
    "vault-oracle-decimals": encodeFunctionResult({
      abi: ABI,
      functionName: "decimals",
      result: 18,
    }),
    "vault-oracle-round": encodeFunctionResult({
      abi: ABI,
      functionName: "latestRoundData",
      result: [
        200n,
        PRICE,
        BigInt(NOW - 60),
        overrides.vaultUpdatedAt ?? BigInt(NOW - 60),
        200n,
      ],
    }),
    "capacity-preview": encodeFunctionResult({
      abi: ABI,
      functionName: "previewRedeem",
      result: previewRedeem(MAX_REDEEM_SHARES, feeRaw),
    }),
  };
  return values[label] ?? "0x";
}

function encodedResults(
  calls: readonly EvmMulticall3Call[],
  overrides: StateOverrides,
): EvmMulticall3Result[] {
  return calls.map((call) => ({
    label: call.label,
    success: true,
    returnData: valueForLabel(call.label, overrides),
  }));
}

const proxyImplementations: Record<string, string> = {
  [SFRXUSD.toLowerCase()]:
    params.expectedEthereumSfrxUsdImplementationAddress,
  [params.expectedEthereumFrxUsdOftAddress.toLowerCase()]:
    params.expectedEthereumFrxUsdOftImplementationAddress,
  [params.expectedEthereumSfrxUsdOftAddress.toLowerCase()]:
    params.expectedEthereumSfrxUsdOftImplementationAddress,
  [params.mintRedeemerProxyAddress.toLowerCase()]:
    params.expectedMintRedeemerImplementationAddress,
  [params.expectedFrxUsdLockboxAddress.toLowerCase()]:
    params.expectedFrxUsdLockboxImplementationAddress,
  [params.expectedSfrxUsdLockboxAddress.toLowerCase()]:
    params.expectedSfrxUsdLockboxImplementationAddress,
};

function client(args: {
  state?: StateOverrides;
  staleBlock?: boolean;
  blockSkew?: boolean;
  codeDriftAddress?: string;
  implementationDriftAddress?: string;
  stateUnavailable?: boolean;
} = {}): SfrxusdCrosschainRouteReadClient {
  return {
    blockHeader: vi.fn().mockImplementation((chain: string) => {
      const timestamp = args.staleBlock
        ? NOW - params.maxFinalizedBlockAgeSec - 1
        : args.blockSkew && chain === "fraxtal"
          ? NOW - params.maxCrossChainBlockSkewSec - 61
          : NOW - 30;
      return Promise.resolve({
        number: chain === "ethereum" ? ETHEREUM_BLOCK : FRAXTAL_BLOCK,
        timestamp,
        hash: `0x${chain === "ethereum" ? "a".repeat(64) : "b".repeat(64)}`,
      } as const);
    }),
    code: vi.fn().mockImplementation((_chain: string, address: string) =>
      Promise.resolve(
        address.toLowerCase() === args.codeDriftAddress?.toLowerCase()
          ? DRIFT_CODE
          : CODE,
      ),
    ),
    storage: vi.fn().mockImplementation((_chain: string, address: string) => {
      const implementation =
        address.toLowerCase() ===
        args.implementationDriftAddress?.toLowerCase()
          ? ZERO_ADDRESS
          : proxyImplementations[address.toLowerCase()];
      return Promise.resolve(
        implementation ? asBytes32(implementation) : null,
      );
    }),
    multicall: vi
      .fn()
      .mockImplementation(
        (_chain: string, calls: readonly EvmMulticall3Call[]) =>
          Promise.resolve(
            args.stateUnavailable
              ? null
              : encodedResults(calls, args.state ?? {}),
          ),
      ),
  };
}

async function observe(readClient: SfrxusdCrosschainRouteReadClient) {
  return observeSfrxusdCrosschainRedemptionRoute(
    params,
    SFRXUSD,
    new AbortController().signal,
    undefined,
    { attemptedAtSec: NOW, client: readClient },
  );
}

describe("observeSfrxusdCrosschainRedemptionRoute", () => {
  it("publishes a finalized diagnostic packet without inventing gas or settlement evidence", async () => {
    const readClient = client();
    const attempt = await observe(readClient);

    expect(attempt).toMatchObject({
      status: "accepted",
      attemptedAtSec: NOW,
      state: {
        ethereumBlock: {
          finalityTag: "finalized",
          blockNumber: ETHEREUM_BLOCK,
          blockHash: `0x${"a".repeat(64)}`,
        },
        fraxtalBlock: {
          finalityTag: "finalized",
          blockNumber: FRAXTAL_BLOCK,
          blockHash: `0x${"b".repeat(64)}`,
        },
        capacity: {
          cappedRedeemableSharesRaw: MAX_REDEEM_SHARES.toString(),
          capacityUsd: Number(previewRedeem(MAX_REDEEM_SHARES)) / 1e18,
        },
        missingAllInCostComponents: ["ethereum-transaction-gas"],
        settlementUpperBoundSec: null,
        settlementEvidence: "unbounded",
      },
    });
    if (attempt.status !== "accepted") throw new Error("expected accepted packet");
    expect(attempt.state.contractIdentities).toHaveLength(11);
    expect(
      attempt.state.contractIdentities.filter(
        (identity) => identity.implementationAddress != null,
      ),
    ).toHaveLength(6);
    expect(
      attempt.state.protocolCostCurve.every(
        (point) =>
          point.transactionGasUsd == null && point.allInCostBps == null,
      ),
    ).toBe(true);
    expect(
      buildSfrxusdCrosschainV9ExitRouteObservation({
        state: attempt.state,
        modeledExitSizeUsd: 1_000_000,
        routeStatus: "open",
        resolutionState: "resolved",
        now: NOW,
      }),
    ).toBeNull();
    const reserveSnapshot = {
      stablecoinId: "sfrxusd-frax",
      fetchedAt: NOW - 30,
      source: "erc4626-single-asset",
      metadata: {
        freshnessMode: "verified" as const,
        sourceTimestamp: NOW - 30,
        redemption: {
          capacityUsd: attempt.state.capacity.capacityUsd,
          capacityKind: "live-direct-bounded" as const,
          freshnessKind: "same-run-onchain" as const,
          routeStatus: "open" as const,
          routeStatusSource: "onchain" as const,
          sourceUrls: attempt.state.sourceUrls,
          v9RouteAttempt: attempt,
        },
      },
      warningCount: 0,
      warnings: [],
      sourceModel: "single-bucket" as const,
      evidenceClass: "independent" as const,
      syncStatus: "ok" as const,
    };
    const liveMetadata = readRedemptionBackstopLiveMetadata(
      "sfrxusd-frax",
      reserveSnapshot,
      NOW,
    );
    expect(liveMetadata.v9SfrxusdCrosschainRouteState).toEqual(attempt.state);
    expect(
      readRedemptionBackstopLiveMetadata(
        "sfrxusd-frax",
        {
          ...reserveSnapshot,
          warnings: [
            {
              code: "route-degraded",
              message: "Route degraded",
              severity: "warning",
              effect: "degraded",
            },
          ],
          warningCount: 1,
        },
        NOW,
      ).v9SfrxusdCrosschainRouteState,
    ).toBeNull();
    const config = getRedemptionBackstopConfig("sfrxusd-frax");
    expect(config).toBeDefined();
    const entry = await buildRedemptionBackstopEntry(
      {} as D1Database,
      "sfrxusd-frax",
      config!,
      10_000_000,
      null,
      NOW,
      { reserveSnapshotMetadata: reserveSnapshot },
    );
    expect(entry.capacityProfile?.exitRouteObservations).toBeUndefined();
    const labels = vi
      .mocked(readClient.multicall)
      .mock.calls.flatMap((call) => call[1].map((item) => item.label));
    expect(labels).not.toContain("remote-num-dvns");
  });

  it.each(Object.keys(proxyImplementations))(
    "fails closed when proxy implementation %s drifts",
    async (proxyAddress) => {
      expect(
        await observe(client({ implementationDriftAddress: proxyAddress })),
      ).toMatchObject({
        status: "rejected",
        rejectionCode: "implementation-drift",
      });
    },
  );

  it.each([
    ["identity-mismatch", { state: { remoteEid: 30_102 } }],
    ["route-paused", { state: { remotePaused: true } }],
    [
      "token-identity-invalid",
      { state: { ethereumSfrxAsset: ZERO_ADDRESS } },
    ],
    [
      "token-decimals-invalid",
      { state: { ethereumSfrxDecimals: 17 } },
    ],
    [
      "oracle-invalid",
      { state: { vaultUpdatedAt: BigInt(NOW + 1) } },
    ],
    [
      "fee-out-of-bounds",
      { state: { feeRaw: 2_000_000_000_000_000n } },
    ],
    [
      "capacity-invalid",
      { state: { underlyingBalance: INVENTORY - 1n } },
    ],
    ["quote-invalid", { state: { quoteLzTokenFee: 1n } }],
    [
      "native-funding-insufficient",
      { state: { hopNativeBalance: RETURN_NATIVE_FEE - 1n } },
    ],
  ] as const)("rejects %s semantic drift", async (rejectionCode, args) => {
    expect(await observe(client(args))).toMatchObject({
      status: "rejected",
      rejectionCode,
    });
  });

  it.each([
    [
      "code-drift",
      { codeDriftAddress: params.expectedFraxtalHopAddress },
    ],
    ["state-unavailable", { stateUnavailable: true }],
    ["block-time-out-of-range", { staleBlock: true }],
    ["block-skew-out-of-range", { blockSkew: true }],
  ] as const)("fails closed on %s", async (rejectionCode, args) => {
    expect(await observe(client(args))).toMatchObject({
      status: "rejected",
      rejectionCode,
    });
  });
});
