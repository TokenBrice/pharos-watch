import type { EvmRpcOptions } from "../../lib/evm-rpc";
import type { AdapterContext } from "./types";
import { fail, readStateWithPlan, type ExecutableRedemptionReadClient, type ExecutableRedemptionObservation } from "./executable-redemption-read-client";
import { parseAbi } from "viem/utils";
import { erc20Abi, erc4626Abi } from "./executable-redemption-abis";
import { normalizeEvmAddress } from "./evm";
import { type ProxyIdentity, type DirectIdentity, fixedPointFeeBpsCeil, verifyExpectedAddress, abiField } from "./executable-redemption-observer-helpers";

export const DSTAKE_TOKEN_ABI = parseAbi([
  "function router() view returns (address)",
  "function collateralVault() view returns (address)",
]);
export const DSTAKE_ROUTER_ABI = parseAbi([
  "function governanceModule() view returns (address)",
  "function rebalanceModule() view returns (address)",
  "function dStakeToken() view returns (address)",
  "function collateralVault() view returns (address)",
  "function paused() view returns (bool)",
  "function withdrawalFeeBps() view returns (uint256)",
  "function maxWithdrawalFeeBps() view returns (uint256)",
  "function currentShortfall() view returns (uint256)",
  "function getActiveVaultsForWithdrawals() view returns (address[])",
  "function strategyShareToAdapter(address strategyShare) view returns (address)",
  "function isVaultHealthyForWithdrawals(address strategyShare) view returns (bool)",
]);
export const STATIC_ATOKEN_ABI = parseAbi([
  "function POOL() view returns (address)",
  "function aToken() view returns (address)",
]);

const DSTAKE = {
  coinId: "sdusd-dtrinity",
  token: {
    address: "0x7cb20517776636ed76b68edb3d99dcce356abf02",
    codeHash: "0xe5e3693157141608a301682c8c228c0277eac7efc0b98b57f874ca49752b5fd8",
    implementationAddress: "0x9c278036c3c4529472751502dfc71bb1f0a3bfd4",
    implementationCodeHash: "0xf3d6aec9f278be5b2140dcca59bfd109bd57bdf4d928e11d2a7b3863bb1b796d",
  } satisfies ProxyIdentity,
  router: {
    address: "0x6d4a26fe926e88fee41a9fddeda3b50bf98f1ddb",
    codeHash: "0xa4167490ee7ee175f6c257a2fad355a67d4061afebc6d65c381a9236e1480f4b",
  } satisfies DirectIdentity,
  collateralVault: {
    address: "0x4acbcfa29fb085097c5f31783403ef7a7930f6fe",
    codeHash: "0x9bef4196d31f6ccf89b74f147be85e8a24c19085d59776a48301d3cb06e1def9",
  } satisfies DirectIdentity,
  governanceModule: {
    address: "0x2fd26c2cbfe0674776a1ff00daa8cffefcc0c88c",
    codeHash: "0x1434e0df9c945565f750495d8981cc0771cd5a00786bc3373d18bc965c9945a9",
  } satisfies DirectIdentity,
  rebalanceModule: {
    address: "0xd15ccbe652c0c29b1d544a26f902f21dfc5b4f05",
    codeHash: "0x747c8358f0f87437ec23361620e04745b8d7e103a18a09d0a69dec933820407b",
  } satisfies DirectIdentity,
  dlendStrategy: {
    address: "0x576dd487bacfa6e7afd1e3ea03da0763f732d4c9",
    codeHash: "0xe448349ec1a422118e4244e737f124d1f5e65ccf696a8eecfe48fc8008e082e2",
  } satisfies DirectIdentity,
  dlendAdapter: {
    address: "0x1a5bb485c58a86c193b823d0ea031b68813e100f",
    codeHash: "0x958bacf03625c8460aa5b3f30ba4fb4610b47a6c8580e257c2e108c53a1787c4",
  } satisfies DirectIdentity,
  assetAddress: "0x07fff99e1664d9b116fbc158c0e99785f81ca236",
  assetDecimals: 18,
  dlendPoolAddress: "0x6598dad18bda89a0e58a1f427c8cebc0de90f153",
  dlendATokenAddress: "0x5cc741931d01cb1adde193222dfb1ad75930fd60",
  sourceUrls: [
    "https://docs.dtrinity.org/protocol-components/sdusd",
    "https://docs.dtrinity.org/security/addresses",
    "https://etherscan.io/address/0x6d4a26fe926e88fee41a9fddeda3b50bf98f1ddb#code",
    "https://etherscan.io/address/0x2fd26c2cbfe0674776a1ff00daa8cffefcc0c88c#code",
    "https://etherscan.io/address/0xd15ccbe652c0c29b1d544a26f902f21dfc5b4f05#code",
  ],
} as const;

function sameAddressSet(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  const normalizedActual = actual
    .map((address) => normalizeEvmAddress(address))
    .filter((address): address is `0x${string}` => address != null)
    .sort();
  const normalizedExpected = [...expected].map((address) => address.toLowerCase()).sort();
  return (
    normalizedActual.length === normalizedExpected.length &&
    normalizedActual.every((address, index) => address === normalizedExpected[index])
  );
}

function dStakeFields() {
  return [
    abiField("dstake-asset", DSTAKE.token.address, erc4626Abi, "asset", {
      verify: verifyExpectedAddress(DSTAKE.coinId, "asset", DSTAKE.assetAddress),
    }),
    abiField("dstake-total-assets", DSTAKE.token.address, erc4626Abi, "totalAssets"),
    abiField("dstake-router", DSTAKE.token.address, DSTAKE_TOKEN_ABI, "router", {
      verify: verifyExpectedAddress(DSTAKE.coinId, "token router", DSTAKE.router.address),
    }),
    abiField("dstake-collateral-vault", DSTAKE.token.address, DSTAKE_TOKEN_ABI, "collateralVault", {
      verify: verifyExpectedAddress(DSTAKE.coinId, "token collateral vault", DSTAKE.collateralVault.address),
    }),
    abiField("router-token", DSTAKE.router.address, DSTAKE_ROUTER_ABI, "dStakeToken", {
      verify: verifyExpectedAddress(DSTAKE.coinId, "router dStakeToken", DSTAKE.token.address),
    }),
    abiField("router-collateral-vault", DSTAKE.router.address, DSTAKE_ROUTER_ABI, "collateralVault", {
      verify: verifyExpectedAddress(DSTAKE.coinId, "router collateral vault", DSTAKE.collateralVault.address),
    }),
    abiField("collateral-vault-router", DSTAKE.collateralVault.address, DSTAKE_TOKEN_ABI, "router", {
      verify: verifyExpectedAddress(DSTAKE.coinId, "collateral vault router", DSTAKE.router.address),
    }),
    abiField("router-governance-module", DSTAKE.router.address, DSTAKE_ROUTER_ABI, "governanceModule", {
      verify: verifyExpectedAddress(DSTAKE.coinId, "governance module", DSTAKE.governanceModule.address),
    }),
    abiField("router-rebalance-module", DSTAKE.router.address, DSTAKE_ROUTER_ABI, "rebalanceModule", {
      verify: verifyExpectedAddress(DSTAKE.coinId, "rebalance module", DSTAKE.rebalanceModule.address),
    }),
    abiField("router-paused", DSTAKE.router.address, DSTAKE_ROUTER_ABI, "paused"),
    abiField("router-withdrawal-fee", DSTAKE.router.address, DSTAKE_ROUTER_ABI, "withdrawalFeeBps"),
    abiField("router-max-withdrawal-fee", DSTAKE.router.address, DSTAKE_ROUTER_ABI, "maxWithdrawalFeeBps"),
    abiField("router-shortfall", DSTAKE.router.address, DSTAKE_ROUTER_ABI, "currentShortfall"),
    abiField("router-active-withdrawal-vaults", DSTAKE.router.address, DSTAKE_ROUTER_ABI, "getActiveVaultsForWithdrawals"),
    abiField("dlend-strategy-asset", DSTAKE.dlendStrategy.address, erc4626Abi, "asset", {
      verify: verifyExpectedAddress(DSTAKE.coinId, "dLEND strategy asset", DSTAKE.assetAddress),
    }),
    abiField("dlend-strategy-max-withdraw", DSTAKE.dlendStrategy.address, erc4626Abi, "maxWithdraw", {
      args: [DSTAKE.collateralVault.address],
    }),
    abiField("dlend-strategy-adapter", DSTAKE.router.address, DSTAKE_ROUTER_ABI, "strategyShareToAdapter", {
      args: [DSTAKE.dlendStrategy.address],
      verify: verifyExpectedAddress(DSTAKE.coinId, "dLEND strategy adapter", DSTAKE.dlendAdapter.address),
    }),
    abiField("dlend-strategy-healthy", DSTAKE.router.address, DSTAKE_ROUTER_ABI, "isVaultHealthyForWithdrawals", {
      args: [DSTAKE.dlendStrategy.address],
    }),
    abiField("dlend-pool", DSTAKE.dlendStrategy.address, STATIC_ATOKEN_ABI, "POOL", {
      verify: verifyExpectedAddress(DSTAKE.coinId, "dLEND pool", DSTAKE.dlendPoolAddress),
    }),
    abiField("dlend-atoken", DSTAKE.dlendStrategy.address, STATIC_ATOKEN_ABI, "aToken", {
      verify: verifyExpectedAddress(DSTAKE.coinId, "dLEND aToken", DSTAKE.dlendATokenAddress),
    }),
    abiField("dlend-available-liquidity", DSTAKE.assetAddress, erc20Abi, "balanceOf", {
      args: [DSTAKE.dlendATokenAddress],
    }),
    abiField("dstake-asset-decimals", DSTAKE.assetAddress, erc20Abi, "decimals"),
  ] as const;
}

export async function observeDStake(
  blockNumber: number,
  blockTimestamp: number,
  rpcOptions: EvmRpcOptions,
  client: ExecutableRedemptionReadClient,
  ctx: AdapterContext | undefined,
  signal: AbortSignal,
): Promise<ExecutableRedemptionObservation> {
  const state = await readStateWithPlan(
    DSTAKE.coinId,
    "sdusd-dtrinity-redemption-state",
    dStakeFields(),
    [
      DSTAKE.token,
      DSTAKE.router,
      DSTAKE.collateralVault,
      DSTAKE.governanceModule,
      DSTAKE.rebalanceModule,
      DSTAKE.dlendStrategy,
      DSTAKE.dlendAdapter,
    ],
    blockNumber,
    rpcOptions,
    client,
    ctx,
    signal,
  );

  const activeWithdrawalVaults = state.values["router-active-withdrawal-vaults"] as readonly string[];
  if (
    !sameAddressSet(activeWithdrawalVaults, [
      DSTAKE.dlendStrategy.address,
    ])
  ) {
    fail(DSTAKE.coinId, "active withdrawal strategy set drift");
  }

  const dlendMaxWithdrawRaw = state.values["dlend-strategy-max-withdraw"] as bigint;
  const dlendAvailableLiquidityRaw = state.values["dlend-available-liquidity"] as bigint;
  const totalAssetsRaw = state.values["dstake-total-assets"] as bigint;
  if (
    dlendMaxWithdrawRaw < 0n ||
    dlendAvailableLiquidityRaw < 0n ||
    totalAssetsRaw <= 0n ||
    dlendMaxWithdrawRaw > dlendAvailableLiquidityRaw
  ) {
    fail(DSTAKE.coinId, "invalid dLEND available-liquidity/max-withdraw bound");
  }

  const currentFeeRaw = state.values["router-withdrawal-fee"] as bigint;
  const maxFeeRaw = state.values["router-max-withdrawal-fee"] as bigint;
  if (currentFeeRaw < 0n || maxFeeRaw < 0n || currentFeeRaw > maxFeeRaw || maxFeeRaw > 1_000_000n) {
    fail(DSTAKE.coinId, "invalid withdrawal fee state");
  }
  const feeBps = fixedPointFeeBpsCeil(currentFeeRaw, 1_000_000n, DSTAKE.coinId);
  const paused = state.values["router-paused"] as boolean;
  const shortfallRaw = state.values["router-shortfall"] as bigint;
  const dlendHealthy = state.values["dlend-strategy-healthy"] as boolean;
  const assetDecimals = state.values["dstake-asset-decimals"] as number;
  if (assetDecimals !== DSTAKE.assetDecimals || shortfallRaw < 0n) {
    fail(DSTAKE.coinId, "invalid dSTAKE asset or shortfall state");
  }

  const cappedBound = dlendMaxWithdrawRaw > totalAssetsRaw ? totalAssetsRaw : dlendMaxWithdrawRaw;
  const routeOpen =
    paused === false &&
    shortfallRaw === 0n &&
    dlendHealthy === true &&
    cappedBound > 0n;
  return {
    capacityRaw: routeOpen ? cappedBound : 0n,
    capacitySource: "dtrinity-dlend-max-withdraw",
    capacityState: routeOpen ? "measured" : "closed",
    outputAssetKeys: ["dusd-dtrinity"],
    underlyingDecimals: DSTAKE.assetDecimals,
    capacityKind: "live-direct-bounded",
    freshnessKind: "same-run-onchain",
    routeStatusSource: "onchain",
    routeStatus: routeOpen
      ? "open"
      : paused === true
        ? "paused"
        : "degraded",
    routeStatusReason: routeOpen
      ? "dTRINITY sdUSD withdrawals are unpaused with zero shortfall and bounded by the live dLEND strategy maxWithdraw"
      : "dTRINITY sdUSD withdrawal state is paused, unhealthy, short, or has zero executable liquidity",
    feeBps,
    holderEligibility: "any-holder",
    blockNumber,
    sourceTimestamp: blockTimestamp,
    sourceUrls: [...DSTAKE.sourceUrls],
    diagnostics: {
      outputAssetAddress: DSTAKE.assetAddress,
      tokenAddress: DSTAKE.token.address,
      tokenImplementationAddress: DSTAKE.token.implementationAddress,
      routerAddress: DSTAKE.router.address,
      collateralVaultAddress: DSTAKE.collateralVault.address,
      activeWithdrawalVaults: activeWithdrawalVaults.map((address) => address.toLowerCase()),
      governanceModuleAddress: DSTAKE.governanceModule.address,
      rebalanceModuleAddress: DSTAKE.rebalanceModule.address,
      dlendStrategyAddress: DSTAKE.dlendStrategy.address,
      dlendStrategyMaxWithdrawRaw: dlendMaxWithdrawRaw.toString(),
      dlendStrategyHealthy: dlendHealthy,
      dlendAvailableLiquidityRaw: dlendAvailableLiquidityRaw.toString(),
      dlendPoolAddress: DSTAKE.dlendPoolAddress,
      dlendATokenAddress: DSTAKE.dlendATokenAddress,
      totalAssetsRaw: totalAssetsRaw.toString(),
      currentWithdrawalFeeRaw: currentFeeRaw.toString(),
      maxWithdrawalFeeRaw: maxFeeRaw.toString(),
      currentShortfallRaw: shortfallRaw.toString(),
      routerPaused: paused,
    },
  };
}
