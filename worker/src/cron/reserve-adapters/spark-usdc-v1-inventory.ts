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
// Reviewed implementation-defined local inventory across the five native Legacy V1 deployments.
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

// Official Legacy V1 native deployments, independently pinned 2026-10-15.
const L2_VAULTS = [
  {
    chain: "arbitrum",
    vault: "0x940098b108fb7d0a7e374f6eded7760787464609",
    implementation: "0xdc8df20be448e41fde88e2478d6bc4d3c9a092d6",
    susds: "0xddb46999f8891663a8f2828d25298f70416d7610",
    usdc: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
    psm: "0x2b05f8e1cacc6974fd79a673a341fe1f58d27266",
    rateProvider: "0xee2816c1e1eed14d444552654ed3027abc033a36",
  },
  {
    chain: "base",
    vault: "0x3128a0f7f0ea68e7b7c9b00afa7e41045828e858",
    implementation: "0x6acc02ddd82206a44ff4ec13977e63d1a29c7723",
    susds: "0x5875eee11cf8398102fdad704c9e96607675467a",
    usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    psm: "0x1601843c5e9bc251a3272907010afa41fa18347e",
    rateProvider: "0x65d946e533748a998b1f0e430803e39a6388f7a1",
  },
  {
    chain: "optimism",
    vault: "0xcf9326e24ebffbef22ce1050007a43a3c0b6db55",
    implementation: "0x3a1d3a9b0ed182d7b17aa61393d46a4f4ee0cea5",
    susds: "0xb5b2dc7fd34c249f4be7fb1fcea07950784229e0",
    usdc: "0x0b2c639c533813f4aa9d7837caf62653d097ff85",
    psm: "0xe0f9978b907853f354d79188a3defbd41978af62",
    rateProvider: "0x6e53585449142a5e6d5fc918ae6bea341dc81c68",
  },
  {
    chain: "unichain",
    vault: "0x14d9143becc348920b68d123687045db49a016c6",
    implementation: "0x1fcc6bdfb541580d39e57d0531ab0f68d0914c79",
    susds: "0xa06b10db9f390990364a3984c04fadf1c13691b5",
    usdc: "0x078d782b760474a361dda0af3839290b0ef57ad6",
    psm: "0x7b42ed932f26509465f7ce3faf76ffce1275312f",
    rateProvider: "0x1566bfa55d95686a823751298533d42651183988",
  },
] as const;

function identity<const Label extends string>(label: Label, contract: string, data: string, expected: string) {
  return addressObservation({
    label,
    contract,
    data,
    verify: (value) => value === expected ? null : `${label} identity mismatch`,
  });
}

/** Complete authored native-vault inventory; shared PSM pockets and upstream Sky assets are excluded. */
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
  const expected = [{ chain: "ethereum", vault: VAULT }, ...L2_VAULTS];
  if (coin.contracts?.length !== expected.length || expected.some((row) =>
    !coin.contracts?.some((entry) => entry.chain === row.chain && entry.address.toLowerCase() === row.vault && entry.decimals === 18))) {
    throw new Error(`${ADAPTER_KEY}: incomplete or unreviewed native deployment roster`);
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
  let aggregateValue = grossLocalValue;
  let aggregateAssets = totalAssets;
  let aggregateSupply = totalSupply;
  let oldestTimestamp = block.observedBlock.timestamp;
  const additionalSlices: Parameters<typeof slicesFromValues>[0] = [];
  const additionalDeployments: Record<string, unknown>[] = [];
  const observedBlocks = [block.observedBlock];
  // Iterate sequentially: every authored deployment is mandatory, and no chain
  // may borrow the primary Ethereum observation anchor or a sibling's state.
  for (const deployment of coin.contracts ?? []) {
    if (deployment.chain === "ethereum") continue;
    const reviewed = L2_VAULTS.find((row) => row.chain === deployment.chain);
    if (!reviewed || deployment.address.toLowerCase() !== reviewed.vault || deployment.decimals !== 18) {
      throw new Error(`${ADAPTER_KEY}: unreviewed native deployment`);
    }
    const local = await pinnedBlockPlan({
      chain: reviewed.chain, signal, ctx: { ...ctx, observedBlock: undefined },
    });
    const localObserve = <const Fields extends readonly AnyEvmObservationField[]>(fields: Fields) =>
      executeEvmObservationPlan({
        adapterKey: ADAPTER_KEY, fields,
        read: (calls) => fetchOnchainMulticall3({ calls, chain: reviewed.chain, signal, ctx: local.ctx }),
      });
    const identityAndObligations = await localObserve([
      identity("implementation", reviewed.vault, "0xaaf10f42", reviewed.implementation),
      identity("asset", reviewed.vault, ERC4626_ASSET_SELECTOR, reviewed.usdc),
      identity("usdc", reviewed.vault, "0x3e413bee", reviewed.usdc),
      identity("susds", reviewed.vault, "0x58b8f19c", reviewed.susds),
      identity("psm", reviewed.vault, "0x04bda262", reviewed.psm),
      identity("rateProvider", reviewed.vault, "0x949db658", reviewed.rateProvider),
      identity("psmUsdc", reviewed.psm, "0x3e413bee", reviewed.usdc),
      identity("psmSusds", reviewed.psm, "0x58b8f19c", reviewed.susds),
      identity("psmRateProvider", reviewed.psm, "0x949db658", reviewed.rateProvider),
      uint256Observation({ label: "totalSupply", contract: reviewed.vault, data: TOTAL_SUPPLY_SELECTOR }),
      uint256Observation({ label: "totalAssets", contract: reviewed.vault, data: ERC4626_TOTAL_ASSETS_SELECTOR }),
    ] as const);
    const supply = identityAndObligations.values.totalSupply;
    const assets = identityAndObligations.values.totalAssets;
    const supplyData = `${ERC4626_CONVERT_TO_ASSETS_SELECTOR}${encodeUint256(supply)}`;
    const localInventory = await localObserve([
      uint256Observation({ label: "receiptBalance", contract: reviewed.susds, data: encodeBalanceOfCallData(reviewed.vault) }),
      uint256Observation({ label: "idleUsdc", contract: reviewed.usdc, data: encodeBalanceOfCallData(reviewed.vault) }),
      uint256Observation({ label: "convertedSupply", contract: reviewed.vault, data: supplyData }),
    ] as const);
    const held = localInventory.values.receiptBalance;
    const idle = localInventory.values.idleUsdc;
    if (held < supply || localInventory.values.convertedSupply !== assets || (supply > 0n && assets <= 0n)) {
      throw new Error(`${ADAPTER_KEY}: ${reviewed.chain} receipt/NAV mismatch`);
    }
    const heldAssets = held === supply ? assets : (await localObserve([
      uint256Observation({ label: "heldAssets", contract: reviewed.vault,
        data: `${ERC4626_CONVERT_TO_ASSETS_SELECTOR}${encodeUint256(held)}` }),
    ] as const)).values.heldAssets;
    if (heldAssets < assets) throw new Error(`${ADAPTER_KEY}: ${reviewed.chain} conversion shortfall`);
    aggregateValue += (heldAssets + idle) * USDC_TO_WAD;
    aggregateAssets += assets;
    aggregateSupply += supply;
    oldestTimestamp = Math.min(oldestTimestamp, local.observedBlock.timestamp);
    additionalSlices.push({
      sourceKey: `spark-usdc-v1:${reviewed.chain}:susds`,
      name: `Bridged sUSDS shares held by Legacy UsdcVault on ${reviewed.chain}`,
      value: decimalNumberFromBigInt(heldAssets, 6), risk: "high", coinId: "susds-sky",
      depType: "collateral", assetClass: "protocol-position",
      issuerOrObligor: "Sky sUSDS canonical bridge representation",
    }, {
      sourceKey: `spark-usdc-v1:${reviewed.chain}:usdc`,
      name: `Idle USDC held by Legacy UsdcVault on ${reviewed.chain}`,
      value: decimalNumberFromBigInt(idle, 6), risk: "low", coinId: "usdc-circle",
      depType: "collateral", assetClass: "stablecoin", issuerOrObligor: "Circle Internet Financial",
    });
    observedBlocks.push(local.observedBlock);
    additionalDeployments.push({
      chain: reviewed.chain, contract: reviewed.vault, observedBlock: local.observedBlock,
      implementation: reviewed.implementation, rateProvider: reviewed.rateProvider,
      totalSupplyRaw: supply.toString(), totalAssetsRaw: assets.toString(),
      receiptBalanceRaw: held.toString(), receiptAssetsRaw: heldAssets.toString(), idleUsdcRaw: idle.toString(),
    });
  }
  const totalReserveUsd = decimalNumberFromBigInt(aggregateValue, 18);
  const navUsd = decimalNumberFromBigInt(aggregateAssets, 6);
  const shareSupply = decimalNumberFromBigInt(aggregateSupply, 18);

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
      ...additionalSlices,
    ], null),
    metadata: {
      ...verifiedFreshnessMetadata(oldestTimestamp),
      observedBlock: block.observedBlock,
      totalReserveUsd,
      totalAssetsUsd: navUsd,
      navUsd,
      sharePriceUsd: navUsd / shareSupply,
      details: {
        proofKind: "spark-usdc-v1-native-multichain-inventory",
        valuationBasis: "token-accounting-par-not-market-price",
        freshnessSource: "oldest-pinned-deployment-block",
        observedBlocks,
        additionalDeployments,
        aggregateGrossValueRaw: aggregateValue.toString(),
        aggregateSupplyRaw: aggregateSupply.toString(),
        aggregateTotalAssetsRaw: aggregateAssets.toString(),
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
