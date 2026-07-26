import { describe, expect, it, vi } from "vitest";
import { encodeFunctionResult, parseAbi } from "viem/utils";
import type {
  EvmMulticall3Call,
  EvmMulticall3Result,
} from "../../../lib/evm-rpc";
import {
  observeExecutableRedemptionRoute,
  type ExecutableRedemptionReadClient,
} from "../executable-redemption-observers";

type Hex = `0x${string}`;

const NOW = 1_790_000_000;
const BLOCK = 25_800_000;
const EARN_VAULT = "0x9be9294722f8aad37b11a9792be2c782182cafa2";
const EARN_VALIDATOR = "0x4c735b0989f1a7464991bcca9f0e8c661ba54465";
const EARN_PROTOCOL_CONFIG = "0x1dc4836e5a0a95105bee1899e3b6bbb1714480fb";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const DSTAKE_TOKEN = "0x7cb20517776636ed76b68edb3d99dcce356abf02";
const DSTAKE_ROUTER = "0xdd26c236ec95d03ddf3cb67b7f54864719e9be5a";
const COLLATERAL_VAULT = "0x4acbcfa29fb085097c5f31783403ef7a7930f6fe";
const IDLE_STRATEGY = "0x78a4dad0ac32c80da6ef60a366b1c035145380bc";
const DLEND_STRATEGY = "0x576dd487bacfa6e7afd1e3ea03da0763f732d4c9";
const IDLE_ADAPTER = "0xefd794e2d8024f3c25aa343588dd6d4481b5db7c";
const DLEND_ADAPTER = "0x1a5bb485c58a86c193b823d0ea031b68813e100f";
const DUSD = "0x07fff99e1664d9b116fbc158c0e99785f81ca236";
const DLEND_POOL = "0x6598dad18bda89a0e58a1f427c8cebc0de90f153";
const DLEND_ATOKEN = "0x5cc741931d01cb1adde193222dfb1ad75930fd60";

const ERC20_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);
const ERC4626_ABI = parseAbi([
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
]);
const EARN_VAULT_ABI = parseAbi([
  "function vaultValidator() view returns (address)",
  "function protocolConfig() view returns (address)",
  "function pauseStatus() view returns (bool depositsPaused, bool withdrawalsPaused, bool privilegedOperationsPaused)",
  "function getPendingWithdrawalsLength() view returns (uint256)",
  "function minWithdrawableShares() view returns (uint256)",
]);
const EARN_VALIDATOR_ABI = parseAbi([
  "function withdrawalFee(address vault) view returns (uint256 permanentFeePercentage, uint256 timeBasedFeePercentage, uint256 balanceThreshold)",
  "function depositAllowListCount(address vault) view returns (uint256)",
]);
const EARN_PROTOCOL_CONFIG_ABI = parseAbi([
  "function getProtocolPauseStatus() view returns (bool)",
]);
const DSTAKE_TOKEN_ABI = parseAbi([
  "function router() view returns (address)",
  "function collateralVault() view returns (address)",
]);
const DSTAKE_ROUTER_ABI = parseAbi([
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
const STRATEGY_VAULT_ABI = parseAbi([
  "function asset() view returns (address)",
  "function maxWithdraw(address owner) view returns (uint256)",
]);
const STATIC_ATOKEN_ABI = parseAbi([
  "function POOL() view returns (address)",
  "function aToken() view returns (address)",
]);

const CODE_HASH_BY_ADDRESS: Record<string, string> = {
  [EARN_VAULT]: "0x864cc9ad53b338b82da1f7cab85ab0b3d5c8861acb422b6fec63cf36234f36a6",
  "0xab222201c5bd8a18dc6b340ba78a709589e01781":
    "0xebac90c2e11a034e309d631405c1ca28595c324af368ef5c2135e1f944415ce2",
  [EARN_VALIDATOR]: "0x864cc9ad53b338b82da1f7cab85ab0b3d5c8861acb422b6fec63cf36234f36a6",
  "0xe2089585c12ca4638ef072236fff877e961b8f13":
    "0x674d3f0b56cb829758f2450d2c38fa4c64eef02d7a1574119dc7b0ec2df557f7",
  [EARN_PROTOCOL_CONFIG]: "0x864cc9ad53b338b82da1f7cab85ab0b3d5c8861acb422b6fec63cf36234f36a6",
  "0x1ff9fe88c530b5320bb70e4b9593b33c0ae7289f":
    "0xc26e573ca2939ea56ae79dfaa5e2aa6287075978f222166b98e10c62ea6cef02",
  [DSTAKE_TOKEN]: "0xe5e3693157141608a301682c8c228c0277eac7efc0b98b57f874ca49752b5fd8",
  "0x9c278036c3c4529472751502dfc71bb1f0a3bfd4":
    "0xf3d6aec9f278be5b2140dcca59bfd109bd57bdf4d928e11d2a7b3863bb1b796d",
  [DSTAKE_ROUTER]: "0x08f865940e3532d14604ba5fdc7560fd35c59dde586a5e5322ae4312be5a9d03",
  [COLLATERAL_VAULT]: "0x9bef4196d31f6ccf89b74f147be85e8a24c19085d59776a48301d3cb06e1def9",
  [IDLE_STRATEGY]: "0x1dc234de62c077e81b3af54e4c4c6feeef6922213147e4c0b865be07f63f57a8",
  [IDLE_ADAPTER]: "0x0620eb4be11008952dd737925d15743ec443bed53cf163e5f8244d9e80fe999b",
  [DLEND_STRATEGY]: "0xe448349ec1a422118e4244e737f124d1f5e65ccf696a8eecfe48fc8008e082e2",
  [DLEND_ADAPTER]: "0x958bacf03625c8460aa5b3f30ba4fb4610b47a6c8580e257c2e108c53a1787c4",
};

const IMPLEMENTATION_BY_PROXY: Record<string, string> = {
  [EARN_VAULT]: "0xab222201c5bd8a18dc6b340ba78a709589e01781",
  [EARN_VALIDATOR]: "0xe2089585c12ca4638ef072236fff877e961b8f13",
  [EARN_PROTOCOL_CONFIG]: "0x1ff9fe88c530b5320bb70e4b9593b33c0ae7289f",
  [DSTAKE_TOKEN]: "0x9c278036c3c4529472751502dfc71bb1f0a3bfd4",
};

function storageWord(address: string): Hex {
  return `0x${address.slice(2).padStart(64, "0")}`;
}

function earnResults(calls: readonly EvmMulticall3Call[]): EvmMulticall3Result[] {
  const values: Record<string, Hex> = {
    "earn-asset": encodeFunctionResult({ abi: ERC4626_ABI, functionName: "asset", result: USDC }),
    "earn-total-assets": encodeFunctionResult({
      abi: ERC4626_ABI,
      functionName: "totalAssets",
      result: 3_200_000_000_000n,
    }),
    "earn-validator": encodeFunctionResult({
      abi: EARN_VAULT_ABI,
      functionName: "vaultValidator",
      result: EARN_VALIDATOR,
    }),
    "earn-protocol-config": encodeFunctionResult({
      abi: EARN_VAULT_ABI,
      functionName: "protocolConfig",
      result: EARN_PROTOCOL_CONFIG,
    }),
    "earn-pause-status": encodeFunctionResult({
      abi: EARN_VAULT_ABI,
      functionName: "pauseStatus",
      result: [false, false, false],
    }),
    "earn-pending-withdrawals": encodeFunctionResult({
      abi: EARN_VAULT_ABI,
      functionName: "getPendingWithdrawalsLength",
      result: 0n,
    }),
    "earn-min-withdrawable-shares": encodeFunctionResult({
      abi: EARN_VAULT_ABI,
      functionName: "minWithdrawableShares",
      result: 100_000n,
    }),
    "earn-withdrawal-fee": encodeFunctionResult({
      abi: EARN_VALIDATOR_ABI,
      functionName: "withdrawalFee",
      result: [0n, 0n, 0n],
    }),
    "earn-deposit-allow-list-count": encodeFunctionResult({
      abi: EARN_VALIDATOR_ABI,
      functionName: "depositAllowListCount",
      result: 0n,
    }),
    "earn-protocol-paused": encodeFunctionResult({
      abi: EARN_PROTOCOL_CONFIG_ABI,
      functionName: "getProtocolPauseStatus",
      result: false,
    }),
    "earn-idle-usdc": encodeFunctionResult({
      abi: ERC20_ABI,
      functionName: "balanceOf",
      result: 199_000_000n,
    }),
    "earn-asset-decimals": encodeFunctionResult({
      abi: ERC20_ABI,
      functionName: "decimals",
      result: 6,
    }),
  };
  return calls.map((call) => ({
    label: call.label,
    success: true,
    returnData: values[call.label]!,
  }));
}

interface DStakeOverrides {
  paused?: boolean;
  activeWithdrawalVaults?: readonly Hex[];
}

function dStakeResults(
  calls: readonly EvmMulticall3Call[],
  overrides: DStakeOverrides = {},
): EvmMulticall3Result[] {
  const dlendMaxWithdraw = 192_389_829_956_990_993_894_191n;
  const values: Record<string, Hex> = {
    "dstake-asset": encodeFunctionResult({ abi: ERC4626_ABI, functionName: "asset", result: DUSD }),
    "dstake-total-assets": encodeFunctionResult({
      abi: ERC4626_ABI,
      functionName: "totalAssets",
      result: 384_250_417_697_649_081_255_185n,
    }),
    "dstake-router": encodeFunctionResult({
      abi: DSTAKE_TOKEN_ABI,
      functionName: "router",
      result: DSTAKE_ROUTER,
    }),
    "dstake-collateral-vault": encodeFunctionResult({
      abi: DSTAKE_TOKEN_ABI,
      functionName: "collateralVault",
      result: COLLATERAL_VAULT,
    }),
    "router-token": encodeFunctionResult({
      abi: DSTAKE_ROUTER_ABI,
      functionName: "dStakeToken",
      result: DSTAKE_TOKEN,
    }),
    "router-collateral-vault": encodeFunctionResult({
      abi: DSTAKE_ROUTER_ABI,
      functionName: "collateralVault",
      result: COLLATERAL_VAULT,
    }),
    "router-paused": encodeFunctionResult({
      abi: DSTAKE_ROUTER_ABI,
      functionName: "paused",
      result: overrides.paused ?? false,
    }),
    "router-withdrawal-fee": encodeFunctionResult({
      abi: DSTAKE_ROUTER_ABI,
      functionName: "withdrawalFeeBps",
      result: 1_000n,
    }),
    "router-max-withdrawal-fee": encodeFunctionResult({
      abi: DSTAKE_ROUTER_ABI,
      functionName: "maxWithdrawalFeeBps",
      result: 10_000n,
    }),
    "router-shortfall": encodeFunctionResult({
      abi: DSTAKE_ROUTER_ABI,
      functionName: "currentShortfall",
      result: 0n,
    }),
    "router-active-withdrawal-vaults": encodeFunctionResult({
      abi: DSTAKE_ROUTER_ABI,
      functionName: "getActiveVaultsForWithdrawals",
      result: overrides.activeWithdrawalVaults ?? [IDLE_STRATEGY, DLEND_STRATEGY],
    }),
    "idle-strategy-asset": encodeFunctionResult({
      abi: STRATEGY_VAULT_ABI,
      functionName: "asset",
      result: DUSD,
    }),
    "idle-strategy-max-withdraw": encodeFunctionResult({
      abi: STRATEGY_VAULT_ABI,
      functionName: "maxWithdraw",
      result: 993_333_681_415_103_920n,
    }),
    "idle-strategy-adapter": encodeFunctionResult({
      abi: DSTAKE_ROUTER_ABI,
      functionName: "strategyShareToAdapter",
      result: IDLE_ADAPTER,
    }),
    "idle-strategy-healthy": encodeFunctionResult({
      abi: DSTAKE_ROUTER_ABI,
      functionName: "isVaultHealthyForWithdrawals",
      result: true,
    }),
    "dlend-strategy-asset": encodeFunctionResult({
      abi: STRATEGY_VAULT_ABI,
      functionName: "asset",
      result: DUSD,
    }),
    "dlend-strategy-max-withdraw": encodeFunctionResult({
      abi: STRATEGY_VAULT_ABI,
      functionName: "maxWithdraw",
      result: dlendMaxWithdraw,
    }),
    "dlend-strategy-adapter": encodeFunctionResult({
      abi: DSTAKE_ROUTER_ABI,
      functionName: "strategyShareToAdapter",
      result: DLEND_ADAPTER,
    }),
    "dlend-strategy-healthy": encodeFunctionResult({
      abi: DSTAKE_ROUTER_ABI,
      functionName: "isVaultHealthyForWithdrawals",
      result: true,
    }),
    "dlend-pool": encodeFunctionResult({
      abi: STATIC_ATOKEN_ABI,
      functionName: "POOL",
      result: DLEND_POOL,
    }),
    "dlend-atoken": encodeFunctionResult({
      abi: STATIC_ATOKEN_ABI,
      functionName: "aToken",
      result: DLEND_ATOKEN,
    }),
    "dlend-available-liquidity": encodeFunctionResult({
      abi: ERC20_ABI,
      functionName: "balanceOf",
      result: dlendMaxWithdraw + 1n,
    }),
    "dstake-asset-decimals": encodeFunctionResult({
      abi: ERC20_ABI,
      functionName: "decimals",
      result: 18,
    }),
  };
  return calls.map((call) => ({
    label: call.label,
    success: true,
    returnData: values[call.label]!,
  }));
}

function client(
  coin: "earn" | "dstake",
  options: {
    driftAddress?: string;
    dStakeOverrides?: DStakeOverrides;
  } = {},
): ExecutableRedemptionReadClient {
  return {
    blockNumber: vi.fn().mockResolvedValue(BLOCK),
    blockTimestamp: vi.fn().mockResolvedValue(NOW - 30),
    codeHash: vi.fn().mockImplementation(async (address: string) =>
      address.toLowerCase() === options.driftAddress?.toLowerCase()
        ? `0x${"f".repeat(64)}`
        : CODE_HASH_BY_ADDRESS[address.toLowerCase()] ?? null,
    ),
    storage: vi.fn().mockImplementation(async (address: string) => {
      const implementation = IMPLEMENTATION_BY_PROXY[address.toLowerCase()];
      return implementation ? storageWord(implementation) : null;
    }),
    multicall: vi.fn().mockImplementation(async (calls: readonly EvmMulticall3Call[]) =>
      coin === "earn"
        ? earnResults(calls)
        : dStakeResults(calls, options.dStakeOverrides),
    ),
  };
}

describe("specialized executable redemption observers", () => {
  it("measures eEARN queue state and fee without treating idle USDC as immediate capacity", async () => {
    const observation = await observeExecutableRedemptionRoute(
      "eearn-ember",
      EARN_VAULT,
      new AbortController().signal,
      undefined,
      { client: client("earn"), nowSec: NOW },
    );

    expect(observation).toMatchObject({
      capacityRaw: 0n,
      capacitySource: "eearn-operator-batched-no-immediate-capacity",
      routeStatus: "open",
      feeBps: 0,
      blockNumber: BLOCK,
      sourceTimestamp: NOW - 30,
      diagnostics: {
        idleUnderlyingBalanceRaw: "199000000",
        idleUnderlyingUsedAsCapacity: false,
        minWithdrawableSharesRaw: "100000",
      },
    });
  });

  it("fails eEARN closed on pinned implementation-code drift", async () => {
    await expect(
      observeExecutableRedemptionRoute(
        "eearn-ember",
        EARN_VAULT,
        new AbortController().signal,
        undefined,
        {
          client: client("earn", {
            driftAddress: "0xab222201c5bd8a18dc6b340ba78a709589e01781",
          }),
          nowSec: NOW,
        },
      ),
    ).rejects.toThrow(/code identity drift/);
  });

  it("uses exact dLEND maxWithdraw and available liquidity with the current unstaking fee", async () => {
    const observation = await observeExecutableRedemptionRoute(
      "sdusd-dtrinity",
      DSTAKE_TOKEN,
      new AbortController().signal,
      undefined,
      { client: client("dstake"), nowSec: NOW },
    );

    expect(observation).toMatchObject({
      capacityRaw: 192_389_829_956_990_993_894_191n,
      capacitySource: "dtrinity-dlend-max-withdraw",
      routeStatus: "open",
      feeBps: 10,
      diagnostics: {
        outputAssetAddress: DUSD,
        dlendStrategyMaxWithdrawRaw: "192389829956990993894191",
        dlendAvailableLiquidityRaw: "192389829956990993894192",
        currentWithdrawalFeeRaw: "1000",
      },
    });
  });

  it("fails closed on dTRINITY strategy-set drift and emits zero on a current pause", async () => {
    await expect(
      observeExecutableRedemptionRoute(
        "sdusd-dtrinity",
        DSTAKE_TOKEN,
        new AbortController().signal,
        undefined,
        {
          client: client("dstake", {
            dStakeOverrides: { activeWithdrawalVaults: [IDLE_STRATEGY] },
          }),
          nowSec: NOW,
        },
      ),
    ).rejects.toThrow(/active withdrawal strategy set drift/);

    const paused = await observeExecutableRedemptionRoute(
      "sdusd-dtrinity",
      DSTAKE_TOKEN,
      new AbortController().signal,
      undefined,
      {
        client: client("dstake", { dStakeOverrides: { paused: true } }),
        nowSec: NOW,
      },
    );
    expect(paused).toMatchObject({ routeStatus: "paused", capacityRaw: 0n });
  });
});
