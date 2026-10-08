import type { ReserveAdapterCoin } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { fetchEvmStorageAtBlock } from "../../lib/evm-rpc";
import { encodeBalanceOfCallData } from "../../lib/evm-selectors";
import { decodeAbiWordAt, decodeStrictAddressWord, decodeStrictBoolWord, decodeUint256Word } from "./abi-decode";
import { runAdapterIo } from "./concurrency";
import {
  addressObservation,
  boolObservation,
  customObservation,
  executeEvmObservationPlan,
  pinnedBlockPlan,
  uint256Observation,
} from "./evm-observation-plan";
import { decimalNumberFromBigInt, fetchOnchainMulticall3, requireOnchainInput, verifiedFreshnessMetadata } from "./helpers";
import { EIP1967_IMPLEMENTATION_SLOT } from "./onchain-identity";
import { collateralizationRatioFromTokenAmounts, ratioFromRaw } from "./slice-math";
import type { AdapterContext, AdapterResult } from "./types";
import { reserveDegradedWarning, reserveInfoWarning } from "./warnings";

const ADAPTER_KEY = "forest-road-reserve-manager";
// Verified ReserveManager source and accounting at Ethereum block 26143056.
const MANAGER = "0x8317736611b542ddb4a820fe344b621a904bdd48";
const IMPLEMENTATION = "0x99b4dfa4e1344273d5335bd90de1dea3a02b9c3a";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const TOKEN = "0xcc07e7c4e5e35affd47b351e420a22c667d7f83d";
const USDC_SCALE = 1_000_000_000_000n;

/** The verified Delivery tuple is entirely static: 18 ABI words, including PricingState. */
function decodeDeliveryActive(raw: `0x${string}`): boolean {
  if (!/^0x[0-9a-fA-F]{1152}$/.test(raw)) {
    throw new Error(`${ADAPTER_KEY}: malformed accrualDelivery`);
  }
  const word = (index: number) => decodeAbiWordAt(raw, index);
  const active = decodeStrictBoolWord(word(17));
  const accruedThrough = decodeUint256Word(word(15));
  const legs = decodeUint256Word(word(16));
  if (active == null || decodeStrictBoolWord(word(11)) == null ||
      decodeStrictAddressWord(word(12)) == null || decodeStrictAddressWord(word(13)) == null ||
      decodeStrictAddressWord(word(14)) == null || accruedThrough == null ||
      accruedThrough > (1n << 64n) - 1n || legs == null || legs > 255n) {
    throw new Error(`${ADAPTER_KEY}: malformed accrualDelivery`);
  }
  return active;
}

const STATE_FIELDS = [
    addressObservation({ label: "usdc", contract: MANAGER, data: "0x3e413bee",
      verify: (value) => value === USDC ? null : "USDC identity drift" }),
    uint256Observation({ label: "usdcDecimals", contract: USDC, data: "0x313ce567",
      verify: (value) => value === 6n ? null : "USDC decimals drift" }),
    uint256Observation({ label: "tokenDecimals", contract: TOKEN, data: "0x313ce567",
      verify: (value) => value === 18n ? null : "USDfr decimals drift" }),
    boolObservation({ label: "paused", contract: MANAGER, data: "0x5c975abb" }),
    customObservation({ label: "deliveryActive", contract: MANAGER, data: "0xe2d252ad", decode: decodeDeliveryActive,
      verify: (value) => value ? "active accrual delivery requires a complete frozen-snapshot model" : null }),
    uint256Observation({ label: "idleReserve", contract: MANAGER, data: "0x11af8243" }),
    uint256Observation({ label: "idleUSDC", contract: MANAGER, data: "0x6af2fa06" }),
    uint256Observation({ label: "deployedPrincipal", contract: MANAGER, data: "0x6fa4a33b" }),
    uint256Observation({ label: "impairment", contract: MANAGER, data: "0xb5984016" }),
    uint256Observation({ label: "totalBacking", contract: MANAGER, data: "0x02df9274" }),
    uint256Observation({ label: "recognizedBacking", contract: MANAGER, data: "0xd0a6c794" }),
    uint256Observation({ label: "supply", contract: TOKEN, data: "0x18160ddd" }),
    uint256Observation({ label: "actualUSDC", contract: USDC, data: encodeBalanceOfCallData(MANAGER) }),
  ] as const;

export async function fetchForestRoadReserveManagerReserves(
  coin: ReserveAdapterCoin,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, ADAPTER_KEY);
  const contracts = coin.contracts;
  if (coin.id !== "usdfr-forest-road" || input.chain !== "ethereum" || contracts?.length !== 1 ||
      contracts[0]?.chain !== "ethereum" || contracts[0].address.toLowerCase() !== TOKEN || contracts[0].decimals !== 18) {
    throw new Error(`${ADAPTER_KEY}: USDfr identity drift`);
  }
  // The deployment is not user-selectable. Wave B's strict authoring schema mirrors these pins.
  const params = config.params ?? {};
  for (const [key, expected] of [
    ["managerAddress", MANAGER], ["managerImplementation", IMPLEMENTATION],
    ["usdcAddress", USDC], ["tokenAddress", TOKEN],
  ] as const) {
    if (params[key] !== expected) throw new Error(`${ADAPTER_KEY}: ${key} profile drift`);
  }
  for (const key of ["rpcUrl", "fallbackRpcUrl"] as const) {
    if (params[key] != null && (typeof params[key] !== "string" || !/^https:\/\//.test(params[key]))) {
      throw new Error(`${ADAPTER_KEY}: invalid ${key}`);
    }
  }
  const rpcUrl = typeof params.rpcUrl === "string" ? params.rpcUrl : undefined;
  const fallbackRpcUrl = typeof params.fallbackRpcUrl === "string" ? params.fallbackRpcUrl : undefined;
  const pin = await pinnedBlockPlan({ chain: "ethereum", signal, ctx, rpcUrl, fallbackRpcUrl });
  const block = pin.observedBlock;
  if (!Number.isSafeInteger(block.number) || block.number < 0 ||
      !Number.isSafeInteger(block.timestamp) || block.timestamp <= 0) {
    throw new Error(`${ADAPTER_KEY}: invalid observation block`);
  }
  const implementationWord = await runAdapterIo(pin.ctx, `${ADAPTER_KEY}:implementation`, () =>
    fetchEvmStorageAtBlock("ethereum", MANAGER, EIP1967_IMPLEMENTATION_SLOT, block.number, {
      signal, chainRpcs: pin.ctx.chainRpcs, timeoutMs: 10_000,
      extraRpcUrls: [rpcUrl, fallbackRpcUrl].filter((url): url is string => url != null),
    }));
  if (decodeStrictAddressWord(implementationWord)?.toLowerCase() !== IMPLEMENTATION) {
    throw new Error(`${ADAPTER_KEY}: manager implementation drift or unavailable`);
  }
  const snapshot = await executeEvmObservationPlan({
    adapterKey: ADAPTER_KEY,
    fields: STATE_FIELDS,
    read: (calls) => fetchOnchainMulticall3({
      calls, signal, ctx: pin.ctx, rpcUrl, fallbackRpcUrl, chain: "ethereum", blockNumberOrTag: block.number,
    }),
  });
  const values = snapshot.values;
  if (values.impairment > values.deployedPrincipal) {
    throw new Error(`${ADAPTER_KEY}: impairment exceeds accrued deployed credit book`);
  }
  const netCredit = values.deployedPrincipal - values.impairment;
  const idle = values.idleUSDC * USDC_SCALE;
  if (values.idleReserve !== idle || values.totalBacking !== idle + netCredit) {
    throw new Error(`${ADAPTER_KEY}: backing accounting does not reconcile`);
  }
  // A ledger receivable is not cash custody; donations are not recorded backing either.
  if (values.actualUSDC < values.idleUSDC) {
    throw new Error(`${ADAPTER_KEY}: actual USDC custody below recorded idle reserve`);
  }
  if (values.recognizedBacking !== values.totalBacking) {
    throw new Error(`${ADAPTER_KEY}: recognized backing diverges from fully custodied accounting`);
  }
  if (values.recognizedBacking === 0n || values.supply === 0n) {
    throw new Error(`${ADAPTER_KEY}: zero backing or supply`);
  }
  const totalReserveUsd = decimalNumberFromBigInt(values.recognizedBacking, 18);
  const supplyTokens = decimalNumberFromBigInt(values.supply, 18);
  const collateralizationRatio = collateralizationRatioFromTokenAmounts(values.recognizedBacking, 18, values.supply, 18);
  if (!Number.isFinite(totalReserveUsd) || totalReserveUsd <= 0 || !Number.isFinite(supplyTokens) ||
      supplyTokens <= 0 || collateralizationRatio == null || !Number.isFinite(collateralizationRatio)) {
    throw new Error(`${ADAPTER_KEY}: nonfinite accounting`);
  }
  const idlePct = ratioFromRaw(idle, values.recognizedBacking)! * 100;
  const warnings = snapshot.warnings;
  if (values.impairment > 0n) warnings.push(reserveDegradedWarning(
    "forest-road-credit-impairment", "The accrued credit book carries a recognized principal impairment, subtracted once from backing."));
  if (values.recognizedBacking < values.supply) warnings.push(reserveDegradedWarning(
    "forest-road-backing-shortfall", "Recognized accounting backing is below USDfr supply; the measured shortfall is retained."));
  if (values.paused) warnings.push(reserveInfoWarning(
    "forest-road-manager-paused", "ReserveManager is paused; composition does not certify an executable holder exit."));
  const surplus = values.actualUSDC - values.idleUSDC;
  if (surplus > 0n) warnings.push(reserveInfoWarning(
    "forest-road-unrecognized-usdc-surplus", "USDC custody exceeds the recorded idle reserve; the unrecognized surplus is excluded from backing."));
  return {
    slices: [
      {
        sourceKey: "forest-road:idle-usdc", name: "USDC idle accounting reserve", pct: idlePct,
        risk: "low", coinId: "usdc-circle", depType: "collateral", assetClass: "stablecoin",
        issuerOrObligor: "Circle", riskFactors: ["custody", "counterparty", "smart-contract"], liquidityHorizon: "immediate",
      },
      {
        sourceKey: "forest-road:credit-book", name: "Forest Road net accrued private-credit accounting book", pct: 100 - idlePct,
        risk: "high", assetClass: "private-credit",
        issuerOrObligor: "Forest Road originated facilities; borrower legal identities undisclosed",
        riskFactors: ["credit", "duration", "liquidity", "legal", "counterparty", "concentration"], liquidityHorizon: "unknown",
      },
    ],
    warnings,
    metadata: {
      ...verifiedFreshnessMetadata(block.timestamp), totalReserveUsd, supplyTokens, supplyUsd: supplyTokens,
      collateralizationRatio, reserveObservedAt: block.timestamp,
      supplyObservedAt: { min: block.timestamp, max: block.timestamp }, ratioSkewSec: 0, supplyCoverageComplete: true,
      details: {
        accountingBasis: "onchain-accounting-claim-not-independent-credit-valuation",
        managerAddress: MANAGER, managerImplementation: IMPLEMENTATION, usdcAddress: USDC, tokenAddress: TOKEN,
        observedBlock: block.number, managerPaused: values.paused, accrualDeliveryActive: values.deliveryActive,
        idleUSDC6Raw: values.idleUSDC.toString(), actualUSDC6Raw: values.actualUSDC.toString(),
        idleReserve18Raw: values.idleReserve.toString(), accruedDeployedCredit18Raw: values.deployedPrincipal.toString(),
        principalImpairment18Raw: values.impairment.toString(), netPrivateCredit18Raw: netCredit.toString(),
        totalBacking18Raw: values.totalBacking.toString(), recognizedBacking18Raw: values.recognizedBacking.toString(),
        supply18Raw: values.supply.toString(), unrecognizedUSDC6Raw: surplus.toString(),
        creditBorrowerIdentity: "unknown", creditValuation: "unverified", holderPriority: "unknown",
      },
    },
  };
}
