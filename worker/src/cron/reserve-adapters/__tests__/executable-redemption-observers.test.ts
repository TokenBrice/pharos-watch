import { describe, expect, it, vi } from "vitest";
import { encodeFunctionData, encodeFunctionResult, parseAbi } from "viem/utils";
import type { Abi } from "abitype";
import type {
  EvmMulticall3Call,
  EvmMulticall3Result,
} from "../../../lib/evm-rpc";
import {
  getStableObservationBlockNumber,
  observeExecutableRedemptionRoute,
  type ExecutableRedemptionReadClient,
} from "../executable-redemption-observers";
import { EIP1967_IMPLEMENTATION_SLOT } from "../onchain-identity";

type Hex = `0x${string}`;

const NOW = 1_790_000_000;
const BLOCK = 25_800_000;
const EARN_VAULT = "0x9be9294722f8aad37b11a9792be2c782182cafa2";
const EARN_VALIDATOR = "0x4c735b0989f1a7464991bcca9f0e8c661ba54465";
const EARN_PROTOCOL_CONFIG = "0x1dc4836e5a0a95105bee1899e3b6bbb1714480fb";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const DSTAKE_TOKEN = "0x7cb20517776636ed76b68edb3d99dcce356abf02";
const DSTAKE_ROUTER = "0x6d4a26fe926e88fee41a9fddeda3b50bf98f1ddb";
const COLLATERAL_VAULT = "0x4acbcfa29fb085097c5f31783403ef7a7930f6fe";
const IDLE_STRATEGY = "0x78a4dad0ac32c80da6ef60a366b1c035145380bc";
const DLEND_STRATEGY = "0x576dd487bacfa6e7afd1e3ea03da0763f732d4c9";
const GOVERNANCE_MODULE = "0x2fd26c2cbfe0674776a1ff00daa8cffefcc0c88c";
const REBALANCE_MODULE = "0xd15ccbe652c0c29b1d544a26f902f21dfc5b4f05";
const DLEND_ADAPTER = "0x1a5bb485c58a86c193b823d0ea031b68813e100f";
const DUSD = "0x07fff99e1664d9b116fbc158c0e99785f81ca236";
const DLEND_POOL = "0x6598dad18bda89a0e58a1f427c8cebc0de90f153";
const DLEND_ATOKEN = "0x5cc741931d01cb1adde193222dfb1ad75930fd60";
const NOON_SUSN_VAULT = "0xe24a3dc889621612422a64e6388927901608b91d";
const NOON_SUSN_VAULT_IMPL = "0xebbcbc6672683e1956125e7c5e89e14ceac8cd3d";
const NOON_WITHDRAWAL_HANDLER = "0x0dabc0d9b270c9b0c4c77aaceaa712b56d0f9178";
const NOON_HANDLER_SLOT = "0xeb35582a09ab498623cb7b45bfdff1ae6ef9e826b054d3e2fb048e4d27a9fce";
const USN_NOON = "0xda67b4284609d2d48e5d10cfac411572727dc1ed";

const erc20Abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);
const erc4626Abi = parseAbi([
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function maxWithdraw(address owner) view returns (uint256)",
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
const STATIC_ATOKEN_ABI = parseAbi([
  "function POOL() view returns (address)",
  "function aToken() view returns (address)",
]);
const NOON_SUSN_VAULT_ABI = parseAbi([
  "function paused() view returns (bool)",
]);
const NOON_SUSN_WITHDRAWAL_HANDLER_ABI = parseAbi([
  "function usn() view returns (address)",
  "function withdrawPeriod() view returns (uint256)",
]);

const CODE_HASH_BY_ADDRESS: Record<string, string> = {
  [EARN_VAULT]: "0x864cc9ad53b338b82da1f7cab85ab0b3d5c8861acb422b6fec63cf36234f36a6",
  "0x9b2e2eef7ffe1b15ca8c61e65538b51ca8977c7e":
    "0x4448a74aff5a6b95fe30cebf1187f9dc647d81413ae7e06410e7772b4b64efc4",
  [EARN_VALIDATOR]: "0x864cc9ad53b338b82da1f7cab85ab0b3d5c8861acb422b6fec63cf36234f36a6",
  "0x2bebb55c0ca126b0d883fb94843c0a2c13102522":
    "0x537bb88a640ed963c5848c27bdb3ac3b7da135642908db377b4c9a362cdd61f9",
  [EARN_PROTOCOL_CONFIG]: "0x864cc9ad53b338b82da1f7cab85ab0b3d5c8861acb422b6fec63cf36234f36a6",
  "0x540db273e41587a748365f01f35adb095b58bfeb":
    "0x2c629d0cdee4894f27ca680a5d168a46ae8ed829e6d5e0c424f5d3e12dc866c7",
  [DSTAKE_TOKEN]: "0xe5e3693157141608a301682c8c228c0277eac7efc0b98b57f874ca49752b5fd8",
  "0x9c278036c3c4529472751502dfc71bb1f0a3bfd4":
    "0xf3d6aec9f278be5b2140dcca59bfd109bd57bdf4d928e11d2a7b3863bb1b796d",
  [DSTAKE_ROUTER]: "0xa4167490ee7ee175f6c257a2fad355a67d4061afebc6d65c381a9236e1480f4b",
  [COLLATERAL_VAULT]: "0x9bef4196d31f6ccf89b74f147be85e8a24c19085d59776a48301d3cb06e1def9",
  [GOVERNANCE_MODULE]: "0x1434e0df9c945565f750495d8981cc0771cd5a00786bc3373d18bc965c9945a9",
  [REBALANCE_MODULE]: "0x747c8358f0f87437ec23361620e04745b8d7e103a18a09d0a69dec933820407b",
  [DLEND_STRATEGY]: "0xe448349ec1a422118e4244e737f124d1f5e65ccf696a8eecfe48fc8008e082e2",
  [DLEND_ADAPTER]: "0x958bacf03625c8460aa5b3f30ba4fb4610b47a6c8580e257c2e108c53a1787c4",
  [NOON_SUSN_VAULT]: "0xb108840d91ea6f26d83fc692d0ac870fe1e895debcd9e67c1d7d4317296a88e6",
  [NOON_SUSN_VAULT_IMPL]: "0x2fec4424636a25ee95ed7135af071433609bce018d51aca35d222ea4787876ef",
  [NOON_WITHDRAWAL_HANDLER]: "0x48f64f2a52f543354cd46deeb67405df9544289012d18bd9b48920d44d0a4c13",
};

const IMPLEMENTATION_BY_PROXY: Record<string, string> = {
  [EARN_VAULT]: "0x9b2e2eef7ffe1b15ca8c61e65538b51ca8977c7e",
  [EARN_VALIDATOR]: "0x2bebb55c0ca126b0d883fb94843c0a2c13102522",
  [EARN_PROTOCOL_CONFIG]: "0x540db273e41587a748365f01f35adb095b58bfeb",
  [DSTAKE_TOKEN]: "0x9c278036c3c4529472751502dfc71bb1f0a3bfd4",
  [NOON_SUSN_VAULT]: NOON_SUSN_VAULT_IMPL,
};

function storageWord(address: string): Hex {
  return `0x${address.slice(2).padStart(64, "0")}`;
}

function request(contract: string, abi: Abi, functionName: string, args: readonly unknown[] = []) {
  return { contract, data: encodeFunctionData({ abi, functionName, args }) };
}

const EXPECTED_REQUESTS = {
  "earn-asset": request(EARN_VAULT, erc4626Abi, "asset"),
  "earn-total-assets": request(EARN_VAULT, erc4626Abi, "totalAssets"),
  "earn-validator": request(EARN_VAULT, EARN_VAULT_ABI, "vaultValidator"),
  "earn-protocol-config": request(EARN_VAULT, EARN_VAULT_ABI, "protocolConfig"),
  "earn-pause-status": request(EARN_VAULT, EARN_VAULT_ABI, "pauseStatus"),
  "earn-pending-withdrawals": request(EARN_VAULT, EARN_VAULT_ABI, "getPendingWithdrawalsLength"),
  "earn-min-withdrawable-shares": request(EARN_VAULT, EARN_VAULT_ABI, "minWithdrawableShares"),
  "earn-withdrawal-fee": request(EARN_VALIDATOR, EARN_VALIDATOR_ABI, "withdrawalFee", [EARN_VAULT]),
  "earn-deposit-allow-list-count": request(EARN_VALIDATOR, EARN_VALIDATOR_ABI, "depositAllowListCount", [EARN_VAULT]),
  "earn-protocol-paused": request(EARN_PROTOCOL_CONFIG, EARN_PROTOCOL_CONFIG_ABI, "getProtocolPauseStatus"),
  "earn-idle-usdc": request(USDC, erc20Abi, "balanceOf", [EARN_VAULT]),
  "earn-asset-decimals": request(USDC, erc20Abi, "decimals"),
  "dstake-asset": request(DSTAKE_TOKEN, erc4626Abi, "asset"),
  "dstake-total-assets": request(DSTAKE_TOKEN, erc4626Abi, "totalAssets"),
  "dstake-router": request(DSTAKE_TOKEN, DSTAKE_TOKEN_ABI, "router"),
  "dstake-collateral-vault": request(DSTAKE_TOKEN, DSTAKE_TOKEN_ABI, "collateralVault"),
  "collateral-vault-router": request(COLLATERAL_VAULT, DSTAKE_TOKEN_ABI, "router"),
  "router-governance-module": request(DSTAKE_ROUTER, DSTAKE_ROUTER_ABI, "governanceModule"),
  "router-rebalance-module": request(DSTAKE_ROUTER, DSTAKE_ROUTER_ABI, "rebalanceModule"),
  "router-token": request(DSTAKE_ROUTER, DSTAKE_ROUTER_ABI, "dStakeToken"),
  "router-collateral-vault": request(DSTAKE_ROUTER, DSTAKE_ROUTER_ABI, "collateralVault"),
  "router-paused": request(DSTAKE_ROUTER, DSTAKE_ROUTER_ABI, "paused"),
  "router-withdrawal-fee": request(DSTAKE_ROUTER, DSTAKE_ROUTER_ABI, "withdrawalFeeBps"),
  "router-max-withdrawal-fee": request(DSTAKE_ROUTER, DSTAKE_ROUTER_ABI, "maxWithdrawalFeeBps"),
  "router-shortfall": request(DSTAKE_ROUTER, DSTAKE_ROUTER_ABI, "currentShortfall"),
  "router-active-withdrawal-vaults": request(DSTAKE_ROUTER, DSTAKE_ROUTER_ABI, "getActiveVaultsForWithdrawals"),
  "dlend-strategy-asset": request(DLEND_STRATEGY, erc4626Abi, "asset"),
  "dlend-strategy-max-withdraw": request(DLEND_STRATEGY, erc4626Abi, "maxWithdraw", [COLLATERAL_VAULT]),
  "dlend-strategy-adapter": request(DSTAKE_ROUTER, DSTAKE_ROUTER_ABI, "strategyShareToAdapter", [DLEND_STRATEGY]),
  "dlend-strategy-healthy": request(DSTAKE_ROUTER, DSTAKE_ROUTER_ABI, "isVaultHealthyForWithdrawals", [DLEND_STRATEGY]),
  "dlend-pool": request(DLEND_STRATEGY, STATIC_ATOKEN_ABI, "POOL"),
  "dlend-atoken": request(DLEND_STRATEGY, STATIC_ATOKEN_ABI, "aToken"),
  "dlend-available-liquidity": request(DUSD, erc20Abi, "balanceOf", [DLEND_ATOKEN]),
  "dstake-asset-decimals": request(DUSD, erc20Abi, "decimals"),
  "susn-asset": request(NOON_SUSN_VAULT, erc4626Abi, "asset"),
  "susn-total-assets": request(NOON_SUSN_VAULT, erc4626Abi, "totalAssets"),
  "susn-vault-paused": request(NOON_SUSN_VAULT, NOON_SUSN_VAULT_ABI, "paused"),
  "susn-idle-usn": request(USN_NOON, erc20Abi, "balanceOf", [NOON_SUSN_VAULT]),
  "susn-asset-decimals": request(USN_NOON, erc20Abi, "decimals"),
  "handler-usn": request(NOON_WITHDRAWAL_HANDLER, NOON_SUSN_WITHDRAWAL_HANDLER_ABI, "usn"),
  "handler-withdraw-period": request(
    NOON_WITHDRAWAL_HANDLER,
    NOON_SUSN_WITHDRAWAL_HANDLER_ABI,
    "withdrawPeriod",
  ),
} satisfies Record<string, { contract: string; data: Hex }>;

function verifyRequests(calls: readonly EvmMulticall3Call[]) {
  for (const call of calls) {
    const expected = EXPECTED_REQUESTS[call.label as keyof typeof EXPECTED_REQUESTS];
    if (!expected || call.target.toLowerCase() !== expected.contract || call.callData.toLowerCase() !== expected.data) {
      throw new Error(`Unexpected executable request ${call.label}: ${JSON.stringify(call)}`);
    }
  }
}

interface EarnOverrides {
  withdrawalsPaused?: boolean;
}

function earnResults(calls: readonly EvmMulticall3Call[], overrides: EarnOverrides = {}): EvmMulticall3Result[] {
  verifyRequests(calls);
  const values: Record<string, Hex> = {
    "earn-asset": encodeFunctionResult({ abi: erc4626Abi, functionName: "asset", result: USDC }),
    "earn-total-assets": encodeFunctionResult({
      abi: erc4626Abi,
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
      result: [false, overrides.withdrawalsPaused ?? false, false],
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
      abi: erc20Abi,
      functionName: "balanceOf",
      result: 199_000_000n,
    }),
    "earn-asset-decimals": encodeFunctionResult({
      abi: erc20Abi,
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
  router?: Hex;
  governanceModule?: Hex;
  shortfall?: bigint;
  availableLiquidity?: bigint;
}

function dStakeResults(
  calls: readonly EvmMulticall3Call[],
  overrides: DStakeOverrides = {},
): EvmMulticall3Result[] {
  verifyRequests(calls);
  const dlendMaxWithdraw = 192_389_829_956_990_993_894_191n;
  const values: Record<string, Hex> = {
    "dstake-asset": encodeFunctionResult({ abi: erc4626Abi, functionName: "asset", result: DUSD }),
    "dstake-total-assets": encodeFunctionResult({
      abi: erc4626Abi,
      functionName: "totalAssets",
      result: 384_250_417_697_649_081_255_185n,
    }),
    "dstake-router": encodeFunctionResult({
      abi: DSTAKE_TOKEN_ABI,
      functionName: "router",
      result: overrides.router ?? DSTAKE_ROUTER,
    }),
    "dstake-collateral-vault": encodeFunctionResult({
      abi: DSTAKE_TOKEN_ABI,
      functionName: "collateralVault",
      result: COLLATERAL_VAULT,
    }),
    "collateral-vault-router": encodeFunctionResult({ abi: DSTAKE_TOKEN_ABI, functionName: "router", result: DSTAKE_ROUTER }),
    "router-governance-module": encodeFunctionResult({ abi: DSTAKE_ROUTER_ABI, functionName: "governanceModule", result: overrides.governanceModule ?? GOVERNANCE_MODULE }),
    "router-rebalance-module": encodeFunctionResult({ abi: DSTAKE_ROUTER_ABI, functionName: "rebalanceModule", result: REBALANCE_MODULE }),
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
      result: overrides.shortfall ?? 0n,
    }),
    "router-active-withdrawal-vaults": encodeFunctionResult({
      abi: DSTAKE_ROUTER_ABI,
      functionName: "getActiveVaultsForWithdrawals",
      result: overrides.activeWithdrawalVaults ?? [DLEND_STRATEGY],
    }),
    "dlend-strategy-asset": encodeFunctionResult({
      abi: erc4626Abi,
      functionName: "asset",
      result: DUSD,
    }),
    "dlend-strategy-max-withdraw": encodeFunctionResult({
      abi: erc4626Abi,
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
      abi: erc20Abi,
      functionName: "balanceOf",
      result: overrides.availableLiquidity ?? dlendMaxWithdraw + 1n,
    }),
    "dstake-asset-decimals": encodeFunctionResult({
      abi: erc20Abi,
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

interface SusnNoonOverrides {
  vaultPaused?: boolean;
  withdrawPeriod?: bigint;
  failWithdrawPeriodRead?: boolean;
}

function susnNoonResults(
  calls: readonly EvmMulticall3Call[],
  overrides: SusnNoonOverrides = {},
): EvmMulticall3Result[] {
  verifyRequests(calls);
  const totalAssets = 35_610_286_304_365_360_371_879_357n;
  const values: Record<string, Hex> = {
    "susn-asset": encodeFunctionResult({ abi: erc4626Abi, functionName: "asset", result: USN_NOON }),
    "susn-total-assets": encodeFunctionResult({
      abi: erc4626Abi,
      functionName: "totalAssets",
      result: totalAssets,
    }),
    "susn-vault-paused": encodeFunctionResult({
      abi: NOON_SUSN_VAULT_ABI,
      functionName: "paused",
      result: overrides.vaultPaused ?? false,
    }),
    "susn-idle-usn": encodeFunctionResult({
      abi: erc20Abi,
      functionName: "balanceOf",
      result: totalAssets,
    }),
    "susn-asset-decimals": encodeFunctionResult({ abi: erc20Abi, functionName: "decimals", result: 18 }),
    "handler-usn": encodeFunctionResult({
      abi: NOON_SUSN_WITHDRAWAL_HANDLER_ABI,
      functionName: "usn",
      result: USN_NOON,
    }),
    "handler-withdraw-period": encodeFunctionResult({
      abi: NOON_SUSN_WITHDRAWAL_HANDLER_ABI,
      functionName: "withdrawPeriod",
      result: overrides.withdrawPeriod ?? 604_800n,
    }),
  };
  return calls.map((call) => ({
    label: call.label,
    success: !(overrides.failWithdrawPeriodRead && call.label === "handler-withdraw-period"),
    returnData: values[call.label]!,
  }));
}

function client(
  coin: "earn" | "dstake" | "noon",
  options: {
    driftAddress?: string;
    dStakeOverrides?: DStakeOverrides;
    earnOverrides?: EarnOverrides;
    susnNoonOverrides?: SusnNoonOverrides;
    handlerPointer?: Hex | null;
  } = {},
): ExecutableRedemptionReadClient {
  return {
    blockNumber: vi.fn().mockResolvedValue(BLOCK),
    blockTimestamp: vi.fn().mockImplementation(async (block: number) => {
      if (block !== BLOCK) throw new Error(`Unexpected timestamp block ${block}`);
      return NOW - 30;
    }),
    codeHash: vi.fn().mockImplementation(async (address: string, block: number) => {
      if (block !== BLOCK) throw new Error(`Unexpected code block ${block}`);
      return address.toLowerCase() === options.driftAddress?.toLowerCase()
        ? `0x${"f".repeat(64)}`
        : CODE_HASH_BY_ADDRESS[address.toLowerCase()] ?? null;
    }),
    storage: vi.fn().mockImplementation(async (address: string, slot: string, block: number) => {
      if (block !== BLOCK) throw new Error(`Unexpected storage observation ${slot} at ${block}`);
      if (slot === NOON_HANDLER_SLOT) {
        return options.handlerPointer === undefined
          ? storageWord(NOON_WITHDRAWAL_HANDLER)
          : options.handlerPointer;
      }
      if (slot !== EIP1967_IMPLEMENTATION_SLOT) {
        throw new Error(`Unexpected storage observation ${slot}`);
      }
      const implementation = IMPLEMENTATION_BY_PROXY[address.toLowerCase()];
      return implementation ? storageWord(implementation) : null;
    }),
    multicall: vi.fn().mockImplementation(async (calls: readonly EvmMulticall3Call[], block: number) => {
      if (block !== BLOCK) throw new Error(`Unexpected multicall block ${block}`);
      return coin === "earn"
        ? earnResults(calls, options.earnOverrides)
        : coin === "noon"
          ? susnNoonResults(calls, options.susnNoonOverrides)
          : dStakeResults(calls, options.dStakeOverrides);
    }),
  };
}

describe("specialized executable redemption observers", () => {
  it("reads from a stable block behind the latest announced Ethereum head", () => {
    expect(getStableObservationBlockNumber(BLOCK)).toBe(BLOCK - 2);
    expect(getStableObservationBlockNumber(null)).toBeNull();
  });

  it.each([
    ["eearn-ember", EARN_VAULT, "earn"],
    ["sdusd-dtrinity", DSTAKE_TOKEN, "dstake"],
  ] as const)(
    "validates %s current-block freshness against wall time instead of the reserve-run start",
    async (coinId, contractAddress, clientKind) => {
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(NOW * 1_000);
      try {
        const observation = await observeExecutableRedemptionRoute(
          coinId,
          contractAddress,
          new AbortController().signal,
          { nowSec: NOW - 180 },
          { client: client(clientKind) },
        );

        expect(observation?.sourceTimestamp).toBe(NOW - 30);
      } finally {
        nowSpy.mockRestore();
      }
    },
  );

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
      settlementBoundUnproven: true,
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

  it("withholds the unproven-settlement-bound marker when eEARN withdrawals are paused", async () => {
    const observation = await observeExecutableRedemptionRoute(
      "eearn-ember",
      EARN_VAULT,
      new AbortController().signal,
      undefined,
      { client: client("earn", { earnOverrides: { withdrawalsPaused: true } }), nowSec: NOW },
    );

    // A paused queue is a measured pause, not an evidence gap: the zero stays
    // a measured zero and V9 keeps the no-viable-exit-path treatment.
    expect(observation).toMatchObject({ capacityRaw: 0n, routeStatus: "paused" });
    expect(observation).not.toHaveProperty("settlementBoundUnproven");
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
            driftAddress: "0x9b2e2eef7ffe1b15ca8c61e65538b51ca8977c7e",
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
        routerAddress: DSTAKE_ROUTER,
        activeWithdrawalVaults: [DLEND_STRATEGY],
        governanceModuleAddress: GOVERNANCE_MODULE,
        rebalanceModuleAddress: REBALANCE_MODULE,
        dlendStrategyMaxWithdrawRaw: "192389829956990993894191",
        dlendAvailableLiquidityRaw: "192389829956990993894192",
        currentWithdrawalFeeRaw: "1000",
      },
    });
  });

  it("publishes the measured idle USN with the live 7-day withdrawPeriod bound", async () => {
    const observation = await observeExecutableRedemptionRoute(
      "susn-noon",
      NOON_SUSN_VAULT,
      new AbortController().signal,
      undefined,
      { client: client("noon"), nowSec: NOW },
    );

    expect(observation).toMatchObject({
      capacityRaw: 35_610_286_304_365_360_371_879_357n,
      capacitySource: "noon-susn-withdrawal-handler-idle-usn",
      capacityKind: "live-direct-bounded",
      settlementDelaySec: 604_800,
      routeStatus: "open",
      routeStatusSource: "onchain",
      holderEligibility: "any-holder",
      blockNumber: BLOCK,
      sourceTimestamp: NOW - 30,
      diagnostics: {
        withdrawalHandlerAddress: NOON_WITHDRAWAL_HANDLER,
        withdrawPeriodSec: 604_800,
        vaultPaused: false,
      },
    });
    expect(observation).not.toHaveProperty("settlementBoundUnproven");
  });

  it("fails susn-noon closed on withdrawal-handler pointer drift", async () => {
    await expect(observeExecutableRedemptionRoute(
      "susn-noon",
      NOON_SUSN_VAULT,
      new AbortController().signal,
      undefined,
      { client: client("noon", { handlerPointer: storageWord(USN_NOON) }), nowSec: NOW },
    )).rejects.toThrow(/withdrawal-handler pointer/);
  });

  it.each([
    { failWithdrawPeriodRead: true },
    { withdrawPeriod: 2n ** 60n },
  ] satisfies SusnNoonOverrides[])(
    "leaves the susn-noon settlement bound unknown when the live read fails or is out of range: %o",
    async (susnNoonOverrides) => {
      await expect(observeExecutableRedemptionRoute(
        "susn-noon",
        NOON_SUSN_VAULT,
        new AbortController().signal,
        undefined,
        { client: client("noon", { susnNoonOverrides }), nowSec: NOW },
      )).rejects.toThrow(/failed closed/);
    },
  );

  it("publishes a measured zero with the live bound while the noon vault is paused", async () => {
    const observation = await observeExecutableRedemptionRoute(
      "susn-noon",
      NOON_SUSN_VAULT,
      new AbortController().signal,
      undefined,
      { client: client("noon", { susnNoonOverrides: { vaultPaused: true } }), nowSec: NOW },
    );
    expect(observation).toMatchObject({ capacityRaw: 0n, routeStatus: "paused", settlementDelaySec: 604_800 });
  });

  it.each([DSTAKE_ROUTER, GOVERNANCE_MODULE, REBALANCE_MODULE])("rejects unreviewed dTRINITY code at %s", async (driftAddress) => {
    await expect(observeExecutableRedemptionRoute(
      "sdusd-dtrinity", DSTAKE_TOKEN, new AbortController().signal, undefined,
      { client: client("dstake", { driftAddress }), nowSec: NOW },
    )).rejects.toThrow(/code identity drift/);
  });

  it.each([
    { router: "0xdd26c236ec95d03ddf3cb67b7f54864719e9be5a" as Hex },
    { governanceModule: IDLE_STRATEGY },
    { activeWithdrawalVaults: [IDLE_STRATEGY, DLEND_STRATEGY] },
    { availableLiquidity: 1n },
  ] satisfies DStakeOverrides[])("rejects retired or unreviewed dTRINITY dependencies and invalid liquidity: %o", async (dStakeOverrides) => {
    await expect(observeExecutableRedemptionRoute(
      "sdusd-dtrinity", DSTAKE_TOKEN, new AbortController().signal, undefined,
      { client: client("dstake", { dStakeOverrides }), nowSec: NOW },
    )).rejects.toThrow(/drift|invalid dLEND/);
  });

  it("publishes zero executable capacity while dTRINITY reports a shortfall", async () => {
    const observation = await observeExecutableRedemptionRoute(
      "sdusd-dtrinity", DSTAKE_TOKEN, new AbortController().signal, undefined,
      { client: client("dstake", { dStakeOverrides: { shortfall: 1n } }), nowSec: NOW },
    );
    expect(observation).toMatchObject({ routeStatus: "degraded", capacityRaw: 0n });
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
