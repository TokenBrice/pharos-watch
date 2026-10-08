import type { ReserveAdapterCoin } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { TOTAL_SUPPLY_SELECTOR, encodeBalanceOfCallData, encodeUint256 } from "../../lib/evm-selectors";
import { resolveCoinContractAddress } from "./evm";
import {
  ERC4626_ASSET_SELECTOR,
  ERC4626_CONVERT_TO_ASSETS_SELECTOR,
  ERC4626_TOTAL_ASSETS_SELECTOR,
} from "./erc4626";
import {
  addressObservation,
  executeEvmObservationPlan,
  pinnedBlockPlan,
  uint256Observation,
  type AnyEvmObservationField,
} from "./evm-observation-plan";
import {
  decimalNumberFromBigInt,
  decimalStringFromBigInt,
  fetchOnchainMulticall3,
  requireExpectedAddress,
  requireOnchainInput,
  slicesFromValues,
  verifiedFreshnessMetadata,
} from "./helpers";
import type { AdapterContext, AdapterResult } from "./types";

const ADAPTER_KEY = "spark-usdc-v1-inventory";
// Reviewed implementation-defined local inventory at Ethereum block 26143056.
const VAULT = "0xbc65ad17c5c0a2a4d159fa5a503f4992c7b545fe";
const IMPLEMENTATION = "0xf943cb8d5f06f2bbf352878ebef3ec5c537a20ba";
const SUSDS = "0xa3931d71877c0e7a3148cb7eb4463524fec27fbd";
const USDS = "0xdc035d45d973e3ec169d2276ddab16f1e407384f";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const DAI = "0x6b175474e89094c44da98b954eedeac495271d0f";
const PSM = "0xa188eec8f81263234da3622a406892f3d630f98c";
const DAI_PSM = "0xf6e72db5454dd049d0788e411b06cfaf16853042";
const POCKET = "0x37305b1cd40574e4c5ce33f8e8306be057fd7341";
const USDC_TO_WAD = 1_000_000_000_000n;

function identity<const Label extends string>(label: Label, contract: string, data: string, expected: string) {
  return addressObservation({
    label,
    contract,
    data,
    verify: (value) => value === expected ? null : `${label} identity mismatch`,
  });
}

/** Complete local receipt inventory; does not measure the shared PSM pocket or upstream Sky assets. */
export async function fetchSparkUsdcV1InventoryReserves(
  coin: Pick<ReserveAdapterCoin, "id" | "contracts">,
  config: Pick<LiveReservesConfig, "inputs" | "params">,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, ADAPTER_KEY);
  if (input.chain !== "ethereum" || coin.id !== "susdc-spark-v1") {
    throw new Error(`${ADAPTER_KEY}: requires the reviewed Ethereum Spark V1 instrument`);
  }
  const contract = resolveCoinContractAddress(coin, input.chain);
  if (!contract) throw new Error(`${ADAPTER_KEY}: missing vault contract`);
  requireExpectedAddress(ADAPTER_KEY, contract.toLowerCase(), VAULT, "vault");
  if (config.params && Object.keys(config.params).length > 0) {
    throw new Error(`${ADAPTER_KEY}: no parameters are supported`);
  }
  const block = await pinnedBlockPlan({ chain: input.chain, signal, ctx });
  const observe = <const Fields extends readonly AnyEvmObservationField[]>(fields: Fields) =>
    executeEvmObservationPlan({
      adapterKey: ADAPTER_KEY,
      fields,
      read: (calls) => fetchOnchainMulticall3({ calls, chain: input.chain, signal, ctx: block.ctx }),
    });

  const core = await observe([
    identity("implementation", VAULT, "0xaaf10f42", IMPLEMENTATION), // getImplementation()
    identity("asset", VAULT, ERC4626_ASSET_SELECTOR, USDC),
    identity("usdc", VAULT, "0x3e413bee", USDC),
    identity("susds", VAULT, "0x58b8f19c", SUSDS),
    identity("psm", VAULT, "0x04bda262", PSM),
    identity("usds", SUSDS, "0x4cf282fb", USDS),
    identity("daiPsm", PSM, "0x04bda262", DAI_PSM),
    identity("pocket", PSM, "0xcccef9e2", POCKET),
    identity("dai", DAI_PSM, "0xf4b9fa75", DAI),
    uint256Observation({ label: "totalSupply", contract: VAULT, data: TOTAL_SUPPLY_SELECTOR }),
    uint256Observation({ label: "totalAssets", contract: VAULT, data: ERC4626_TOTAL_ASSETS_SELECTOR }),
  ] as const);
  const { totalSupply, totalAssets } = core.values;
  if (totalSupply <= 0n || totalAssets <= 0n) {
    throw new Error(`${ADAPTER_KEY}: no positive share obligations or NAV`);
  }

  const balanceData = encodeBalanceOfCallData(VAULT);
  const supplyConversionData = `${ERC4626_CONVERT_TO_ASSETS_SELECTOR}${encodeUint256(totalSupply)}`;
  const inventory = await observe([
    uint256Observation({ label: "receiptBalance", contract: SUSDS, data: balanceData }),
    uint256Observation({ label: "idleUsdc", contract: USDC, data: balanceData }),
    uint256Observation({ label: "idleUsds", contract: USDS, data: balanceData }),
    uint256Observation({ label: "idleDai", contract: DAI, data: balanceData }),
    uint256Observation({ label: "convertedSupply", contract: VAULT, data: supplyConversionData }),
    uint256Observation({ label: "obligationAssets", contract: SUSDS, data: supplyConversionData }),
  ] as const);
  const { receiptBalance, idleUsdc, idleUsds, idleDai, convertedSupply, obligationAssets } = inventory.values;
  // Each V1 share entitles its holder to one sUSDS share through exit(). Idle tokens cannot repair a receipt deficit.
  if (receiptBalance < totalSupply) throw new Error(`${ADAPTER_KEY}: receipt shortfall`);
  if (convertedSupply !== totalAssets || obligationAssets / USDC_TO_WAD !== totalAssets) {
    throw new Error(`${ADAPTER_KEY}: share conversion/NAV floor mismatch`);
  }

  // Reuse an identical conversion only after independently reading the actual held receipt balance.
  const receiptAssets = receiptBalance === totalSupply
    ? obligationAssets
    : (await observe([
      uint256Observation({
        label: "receiptAssets",
        contract: SUSDS,
        data: `${ERC4626_CONVERT_TO_ASSETS_SELECTOR}${encodeUint256(receiptBalance)}`,
      }),
    ] as const)).values.receiptAssets;
  if (receiptAssets < obligationAssets) throw new Error(`${ADAPTER_KEY}: receipt conversion shortfall`);
  const grossLocalValue = receiptAssets + idleUsdc * USDC_TO_WAD + idleUsds + idleDai;
  const navValue = totalAssets * USDC_TO_WAD;
  const totalReserveUsd = decimalNumberFromBigInt(grossLocalValue, 18);
  const navUsd = decimalNumberFromBigInt(totalAssets, 6);
  const shareSupply = decimalNumberFromBigInt(totalSupply, 18);

  return {
    slices: slicesFromValues([
      {
        sourceKey: "spark-usdc-v1:ethereum:susds",
        name: "sUSDS shares held by Legacy UsdcVault",
        value: decimalNumberFromBigInt(receiptAssets, 18),
        risk: "high",
        coinId: "susds-sky",
        depType: "collateral",
        assetClass: "protocol-position",
        issuerOrObligor: "Sky sUSDS savings contract",
      },
      {
        sourceKey: "spark-usdc-v1:ethereum:usdc",
        name: "Idle USDC held by Legacy UsdcVault",
        value: decimalNumberFromBigInt(idleUsdc, 6),
        risk: "low",
        coinId: "usdc-circle",
        depType: "collateral",
        assetClass: "stablecoin",
        issuerOrObligor: "Circle Internet Financial",
      },
      {
        sourceKey: "spark-usdc-v1:ethereum:usds",
        name: "Idle USDS held by Legacy UsdcVault",
        value: decimalNumberFromBigInt(idleUsds, 18),
        risk: "high",
        coinId: "usds-sky",
        depType: "collateral",
        assetClass: "stablecoin",
        issuerOrObligor: "Sky",
      },
      {
        sourceKey: "spark-usdc-v1:ethereum:dai",
        name: "Idle DAI held by Legacy UsdcVault",
        value: decimalNumberFromBigInt(idleDai, 18),
        risk: "low",
        coinId: "dai-makerdao",
        depType: "collateral",
        assetClass: "stablecoin",
        issuerOrObligor: "Sky",
      },
    ], null),
    metadata: {
      ...verifiedFreshnessMetadata(block.observedBlock.timestamp),
      observedBlock: block.observedBlock,
      totalReserveUsd,
      totalAssetsUsd: navUsd,
      navUsd,
      sharePriceUsd: navUsd / shareSupply,
      details: {
        proofKind: "spark-usdc-v1-local-inventory",
        valuationBasis: "token-accounting-par-not-market-price",
        freshnessSource: "pinned-ethereum-block",
        contractAddress: VAULT,
        ...core.values,
        totalSupply: totalSupply.toString(),
        totalAssets: totalAssets.toString(),
        receiptBalanceRaw: receiptBalance.toString(),
        receiptAssetsRaw: receiptAssets.toString(),
        obligationAssetsRaw: obligationAssets.toString(),
        convertedSupplyRaw: convertedSupply.toString(),
        idleUsdcRaw: idleUsdc.toString(),
        idleUsdsRaw: idleUsds.toString(),
        idleDaiRaw: idleDai.toString(),
        receiptSurplusRaw: (receiptBalance - totalSupply).toString(),
        navFloorRemainderRaw: (obligationAssets % USDC_TO_WAD).toString(),
        grossLocalValueRaw: grossLocalValue.toString(),
        grossLocalValue: decimalStringFromBigInt(grossLocalValue, 18),
        localSurplusRaw: (grossLocalValue - navValue).toString(),
        localSurplus: decimalStringFromBigInt(grossLocalValue - navValue, 18),
      },
    },
  };
}
