import { decodeAbiParameters, keccak256 } from "viem/utils";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import { encodeAddress } from "../../lib/evm-selectors";
import { fetchJsonWithRetry } from "./request";
import {
  decodeMulticall3Aggregate3Result,
  encodeMulticall3Aggregate3CallData,
  fetchEvmRpcBatch,
  MULTICALL3_ADDRESS,
  type EvmRpcBatchCall,
} from "../../lib/evm-rpc";
import {
  buildRedemptionSnapshotMetadata,
  decimalNumberFromBigInt,
  notApplicableFreshnessMetadata,
} from "./helpers";
import { runAdapterIo } from "./concurrency";
import { decodeStrictAddressWord, decodeStrictBoolWord, decodeUint256Word } from "./abi-decode";

const ADAPTER_KEY = "anzen-usdz";
const SPCT_POOL_CONTRACT = "0xf30a29F1C540724Fd8c5c4Be1AF604a6C6800D29";
const SPCT_POOL_DECIMALS = 18;
const SUPPLY_CHAINS = ["ethereum", "base", "arbitrum", "blast", "manta"] as const;
type SupportedSupplyChain = (typeof SUPPLY_CHAINS)[number];

const EXPECTED_DEPLOYMENTS: Record<SupportedSupplyChain, {
  address: string;
  decimals: number;
  runtimeCodeHash: string;
}> = {
  ethereum: {
    address: "0xa469b7ee9ee773642b3e93e842e5d9b5baa10067",
    decimals: 18,
    runtimeCodeHash: "0x362165471d41a934b39e4b4ae9f54b35faa8835087f182881c2ba79756183ebd",
  },
  base: {
    address: "0x04d5ddf5f3a8939889f11e97f8c4bb48317f1938",
    decimals: 18,
    runtimeCodeHash: "0x313c96fdfbc97ae74b42b004cfb2f42384221747fc9d4e4dc983c75e5797350c",
  },
  arbitrum: {
    address: "0x5018609ab477cc502e170a5accf5312b86a4b94f",
    decimals: 18,
    runtimeCodeHash: "0x6ff74d8b44325ccad039711f6301af381f62a10a113d97fd8ae262dcd197fbeb",
  },
  blast: {
    address: "0x52056ed29fe015f4ba2e3b079d10c0b87f46e8c6",
    decimals: 18,
    runtimeCodeHash: "0xc873093927468efb942cd20c27b87ffb3df6f5c74e7db1467c3fe18619eb16ab",
  },
  manta: {
    address: "0x73d23f3778a90be8846e172354a115543df2a7e4",
    decimals: 18,
    runtimeCodeHash: "0x7991d52bae7602ae657da20ec722afa2e060aa0c76486c2e409619d2743e6eab",
  },
};

// USDz's Ethereum/Base OFT pair is the only LayerZero graph accepted here.
const LAYERZERO_METADATA_URL = "https://metadata.layerzero-api.com/v1/metadata/experiment/ofts/list?symbols=USDz";
const LAYERZERO_ENDPOINT = "0x1a44076050125825900e736c501f859c50fe728c";
const LAYERZERO_SHARED_DECIMALS = 8;

// USDz.redeem() pays USDC out of the USDz contract after pulling it from the
// SPCT pool. These identities and route controls are read in the same
// Ethereum batch as pooledSPCT and the reserve/liability facts.
const USDC_CONTRACT = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDC_DECIMALS = 6;
const SPCT_PRICE_ORACLE_CONTRACT = "0x900fff3bbf47ded50fd4940d055e1324f38b0d4f";
const ANZEN_REDEEM_DOC_URL = "https://docs.anzen.finance/usdz-101/overview";
const SPCT_RUNTIME_CODE_HASH = "0xe72ed6f9f3222f61a7901b61e2a44bd7869bf79ac4146c777a97226137baeeaf";

const TOTAL_SUPPLY_SELECTOR = "0x18160ddd";
const SYMBOL_SELECTOR = "0x95d89b41";
const DECIMALS_SELECTOR = "0x313ce567";
const USDZ_USDC_SELECTOR = "0x3e413bee";
const USDZ_SPCT_SELECTOR = "0x090a1cc8";
const USDZ_ORACLE_SELECTOR = "0x7dc0d1d0";
const USDZ_ENDPOINT_SELECTOR = "0x5e280f11";
const USDZ_COLLATERAL_RATE_SELECTOR = "0x58a6be1c";
const USDZ_MODE_SELECTOR = "0x295a5212";
const PAUSED_SELECTOR = "0x5c975abb";
const REDEEM_FEE_RATE_SELECTOR = "0x5872e6fa";
const FEE_COEFFICIENT_SELECTOR = "0xf05a6b6d";
const SPCT_RESERVE_USD_SELECTOR = "0x664692f2";
const SPCT_IS_WHITELIST_SELECTOR = "0xc683630d";
const BALANCE_OF_SELECTOR = "0x70a08231";
const ORACLE_GET_PRICE_SELECTOR = "0x98d5fdca";

interface AnzenRedemptionProbe {
  capacityUsd: number;
  reserveUsdRaw: string;
  spctUsdcRaw: string;
  usdzUsdcRaw: string;
  routeOpen: boolean;
  feeBps: number | null;
}

interface ChainObservation {
  chain: SupportedSupplyChain;
  address: string;
  rawSupply: bigint;
  symbol: string;
  decimals: number;
  endpoint: string | null;
  codeHash: string;
  values: Map<string, `0x${string}`>;
}

interface LayerZeroMetadata {
  USDz?: Array<{
    sharedDecimals?: number;
    endpointVersion?: string;
    deployments?: Record<string, { address?: string; localDecimals?: number; type?: string }>;
  }>;
}

function getRequiredContract(coin: StablecoinMeta, chain: SupportedSupplyChain): { address: string; decimals: number } {
  const contract = coin.contracts?.find((entry) => entry.chain === chain);
  if (!contract) throw new Error(`${ADAPTER_KEY} missing ${chain} contract metadata for ${coin.id}`);
  const expected = EXPECTED_DEPLOYMENTS[chain];
  if (contract.address.toLowerCase() !== expected.address || contract.decimals !== expected.decimals) {
    throw new Error(`${ADAPTER_KEY} ${chain} contract metadata drifted for ${coin.id}`);
  }
  return { address: contract.address, decimals: contract.decimals };
}

function assertContractInventory(coin: StablecoinMeta): void {
  const contracts = coin.contracts ?? [];
  const actual = contracts.map((entry) => `${entry.chain}:${entry.address.toLowerCase()}`).sort();
  const expected = SUPPLY_CHAINS.map((chain) => `${chain}:${EXPECTED_DEPLOYMENTS[chain].address}`).sort();
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`${ADAPTER_KEY} configured coin-contract set is not the reviewed five-chain set`);
  }
}

function encodeAddressCall(selector: string, address: string): string {
  return `${selector}${encodeAddress(address)}`;
}

function wordCall(label: string, contract: string, data: string, allowFailure = false) {
  return { label, contract, data, allowFailure } as const;
}

function buildStateCalls(chain: SupportedSupplyChain, usdz: string) {
  const calls = [
    wordCall("usdz:total-supply", usdz, TOTAL_SUPPLY_SELECTOR),
    wordCall("usdz:decimals", usdz, DECIMALS_SELECTOR),
    wordCall("usdz:symbol", usdz, SYMBOL_SELECTOR),
    wordCall("usdz:endpoint", usdz, USDZ_ENDPOINT_SELECTOR, true),
  ];
  if (chain !== "ethereum") return calls;

  calls.push(
    wordCall("usdz:total-pooled-spct", usdz, "0x8abb1eb4"),
    wordCall("usdz:spct", usdz, USDZ_SPCT_SELECTOR),
    wordCall("usdz:usdc", usdz, USDZ_USDC_SELECTOR),
    wordCall("usdz:oracle", usdz, USDZ_ORACLE_SELECTOR),
    wordCall("usdz:paused", usdz, PAUSED_SELECTOR),
    wordCall("usdz:collateral-rate", usdz, USDZ_COLLATERAL_RATE_SELECTOR),
    wordCall("usdz:mode", usdz, USDZ_MODE_SELECTOR),
    wordCall("usdz:redeem-fee-rate", usdz, REDEEM_FEE_RATE_SELECTOR),
    wordCall("usdz:fee-coefficient", usdz, FEE_COEFFICIENT_SELECTOR),
    wordCall("spct:balance-of-usdz", SPCT_POOL_CONTRACT, encodeAddressCall(BALANCE_OF_SELECTOR, usdz)),
    wordCall("spct:reserve-usd", SPCT_POOL_CONTRACT, SPCT_RESERVE_USD_SELECTOR),
    wordCall("spct:paused", SPCT_POOL_CONTRACT, PAUSED_SELECTOR),
    wordCall("spct:redeem-fee-rate", SPCT_POOL_CONTRACT, REDEEM_FEE_RATE_SELECTOR),
    wordCall("spct:fee-coefficient", SPCT_POOL_CONTRACT, FEE_COEFFICIENT_SELECTOR),
    wordCall("spct:usdz-whitelisted", SPCT_POOL_CONTRACT, encodeAddressCall(SPCT_IS_WHITELIST_SELECTOR, usdz)),
    wordCall("usdc:spct-balance", USDC_CONTRACT, encodeAddressCall(BALANCE_OF_SELECTOR, SPCT_POOL_CONTRACT)),
    wordCall("usdc:usdz-balance", USDC_CONTRACT, encodeAddressCall(BALANCE_OF_SELECTOR, usdz)),
    wordCall("oracle:price", SPCT_PRICE_ORACLE_CONTRACT, ORACLE_GET_PRICE_SELECTOR),
  );
  return calls;
}

function decodeString(raw: `0x${string}` | undefined, label: string): string {
  if (!raw) throw new Error(`${ADAPTER_KEY} ${label} read failed`);
  try {
    const [value] = decodeAbiParameters([{ type: "string" }], raw);
    if (typeof value !== "string" || value.length === 0) throw new Error("empty string");
    return value;
  } catch {
    throw new Error(`${ADAPTER_KEY} ${label} returned malformed data`);
  }
}

function requireWord(values: Map<string, `0x${string}`>, label: string): `0x${string}` {
  const value = values.get(label);
  if (!value) throw new Error(`${ADAPTER_KEY} ${label} read failed`);
  return value;
}

function requireUint(values: Map<string, `0x${string}`>, label: string): bigint {
  const value = decodeUint256Word(requireWord(values, label));
  if (value == null) throw new Error(`${ADAPTER_KEY} ${label} returned malformed data`);
  return value;
}

function requireBool(values: Map<string, `0x${string}`>, label: string): boolean {
  const value = decodeStrictBoolWord(requireWord(values, label));
  if (value == null) throw new Error(`${ADAPTER_KEY} ${label} returned malformed bool`);
  return value;
}

function requireAddress(values: Map<string, `0x${string}`>, label: string): string {
  const value = decodeStrictAddressWord(requireWord(values, label));
  if (!value) throw new Error(`${ADAPTER_KEY} ${label} returned malformed address`);
  return value.toLowerCase();
}

function combinedRedeemFeeBps(
  usdzRate: bigint,
  usdzCoefficient: bigint,
  spctRate: bigint,
  spctCoefficient: bigint,
): number {
  if (usdzCoefficient <= 0n || spctCoefficient <= 0n) throw new Error(`${ADAPTER_KEY} invalid fee coefficient`);
  if (usdzRate > usdzCoefficient || spctRate > spctCoefficient) {
    throw new Error(`${ADAPTER_KEY} redeem fee exceeds configured coefficient`);
  }
  const denominator = usdzCoefficient * spctCoefficient;
  const retained = (usdzCoefficient - usdzRate) * (spctCoefficient - spctRate);
  return Number(((denominator - retained) * 10_000n + denominator / 2n) / denominator);
}

function decodeChainObservation(
  chain: SupportedSupplyChain,
  contract: { address: string; decimals: number },
  code: unknown,
  aggregate: unknown,
  calls: ReturnType<typeof buildStateCalls>,
): ChainObservation {
  if (typeof code !== "string" || !/^0x[0-9a-f]+$/i.test(code) || code === "0x") {
    throw new Error(`${ADAPTER_KEY} ${chain} runtime code is unavailable`);
  }
  const codeHash = keccak256(code as `0x${string}`).toLowerCase();
  if (codeHash !== EXPECTED_DEPLOYMENTS[chain].runtimeCodeHash) {
    throw new Error(`${ADAPTER_KEY} ${chain} runtime code hash drifted`);
  }
  if (typeof aggregate !== "string") throw new Error(`${ADAPTER_KEY} ${chain} state batch is unavailable`);
  const decoded = decodeMulticall3Aggregate3Result(
    aggregate as `0x${string}`,
    calls.map((call) => call.label),
  );
  if (!decoded || decoded.length !== calls.length) throw new Error(`${ADAPTER_KEY} ${chain} state batch is malformed`);
  const values = new Map<string, `0x${string}`>();
  for (const result of decoded) {
    if (!result.success && result.label !== "usdz:endpoint") {
      throw new Error(`${ADAPTER_KEY} ${chain} ${result.label} call failed`);
    }
    if (result.success) values.set(result.label, result.returnData);
  }
  const rawSupply = requireUint(values, "usdz:total-supply");
  const decimalsRaw = requireUint(values, "usdz:decimals");
  const symbol = decodeString(values.get("usdz:symbol"), `${chain} symbol()`);
  const endpoint = values.has("usdz:endpoint") ? requireAddress(values, "usdz:endpoint") : null;
  if (rawSupply <= 0n || decimalsRaw !== BigInt(contract.decimals) || symbol !== "USDz") {
    throw new Error(`${ADAPTER_KEY} ${chain} USDz identity or supply is invalid`);
  }
  if ((chain === "ethereum" || chain === "base") && endpoint !== LAYERZERO_ENDPOINT) {
    throw new Error(`${ADAPTER_KEY} ${chain} LayerZero endpoint drifted (${endpoint ?? "missing"})`);
  }
  return {
    chain,
    address: contract.address.toLowerCase(),
    rawSupply,
    symbol,
    decimals: Number(decimalsRaw),
    endpoint,
    codeHash,
    values,
  };
}

async function readChain(
  chain: SupportedSupplyChain,
  contract: { address: string; decimals: number },
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<ChainObservation> {
  const stateCalls = buildStateCalls(chain, contract.address);
  const rpcCalls: EvmRpcBatchCall[] = [
    { method: "eth_getCode", params: [contract.address, "latest"] },
  ];
  if (chain === "ethereum") {
    rpcCalls.push(
      { method: "eth_getCode", params: [SPCT_POOL_CONTRACT, "latest"] },
      { method: "eth_getCode", params: [SPCT_PRICE_ORACLE_CONTRACT, "latest"] },
      { method: "eth_getCode", params: [USDC_CONTRACT, "latest"] },
    );
  }
  rpcCalls.push({
    method: "eth_call",
    params: [
      {
        to: MULTICALL3_ADDRESS,
        data: encodeMulticall3Aggregate3CallData(stateCalls.map((call) => ({
          label: call.label,
          target: call.contract,
          callData: call.data,
          allowFailure: call.allowFailure,
        }))),
      },
      "latest",
    ],
  });
  const responses = await runAdapterIo(ctx, `${ADAPTER_KEY}:rpc:${chain}`, () => fetchEvmRpcBatch(
    chain,
    rpcCalls,
    { signal, timeoutMs: 12_000, maxRetries: 0 },
  ), { signal });
  if (!responses || responses.length !== rpcCalls.length) throw new Error(`${ADAPTER_KEY} ${chain} RPC batch failed`);
  if (chain === "ethereum") {
    for (const [index, expected] of [SPCT_RUNTIME_CODE_HASH].entries()) {
      const code = responses[index + 1];
      if (typeof code !== "string" || keccak256(code as `0x${string}`).toLowerCase() !== expected) {
        throw new Error(`${ADAPTER_KEY} Ethereum supporting contract code hash drifted`);
      }
    }
  }
  return decodeChainObservation(chain, contract, responses[0], responses[responses.length - 1], stateCalls);
}

async function fetchLayerZeroMetadata(signal: AbortSignal, ctx?: AdapterContext): Promise<LayerZeroMetadata> {
  const response = await fetchJsonWithRetry<LayerZeroMetadata>(
    LAYERZERO_METADATA_URL,
    signal,
    12_000,
    ctx,
    { headers: { Accept: "application/json" }, maxRetries: 0, maxResponseBytes: 64 * 1024 },
  );
  const entry = response.USDz;
  if (!Array.isArray(entry) || entry.length !== 1) throw new Error(`${ADAPTER_KEY} LayerZero USDz topology is ambiguous`);
  const graph = entry[0];
  if (graph.sharedDecimals !== LAYERZERO_SHARED_DECIMALS || graph.endpointVersion !== "v2") {
    throw new Error(`${ADAPTER_KEY} LayerZero metadata version drifted`);
  }
  const deployments = graph.deployments;
  if (!deployments || Object.keys(deployments).sort().join(",") !== "base,ethereum") {
    throw new Error(`${ADAPTER_KEY} LayerZero deployment set drifted`);
  }
  for (const chain of ["ethereum", "base"] as const) {
    const deployment = deployments[chain];
    if (
      deployment?.address?.toLowerCase() !== EXPECTED_DEPLOYMENTS[chain].address ||
      deployment.localDecimals !== EXPECTED_DEPLOYMENTS[chain].decimals ||
      deployment.type !== "OFT"
    ) {
      throw new Error(`${ADAPTER_KEY} LayerZero ${chain} deployment drifted`);
    }
  }
  return response;
}

function observeAnzenRedemption(values: Map<string, `0x${string}`>): AnzenRedemptionProbe {
  if (requireAddress(values, "usdz:usdc") !== USDC_CONTRACT) throw new Error(`${ADAPTER_KEY} usdc() identity drifted`);
  if (requireAddress(values, "usdz:spct") !== SPCT_POOL_CONTRACT.toLowerCase()) throw new Error(`${ADAPTER_KEY} spct() identity drifted`);
  if (requireAddress(values, "usdz:oracle") !== SPCT_PRICE_ORACLE_CONTRACT) throw new Error(`${ADAPTER_KEY} oracle() identity drifted`);
  const usdzPaused = requireBool(values, "usdz:paused");
  const spctPaused = requireBool(values, "spct:paused");
  const whitelisted = requireBool(values, "spct:usdz-whitelisted");
  const reserveUsdRaw = requireUint(values, "spct:reserve-usd");
  const spctUsdcRaw = requireUint(values, "usdc:spct-balance");
  const usdzUsdcRaw = requireUint(values, "usdc:usdz-balance");
  const collateralRate = requireUint(values, "usdz:collateral-rate");
  const oraclePriceRaw = requireUint(values, "oracle:price");
  const mode = requireUint(values, "usdz:mode");
  if (mode !== 0n) throw new Error(`${ADAPTER_KEY} USDz is in migration mode`);
  if (requireUint(values, "usdz:total-pooled-spct") <= 0n) throw new Error(`${ADAPTER_KEY} pooled SPCT is zero`);
  if (oraclePriceRaw < collateralRate) throw new Error(`${ADAPTER_KEY} oracle price is below collateral rate`);
  const settleableRaw = spctUsdcRaw + usdzUsdcRaw;
  const bindingRaw = reserveUsdRaw < settleableRaw ? reserveUsdRaw : settleableRaw;
  const capacityUsd = decimalNumberFromBigInt(bindingRaw, USDC_DECIMALS);
  if (!Number.isFinite(capacityUsd) || capacityUsd < 0 || usdzPaused || spctPaused || !whitelisted) {
    throw new Error(`${ADAPTER_KEY} USDz redemption route is paused or unavailable`);
  }
  return {
    capacityUsd,
    reserveUsdRaw: reserveUsdRaw.toString(),
    spctUsdcRaw: spctUsdcRaw.toString(),
    usdzUsdcRaw: usdzUsdcRaw.toString(),
    routeOpen: capacityUsd > 0,
    feeBps: combinedRedeemFeeBps(
      requireUint(values, "usdz:redeem-fee-rate"),
      requireUint(values, "usdz:fee-coefficient"),
      requireUint(values, "spct:redeem-fee-rate"),
      requireUint(values, "spct:fee-coefficient"),
    ),
  };
}

export async function fetchAnzenUsdzReserves(
  coin: StablecoinMeta,
  _config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  assertContractInventory(coin);
  const contracts = Object.fromEntries(SUPPLY_CHAINS.map((chain) => [chain, getRequiredContract(coin, chain)])) as Record<SupportedSupplyChain, { address: string; decimals: number }>;
  const observations = await Promise.all([
    ...SUPPLY_CHAINS.map((chain) => readChain(chain, contracts[chain], signal, ctx)),
    fetchLayerZeroMetadata(signal, ctx),
  ]);
  const chainObservations = observations.slice(0, SUPPLY_CHAINS.length) as ChainObservation[];
  const ethereum = chainObservations.find((observation) => observation.chain === "ethereum");
  if (!ethereum) throw new Error(`${ADAPTER_KEY} Ethereum observation missing`);
  const redemption = observeAnzenRedemption(ethereum.values);
  const pooledSpctRaw = requireUint(ethereum.values, "usdz:total-pooled-spct");
  const heldSpctRaw = requireUint(ethereum.values, "spct:balance-of-usdz");
  if (heldSpctRaw < pooledSpctRaw) throw new Error(`${ADAPTER_KEY} held SPCT is below totalPooledSPCT()`);
  const liabilityRaw = chainObservations.reduce((sum, observation) => sum + observation.rawSupply, 0n);
  if (pooledSpctRaw < liabilityRaw) throw new Error(`${ADAPTER_KEY} pooled SPCT is below USDz liabilities`);
  const surplusRaw = pooledSpctRaw - liabilityRaw;
  const toleranceRaw = (liabilityRaw / 10_000n) > 1_000n * 10n ** 18n
    ? liabilityRaw / 10_000n
    : 1_000n * 10n ** 18n;
  if (surplusRaw > toleranceRaw) throw new Error(`${ADAPTER_KEY} pooled SPCT surplus exceeds reviewed tolerance`);

  const supplyByChainUsd = Object.fromEntries(chainObservations.map((observation) => [
    observation.chain,
    decimalNumberFromBigInt(observation.rawSupply, observation.decimals),
  ])) as Record<SupportedSupplyChain, number>;
  const supplyUsd = decimalNumberFromBigInt(liabilityRaw, SPCT_POOL_DECIMALS);
  const totalReserveUsd = decimalNumberFromBigInt(pooledSpctRaw, SPCT_POOL_DECIMALS);
  if (!Number.isFinite(supplyUsd) || supplyUsd <= 0 || !Number.isFinite(totalReserveUsd) || totalReserveUsd <= 0) {
    throw new Error(`${ADAPTER_KEY} computed invalid USDz reserve totals`);
  }

  return {
    slices: [{ name: "SPCT (Secured Private Credit Token)", pct: 100, risk: "high" }],
    metadata: {
      ...notApplicableFreshnessMetadata({
        proofKind: "multichain-usdz-pooled-spct-v2",
        reserveSourceLabel: "USDz totalPooledSPCT() reconciled to held SPCT",
        supplySourceLabel: "USDz totalSupply() across reviewed OFT/native deployments",
      }),
      totalReserveUsd,
      supplyUsd,
      collateralizationRatio: totalReserveUsd / supplyUsd,
      details: {
        proofKind: "multichain-usdz-pooled-spct-v2",
        reserveSourceLabel: "USDz totalPooledSPCT() reconciled to held SPCT",
        supplySourceLabel: "USDz totalSupply() across reviewed OFT/native deployments",
        reserveContract: SPCT_POOL_CONTRACT,
        reserveChain: "ethereum",
        accountedSpctRaw: pooledSpctRaw.toString(),
        heldSpctRaw: heldSpctRaw.toString(),
        liabilityRaw: liabilityRaw.toString(),
        surplusSpct: decimalNumberFromBigInt(surplusRaw, SPCT_POOL_DECIMALS),
        underlyingLoanBookScope: "outside adapter composition scope",
        supplyByChainUsd,
        supplyChains: SUPPLY_CHAINS,
        redemption: {
          proofKind: "usdz-redeem-spct-reserve-and-usdc-settlement",
          spctReserveUsdRaw: redemption.reserveUsdRaw,
          spctUsdcBalanceRaw: redemption.spctUsdcRaw,
          usdzUsdcBalanceRaw: redemption.usdzUsdcRaw,
          usdcDecimals: USDC_DECIMALS,
          routeOpen: redemption.routeOpen,
        },
      },
      ...buildRedemptionSnapshotMetadata({
        capacityUsd: redemption.capacityUsd,
        capacityKind: "live-direct",
        freshnessKind: "same-run-onchain",
        holderEligibility: "any-holder",
        settlementDelaySec: 0,
        ...(redemption.routeOpen
          ? {
              routeStatus: "open" as const,
              routeStatusSource: "onchain" as const,
              routeStatusReason:
                `USDz redeem() read in the same run: reserveUSD() is ${redemption.reserveUsdRaw} and the SPCT pool plus USDz hold ` +
                `${redemption.spctUsdcRaw} + ${redemption.usdzUsdcRaw} USDC (6 decimals)`,
            }
          : {}),
        feeBps: redemption.feeBps,
        sourceUrls: [ANZEN_REDEEM_DOC_URL],
      }),
    },
  };
}
