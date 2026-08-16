import { decodeAbiParameters, keccak256 } from "viem/utils";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import { encodeAddress } from "../../lib/evm-selectors";
import { fetchJsonWithRetry } from "./request";
import {
  decodeMulticall3Aggregate3Result,
  encodeMulticall3Aggregate3CallData,
  fetchEvmCallHexAtBlock,
  fetchEvmCodeAtBlock,
  MULTICALL3_ADDRESS,
} from "../../lib/evm-rpc";
import { getPublicFallbackRpcUrls } from "../../lib/public-rpc-registry";
import {
  buildRedemptionSnapshotMetadata,
  decimalNumberFromBigInt,
  notApplicableFreshnessMetadata,
} from "./helpers";
import { runAdapterIo } from "./concurrency";
import { decodeStrictAddressWord, decodeStrictBoolWord, decodeUint256Word } from "./abi-decode";
import {
  addressObservation,
  customObservation,
  executeEvmObservationPlan,
  rawObservation,
  uint256Observation,
  type AnyEvmObservationField,
} from "./evm-observation-plan";

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
// Ethereum Multicall3 request as pooledSPCT and the reserve/liability facts.
const USDC_CONTRACT = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDC_DECIMALS = 6;
const SPCT_PRICE_ORACLE_CONTRACT = "0x900fff3bbf47ded50fd4940d055e1324f38b0d4f";
const ANZEN_REDEEM_DOC_URL = "https://docs.anzen.finance/usdz-101/overview";
const SPCT_RUNTIME_CODE_HASH = "0xe72ed6f9f3222f61a7901b61e2a44bd7869bf79ac4146c777a97226137baeeaf";
const ANZEN_ETHEREUM_FALLBACK_RPC_URL = "https://eth.drpc.org";
const RPC_ATTEMPT_BUDGET_MS = 20_000;
const RPC_DEADLINE_HEADROOM_MS = 2_000;
const RPC_REQUEST_TIMEOUT_MS = 4_000;

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
  values: ReadonlyMap<string, `0x${string}`>;
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

function getAdapterRpcUrls(chain: SupportedSupplyChain): string[] {
  const registered = getPublicFallbackRpcUrls(chain);
  if (chain !== "ethereum") return registered;
  return Array.from(new Set([registered[0], ANZEN_ETHEREUM_FALLBACK_RPC_URL].filter((url): url is string => Boolean(url))));
}

function buildStateFields(chain: SupportedSupplyChain, usdz: string) {
  const fields: AnyEvmObservationField[] = [
    uint256Observation({
      label: "usdz:total-supply",
      contract: usdz,
      data: TOTAL_SUPPLY_SELECTOR,
      verify: (value) => value > 0n ? null : "total supply is not positive",
    }),
    uint256Observation({
      label: "usdz:decimals",
      contract: usdz,
      data: DECIMALS_SELECTOR,
      verify: (value) => value === BigInt(EXPECTED_DEPLOYMENTS[chain].decimals)
        ? null
        : "token decimals drifted",
    }),
    customObservation({
      label: "usdz:symbol",
      contract: usdz,
      data: SYMBOL_SELECTOR,
      decode: (raw) => decodeString(raw, `${chain} symbol()`),
      verify: (value) => value === "USDz" ? null : "token symbol drifted",
    }),
    addressObservation({
      label: "usdz:endpoint",
      contract: usdz,
      data: USDZ_ENDPOINT_SELECTOR,
      allowFailure: true,
      optional: true,
      verify: (value) => (chain !== "ethereum" && chain !== "base") || value === LAYERZERO_ENDPOINT
        ? null
        : "LayerZero endpoint drifted",
    }),
  ];
  if (chain !== "ethereum") return fields;

  fields.push(
    rawObservation({ label: "usdz:total-pooled-spct", contract: usdz, data: "0x8abb1eb4" }),
    rawObservation({ label: "usdz:spct", contract: usdz, data: USDZ_SPCT_SELECTOR }),
    rawObservation({ label: "usdz:usdc", contract: usdz, data: USDZ_USDC_SELECTOR }),
    rawObservation({ label: "usdz:oracle", contract: usdz, data: USDZ_ORACLE_SELECTOR }),
    rawObservation({ label: "usdz:paused", contract: usdz, data: PAUSED_SELECTOR }),
    rawObservation({ label: "usdz:collateral-rate", contract: usdz, data: USDZ_COLLATERAL_RATE_SELECTOR }),
    rawObservation({ label: "usdz:mode", contract: usdz, data: USDZ_MODE_SELECTOR }),
    rawObservation({ label: "usdz:redeem-fee-rate", contract: usdz, data: REDEEM_FEE_RATE_SELECTOR }),
    rawObservation({ label: "usdz:fee-coefficient", contract: usdz, data: FEE_COEFFICIENT_SELECTOR }),
    rawObservation({ label: "spct:balance-of-usdz", contract: SPCT_POOL_CONTRACT, data: encodeAddressCall(BALANCE_OF_SELECTOR, usdz) }),
    rawObservation({ label: "spct:reserve-usd", contract: SPCT_POOL_CONTRACT, data: SPCT_RESERVE_USD_SELECTOR }),
    rawObservation({ label: "spct:paused", contract: SPCT_POOL_CONTRACT, data: PAUSED_SELECTOR }),
    rawObservation({ label: "spct:redeem-fee-rate", contract: SPCT_POOL_CONTRACT, data: REDEEM_FEE_RATE_SELECTOR }),
    rawObservation({ label: "spct:fee-coefficient", contract: SPCT_POOL_CONTRACT, data: FEE_COEFFICIENT_SELECTOR }),
    rawObservation({ label: "spct:usdz-whitelisted", contract: SPCT_POOL_CONTRACT, data: encodeAddressCall(SPCT_IS_WHITELIST_SELECTOR, usdz) }),
    rawObservation({ label: "usdc:spct-balance", contract: USDC_CONTRACT, data: encodeAddressCall(BALANCE_OF_SELECTOR, SPCT_POOL_CONTRACT) }),
    rawObservation({ label: "usdc:usdz-balance", contract: USDC_CONTRACT, data: encodeAddressCall(BALANCE_OF_SELECTOR, usdz) }),
    rawObservation({ label: "oracle:price", contract: SPCT_PRICE_ORACLE_CONTRACT, data: ORACLE_GET_PRICE_SELECTOR }),
  );
  return fields;
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

function requireWord(values: ReadonlyMap<string, `0x${string}`>, label: string): `0x${string}` {
  const value = values.get(label);
  if (!value) throw new Error(`${ADAPTER_KEY} ${label} read failed`);
  return value;
}

function requireUint(values: ReadonlyMap<string, `0x${string}`>, label: string): bigint {
  const value = decodeUint256Word(requireWord(values, label));
  if (value == null) throw new Error(`${ADAPTER_KEY} ${label} returned malformed data`);
  return value;
}

function requireBool(values: ReadonlyMap<string, `0x${string}`>, label: string): boolean {
  const value = decodeStrictBoolWord(requireWord(values, label));
  if (value == null) throw new Error(`${ADAPTER_KEY} ${label} returned malformed bool`);
  return value;
}

function requireAddress(values: ReadonlyMap<string, `0x${string}`>, label: string): string {
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

async function readChain(
  chain: SupportedSupplyChain,
  contract: { address: string; decimals: number },
  signal: AbortSignal,
  deadlineMs: number,
  ctx?: AdapterContext,
): Promise<ChainObservation> {
  const stateFields = buildStateFields(chain, contract.address);
  const rpcOptions = {
    signal,
    timeoutMs: RPC_REQUEST_TIMEOUT_MS,
    deadlineMs,
    maxRetries: 0,
    chainRpcs: ctx?.chainRpcs,
    extraRpcUrls: getAdapterRpcUrls(chain),
  };
  const [code, supportingCodes, aggregate] = await runAdapterIo(
    ctx,
    `${ADAPTER_KEY}:rpc:${chain}`,
    async () => {
      const deploymentCode = await fetchEvmCodeAtBlock(chain, contract.address, "latest", rpcOptions);
      const ethereumSupportingCodes: Array<`0x${string}` | null> = [];
      if (chain === "ethereum") {
        for (const address of [SPCT_POOL_CONTRACT, SPCT_PRICE_ORACLE_CONTRACT, USDC_CONTRACT]) {
          ethereumSupportingCodes.push(await fetchEvmCodeAtBlock(chain, address, "latest", rpcOptions));
        }
      }
      const state = await fetchEvmCallHexAtBlock(
        chain,
        MULTICALL3_ADDRESS,
        encodeMulticall3Aggregate3CallData(stateFields.map((field) => ({
          label: field.label,
          target: field.contract,
          callData: field.data,
          allowFailure: field.allowFailure,
        }))),
        "latest",
        rpcOptions,
      );
      return [deploymentCode, ethereumSupportingCodes, state] as const;
    },
    { signal },
  );
  if (chain === "ethereum") {
    if (supportingCodes.some((supportingCode) => typeof supportingCode !== "string")) {
      throw new Error(`${ADAPTER_KEY} Ethereum supporting contract code is unavailable`);
    }
    if (keccak256(supportingCodes[0] as `0x${string}`).toLowerCase() !== SPCT_RUNTIME_CODE_HASH) {
      throw new Error(`${ADAPTER_KEY} Ethereum supporting contract code hash drifted`);
    }
  }
  if (typeof aggregate !== "string") throw new Error(`${ADAPTER_KEY} ${chain} state batch is unavailable`);
  const decoded = decodeMulticall3Aggregate3Result(
    aggregate as `0x${string}`,
    stateFields.map((field) => field.label),
  );
  const snapshot = await executeEvmObservationPlan({
    adapterKey: `${ADAPTER_KEY}:${chain}`,
    fields: stateFields,
    checks: [{
      label: "runtime-code",
      observe: async () => code,
      verify: (value) => {
        if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value) || value === "0x") {
          return "runtime code is unavailable";
        }
        return keccak256(value as `0x${string}`).toLowerCase() === EXPECTED_DEPLOYMENTS[chain].runtimeCodeHash
          ? null
          : "runtime code hash drifted";
      },
      metadata: {
        key: "runtimeCodeHash",
        project: (value) => keccak256(value as `0x${string}`).toLowerCase(),
      },
    }],
    read: async () => decoded,
  });
  const rawSupply = snapshot.values["usdz:total-supply"] as bigint;
  const decimalsRaw = snapshot.values["usdz:decimals"] as bigint;
  const symbol = snapshot.values["usdz:symbol"] as string;
  const endpoint = snapshot.values["usdz:endpoint"] as string | null;
  return {
    chain,
    address: contract.address.toLowerCase(),
    rawSupply,
    symbol,
    decimals: Number(decimalsRaw),
    endpoint,
    codeHash: snapshot.metadata.runtimeCodeHash as string,
    values: snapshot.rawByLabel,
  };
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

function observeAnzenRedemption(values: ReadonlyMap<string, `0x${string}`>): AnzenRedemptionProbe {
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
  const rpcDeadlineMs = Date.now() + RPC_ATTEMPT_BUDGET_MS - RPC_DEADLINE_HEADROOM_MS;
  const observations = await Promise.all([
    fetchLayerZeroMetadata(signal, ctx),
    ...SUPPLY_CHAINS.map((chain) => readChain(chain, contracts[chain], signal, rpcDeadlineMs, ctx)),
  ]);
  const chainObservations = observations.slice(1) as ChainObservation[];
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
