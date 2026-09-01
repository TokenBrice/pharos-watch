import { toErrorMessage } from "@shared/lib/error-utils";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig, LiveReserveWarning } from "@shared/types/live-reserves";
import { encodeAddressCallData, encodeUint256 } from "../../lib/evm-selectors";
import type { AdapterContext, AdapterResult } from "./types";
import {
  buildRedemptionSnapshotMetadata,
  decimalNumberFromBigInt,
  fetchOnchainMulticall3,
  makeOnchainCallers,
  probeOptionalRedemptionRateBps,
  requireOnchainInput,
  reserveDegradedWarning,
} from "./helpers";
import {
  adaptBranchBalanceReserves,
  fetchBranchBalances,
  fetchBranchPriceMap,
  readBranchBalanceParams,
} from "./branch-balances";
import { decodeUint256Word } from "./abi-decode";

const ADAPTER_KEY = "evm-branch-balances";
const DEFAULT_DEBT_DECIMALS = 18;
const WAD = 10n ** 18n;

const SELECTORS = {
  honey: "0x36b2c4b2",
  numRegisteredAssets: "0xbb85d15b",
  registeredAssets: "0xa083bd3c",
  vaults: "0xa622ee7c",
  paused: "0x5c975abb",
  forcedBasketMode: "0x7b34b5d8",
  isBasketModeEnabled: "0xde4bc640",
  getWeights: "0x22acb867",
  globalCap: "0x99a2af75",
  collectedAssetFees: "0x64f76eaa",
  redeemRates: "0x2cfb0e10",
  isPegged: "0xbc7c2902",
  relativeCap: "0xbdb912f3",
  asset: "0x38d52e0f",
  custodyInfo: "0x72d4b21a",
  balanceOf: "0x70a08231",
  convertToAssets: "0x07a2d13a",
  allowance: "0xdd62ed3e",
  decimals: "0x313ce567",
} as const;

interface HoneyFactoryRedemptionCapacityParams {
  kind: "honey-factory-vaults";
  factoryAddress: string;
  expectedHoneyAddress: string;
  maxAssets: number;
  stableAssets: Array<{ address: string; decimals: number }>;
  sourceUrls: string[];
}

interface RedemptionCapacityObservation {
  metadata?: Record<string, unknown>;
  warnings: LiveReserveWarning[];
}

function requireUint(value: bigint | null, label: string): bigint {
  if (value == null) throw new Error(`${ADAPTER_KEY}: ${label} read failed`);
  return value;
}

function requireBool(value: bigint | null, label: string): boolean {
  const raw = requireUint(value, label);
  if (raw !== 0n && raw !== 1n) throw new Error(`${ADAPTER_KEY}: ${label} returned invalid bool`);
  return raw === 1n;
}

function addressFromWord(value: bigint | null, label: string): string {
  const raw = requireUint(value, label);
  if (raw === 0n || raw >= 1n << 160n) throw new Error(`${ADAPTER_KEY}: ${label} returned invalid address`);
  return `0x${raw.toString(16).padStart(40, "0")}`;
}

function decodeWords(raw: string | null, label: string): bigint[] {
  const hex = raw?.startsWith("0x") ? raw.slice(2) : null;
  if (hex == null || hex.length === 0 || hex.length % 64 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(`${ADAPTER_KEY}: ${label} returned malformed data`);
  }
  const words: bigint[] = [];
  for (let offset = 0; offset < hex.length; offset += 64) {
    words.push(BigInt(`0x${hex.slice(offset, offset + 64)}`));
  }
  return words;
}

function decodeUintArray(raw: string | null, expectedLength: number, label: string): bigint[] {
  const words = decodeWords(raw, label);
  const offsetBytes = words[0];
  if (offsetBytes % 32n !== 0n || offsetBytes > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${ADAPTER_KEY}: ${label} returned invalid offset`);
  }
  const offset = Number(offsetBytes / 32n);
  const lengthWord = words[offset];
  if (lengthWord == null || lengthWord !== BigInt(expectedLength)) {
    throw new Error(`${ADAPTER_KEY}: ${label} length mismatch`);
  }
  const values = words.slice(offset + 1, offset + 1 + expectedLength);
  if (values.length !== expectedLength) throw new Error(`${ADAPTER_KEY}: ${label} returned truncated data`);
  return values;
}

function decodeCustodyInfo(raw: string | null): { isCustodyVault: boolean; custodyAddress: string | null } {
  const words = decodeWords(raw, "custodyInfo()");
  if (words.length < 2 || (words[0] !== 0n && words[0] !== 1n) || words[1] >= 1n << 160n) {
    throw new Error(`${ADAPTER_KEY}: custodyInfo() returned malformed tuple`);
  }
  return {
    isCustodyVault: words[0] === 1n,
    custodyAddress: words[1] === 0n ? null : `0x${words[1].toString(16).padStart(40, "0")}`,
  };
}

function minBigInt(...values: bigint[]): bigint {
  return values.reduce((minimum, value) => value < minimum ? value : minimum);
}

function normalizeToWad(value: bigint, decimals: number): bigint {
  if (decimals === 18) return value;
  return decimals < 18
    ? value * 10n ** BigInt(18 - decimals)
    : value / 10n ** BigInt(decimals - 18);
}

async function readHoneyFactoryBatch(
  input: ReturnType<typeof requireOnchainInput>,
  calls: Array<{ label: string; contract: string; data: string; allowFailure: true }>,
  signal: AbortSignal,
  ctx: AdapterContext | undefined,
  rpcUrl: string | undefined,
  fallbackRpcUrl: string | undefined,
): Promise<Map<string, string | null>> {
  const results = await fetchOnchainMulticall3({
    calls,
    chain: input.chain,
    signal,
    ctx,
    rpcUrl,
    fallbackRpcUrl,
  });
  if (!results) throw new Error(`${ADAPTER_KEY}: HoneyFactory Multicall3 batch failed`);
  return new Map(
    results.map((result) => [result.label, result.success ? result.returnData : null]),
  );
}

function honeyUint(rawByLabel: ReadonlyMap<string, string | null>, label: string): bigint | null {
  return decodeUint256Word(rawByLabel.get(label));
}

async function observeHoneyFactoryRedemptionCapacity(
  input: ReturnType<typeof requireOnchainInput>,
  params: HoneyFactoryRedemptionCapacityParams,
  signal: AbortSignal,
  ctx?: AdapterContext,
  rpcUrl?: string,
  fallbackRpcUrl?: string,
): Promise<RedemptionCapacityObservation> {
  const factory = params.factoryAddress;

  try {
    const identity = await readHoneyFactoryBatch(
      input,
      [
        { label: "honey:honey", contract: factory, data: SELECTORS.honey, allowFailure: true },
        {
          label: "honey:asset-count",
          contract: factory,
          data: SELECTORS.numRegisteredAssets,
          allowFailure: true,
        },
      ],
      signal,
      ctx,
      rpcUrl,
      fallbackRpcUrl,
    );
    const honeyAddress = honeyUint(identity, "honey:honey");
    const assetCountRaw = honeyUint(identity, "honey:asset-count");
    if (addressFromWord(honeyAddress, "honey()").toLowerCase() !== params.expectedHoneyAddress.toLowerCase()) {
      throw new Error(`${ADAPTER_KEY}: HoneyFactory honey() identity mismatch`);
    }
    const assetCountBigInt = requireUint(assetCountRaw, "numRegisteredAssets()");
    if (assetCountBigInt > BigInt(params.maxAssets)) {
      throw new Error(
        `${ADAPTER_KEY}: registered asset count ${assetCountBigInt} exceeds configured cap ${params.maxAssets}`,
      );
    }
    const assetCount = Number(assetCountBigInt);
    if (assetCount === 0) throw new Error(`${ADAPTER_KEY}: HoneyFactory has no registered assets`);

    const registry = await readHoneyFactoryBatch(
      input,
      [
        ...Array.from({ length: assetCount }, (_, index) => ({
          label: `honey:asset:${index}`,
          contract: factory,
          data: `${SELECTORS.registeredAssets}${encodeUint256(BigInt(index))}`,
          allowFailure: true as const,
        })),
        { label: "honey:factory-paused", contract: factory, data: SELECTORS.paused, allowFailure: true },
        {
          label: "honey:forced-basket-mode",
          contract: factory,
          data: SELECTORS.forcedBasketMode,
          allowFailure: true,
        },
        {
          label: "honey:basket-mode",
          contract: factory,
          data: `${SELECTORS.isBasketModeEnabled}${encodeUint256(0n)}`,
          allowFailure: true,
        },
        { label: "honey:weights", contract: factory, data: SELECTORS.getWeights, allowFailure: true },
        { label: "honey:global-cap", contract: factory, data: SELECTORS.globalCap, allowFailure: true },
      ],
      signal,
      ctx,
      rpcUrl,
      fallbackRpcUrl,
    );
    const assets = Array.from({ length: assetCount }, (_, index) =>
      addressFromWord(honeyUint(registry, `honey:asset:${index}`), `registeredAssets(${index})`)
    );
    if (new Set(assets.map((asset) => asset.toLowerCase())).size !== assets.length) {
      throw new Error(`${ADAPTER_KEY}: HoneyFactory returned duplicate registered assets`);
    }

    const factoryPaused = requireBool(honeyUint(registry, "honey:factory-paused"), "paused()");
    const forcedBasketMode = requireBool(
      honeyUint(registry, "honey:forced-basket-mode"),
      "forcedBasketMode()",
    );
    const basketMode = requireBool(
      honeyUint(registry, "honey:basket-mode"),
      "isBasketModeEnabled(false)",
    );
    const weights = decodeUintArray(registry.get("honey:weights") ?? null, assetCount, "getWeights()");
    const globalCap = requireUint(honeyUint(registry, "honey:global-cap"), "globalCap()");
    if (forcedBasketMode && !basketMode) {
      throw new Error(`${ADAPTER_KEY}: HoneyFactory returned inconsistent basket-mode state`);
    }

    if (basketMode && weights.reduce((sum, weight) => sum + weight, 0n) !== WAD) {
      throw new Error(`${ADAPTER_KEY}: HoneyFactory basket weights do not sum to 100%`);
    }

    const factoryState = await readHoneyFactoryBatch(
      input,
      assets.flatMap((asset, index) => [
        {
          label: `honey:vault:${index}`,
          contract: factory,
          data: encodeAddressCallData(SELECTORS.vaults, asset),
          allowFailure: true as const,
        },
        {
          label: `honey:collected-fees:${index}`,
          contract: factory,
          data: encodeAddressCallData(SELECTORS.collectedAssetFees, asset),
          allowFailure: true as const,
        },
        {
          label: `honey:redeem-rate:${index}`,
          contract: factory,
          data: encodeAddressCallData(SELECTORS.redeemRates, asset),
          allowFailure: true as const,
        },
        {
          label: `honey:is-pegged:${index}`,
          contract: factory,
          data: encodeAddressCallData(SELECTORS.isPegged, asset),
          allowFailure: true as const,
        },
        {
          label: `honey:relative-cap:${index}`,
          contract: factory,
          data: encodeAddressCallData(SELECTORS.relativeCap, asset),
          allowFailure: true as const,
        },
      ]),
      signal,
      ctx,
      rpcUrl,
      fallbackRpcUrl,
    );
    const assetStates = assets.map((asset, index) => ({
      asset,
      index,
      vault: addressFromWord(honeyUint(factoryState, `honey:vault:${index}`), `vaults(${asset})`),
      collectedFees: requireUint(
        honeyUint(factoryState, `honey:collected-fees:${index}`),
        `collectedAssetFees(${asset})`,
      ),
      redeemRate: requireUint(
        honeyUint(factoryState, `honey:redeem-rate:${index}`),
        `redeemRates(${asset})`,
      ),
      isPegged: requireBool(
        honeyUint(factoryState, `honey:is-pegged:${index}`),
        `isPegged(${asset})`,
      ),
      relativeCap: requireUint(
        honeyUint(factoryState, `honey:relative-cap:${index}`),
        `relativeCap(${asset})`,
      ),
    }));

    const vaultState = await readHoneyFactoryBatch(
      input,
      assetStates.flatMap(({ asset, vault, index }) => [
        { label: `honey:vault-asset:${index}`, contract: vault, data: SELECTORS.asset, allowFailure: true as const },
        { label: `honey:vault-paused:${index}`, contract: vault, data: SELECTORS.paused, allowFailure: true as const },
        { label: `honey:custody-info:${index}`, contract: vault, data: SELECTORS.custodyInfo, allowFailure: true as const },
        {
          label: `honey:factory-shares:${index}`,
          contract: vault,
          data: encodeAddressCallData(SELECTORS.balanceOf, factory),
          allowFailure: true as const,
        },
        { label: `honey:asset-decimals:${index}`, contract: asset, data: SELECTORS.decimals, allowFailure: true as const },
      ]),
      signal,
      ctx,
      rpcUrl,
      fallbackRpcUrl,
    );
    const vaultStates = assetStates.map((state) => {
      const { asset, vault, index, collectedFees, redeemRate } = state;
      if (addressFromWord(honeyUint(vaultState, `honey:vault-asset:${index}`), `vault ${vault} asset()`).toLowerCase() !== asset.toLowerCase()) {
        throw new Error(`${ADAPTER_KEY}: vault ${vault} asset identity mismatch`);
      }
      const vaultPaused = requireBool(
        honeyUint(vaultState, `honey:vault-paused:${index}`),
        `vault ${vault} paused()`,
      );
      const custodyInfo = decodeCustodyInfo(vaultState.get(`honey:custody-info:${index}`) ?? null);
      const factoryShares = requireUint(
        honeyUint(vaultState, `honey:factory-shares:${index}`),
        `vault ${vault} balanceOf(factory)`,
      );
      const assetDecimalsRaw = requireUint(
        honeyUint(vaultState, `honey:asset-decimals:${index}`),
        `asset ${asset} decimals()`,
      );
      if (collectedFees > factoryShares) {
        throw new Error(`${ADAPTER_KEY}: collected fees exceed factory shares for ${asset}`);
      }
      if (redeemRate > WAD) throw new Error(`${ADAPTER_KEY}: redeem rate exceeds 100% for ${asset}`);
      if (assetDecimalsRaw > 36n) throw new Error(`${ADAPTER_KEY}: asset decimals exceed 36 for ${asset}`);
      const liquidityHolder = custodyInfo.isCustodyVault ? custodyInfo.custodyAddress : vault;
      if (liquidityHolder == null) throw new Error(`${ADAPTER_KEY}: custody vault ${vault} has no custody address`);
      return {
        ...state,
        vaultPaused,
        custodyInfo,
        factoryShares,
        assetDecimals: Number(assetDecimalsRaw),
        liquidityHolder,
      };
    });

    const derivedState = await readHoneyFactoryBatch(
      input,
      vaultStates.flatMap(({ asset, vault, index, custodyInfo, factoryShares, collectedFees, liquidityHolder }) => {
        const calls = [
          {
            label: `honey:converted-assets:${index}`,
            contract: vault,
            data: `${SELECTORS.convertToAssets}${encodeUint256(factoryShares - collectedFees)}`,
            allowFailure: true as const,
          },
          {
            label: `honey:holder-balance:${index}`,
            contract: asset,
            data: encodeAddressCallData(SELECTORS.balanceOf, liquidityHolder),
            allowFailure: true as const,
          },
        ];
        if (custodyInfo.isCustodyVault) {
          calls.push({
            label: `honey:custody-allowance:${index}`,
            contract: asset,
            data: encodeAddressCallData(SELECTORS.allowance, liquidityHolder, vault),
            allowFailure: true as const,
          });
        }
        return calls;
      }),
      signal,
      ctx,
      rpcUrl,
      fallbackRpcUrl,
    );

    const stableAssets = new Map(params.stableAssets.map((asset) => [asset.address.toLowerCase(), asset]));
    const observations = vaultStates.map((state) => {
      const {
        asset,
        assetDecimals,
        custodyInfo,
        index,
        isPegged,
        liquidityHolder,
        redeemRate,
        relativeCap,
        vault,
        vaultPaused,
      } = state;
      const convertedAssets = requireUint(
        honeyUint(derivedState, `honey:converted-assets:${index}`),
        `vault ${vault} convertToAssets(net shares)`,
      );
      const holderBalance = requireUint(
        honeyUint(derivedState, `honey:holder-balance:${index}`),
        `asset ${asset} balanceOf(liquidity holder)`,
      );
      const allowance = custodyInfo.isCustodyVault
        ? requireUint(
            honeyUint(derivedState, `honey:custody-allowance:${index}`),
            `asset ${asset} custody allowance`,
          )
        : convertedAssets;
      const immediatelyAvailable = minBigInt(convertedAssets, holderBalance, allowance);

      const stableAsset = stableAssets.get(asset.toLowerCase()) ?? null;
      if (stableAsset && stableAsset.decimals !== assetDecimals) {
        throw new Error(`${ADAPTER_KEY}: configured decimals mismatch for ${asset}`);
      }
      return {
        asset,
        assetDecimals,
        stableAsset,
        isPegged,
        vaultPaused,
        relativeCap,
        redeemRate,
        immediatelyAvailable,
        weight: weights[index]!,
      };
    });

    const skippedAssets = observations
      .filter((observation) => !observation.stableAsset || !observation.isPegged)
      .map((observation) => observation.asset);
    const capGuardBlocked = observations.some((observation) => observation.relativeCap < WAD);
    let capacityUsd = 0;
    if (!factoryPaused && globalCap >= WAD && !capGuardBlocked) {
      if (basketMode) {
        const funded = observations.filter((observation) => observation.weight > 0n);
        const basketBlocked = funded.some(
          (observation) => observation.vaultPaused || observation.immediatelyAvailable === 0n,
        );
        if (!basketBlocked && funded.length > 0) {
          const redeemableHoneyWad = funded.reduce<bigint | null>((minimum, observation) => {
            const assetBound = normalizeToWad(
              observation.immediatelyAvailable,
              observation.assetDecimals,
            ) * WAD / observation.weight;
            return minimum == null || assetBound < minimum ? assetBound : minimum;
          }, null) ?? 0n;
          const stableWeight = funded.reduce(
            (sum, observation) => sum + (observation.stableAsset && observation.isPegged ? observation.weight : 0n),
            0n,
          );
          capacityUsd = decimalNumberFromBigInt(redeemableHoneyWad * stableWeight / WAD, 18);
        }
      } else {
        capacityUsd = observations.reduce((sum, observation) => {
          if (!observation.stableAsset || !observation.isPegged || observation.vaultPaused) return sum;
          return sum + decimalNumberFromBigInt(
            observation.immediatelyAvailable,
            observation.stableAsset.decimals,
          );
        }, 0);
      }
    }
    const maxFeeBps = observations.reduce((maximum, observation) => {
      if (!observation.stableAsset || !observation.isPegged || (basketMode && observation.weight === 0n)) {
        return maximum;
      }
      const feeBps = Number(WAD - observation.redeemRate) * 10_000 / Number(WAD);
      return Math.max(maximum, feeBps);
    }, 0);
    const routeOpen = capacityUsd > 0;
    return {
      metadata: buildRedemptionSnapshotMetadata({
        capacityUsd,
        capacityKind: "live-direct",
        freshnessKind: "same-run-onchain",
        ...(routeOpen
          ? {
              routeStatus: "open" as const,
              routeStatusSource: "onchain" as const,
              routeStatusReason:
                `HoneyFactory ${basketMode ? "basket" : "asset-specific"} redemption is unpaused with positive bounded vault liquidity`,
            }
          : {}),
        holderEligibility: "any-holder",
        settlementDelaySec: 0,
        sourceUrls: params.sourceUrls,
        feeBps: maxFeeBps,
      }),
      warnings: skippedAssets.length > 0
        ? [reserveDegradedWarning(
            "redemption-capacity-non-stable-assets-skipped",
            `${ADAPTER_KEY} excluded unconfigured or non-pegged collateral from redemption capacity: ${skippedAssets.join(", ")}`,
          )]
        : [],
    };
  } catch (error) {
    const message = toErrorMessage(error);
    return {
      warnings: [reserveDegradedWarning(
        "redemption-capacity-unavailable",
        `${ADAPTER_KEY} withheld the complete redemption-capacity block: ${message}`,
      )],
    };
  }
}

export async function fetchEvmBranchBalancesReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, ADAPTER_KEY);
  const params = readBranchBalanceParams(config, ADAPTER_KEY);
  const debtSelector = params.debtSelector;
  const debtDecimals = params.debtDecimals ?? DEFAULT_DEBT_DECIMALS;
  const onchain = makeOnchainCallers(input, {
    signal,
    ctx,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
  });
  const redemptionCapacityParams = (
    params as typeof params & { redemptionCapacity?: HoneyFactoryRedemptionCapacityParams }
  ).redemptionCapacity;

  const [balances, redemptionFeeBps, debtRaw, redemptionCapacity] = await Promise.all([
    fetchBranchBalances(input, params, signal, ctx),
    probeOptionalRedemptionRateBps(
      input,
      params.redemptionRateProbe,
      signal,
      ctx,
      params.rpcUrl,
      params.fallbackRpcUrl,
    ),
    debtSelector
      ? onchain.uint256(params.debtContract ?? params.branches[0].holder, debtSelector)
      : Promise.resolve(null),
    redemptionCapacityParams?.kind === "honey-factory-vaults"
      ? observeHoneyFactoryRedemptionCapacity(
          input,
          redemptionCapacityParams,
          signal,
          ctx,
          params.rpcUrl,
          params.fallbackRpcUrl,
        )
      : Promise.resolve<RedemptionCapacityObservation>({ warnings: [] }),
  ]);

  const priceMapWarnings: LiveReserveWarning[] = [];
  const priceMap = await fetchBranchPriceMap(balances, signal, priceMapWarnings, ctx);

  const baseMetadata = {
    ...(redemptionFeeBps != null
      ? buildRedemptionSnapshotMetadata({
          feeBps: redemptionFeeBps,
          freshnessKind: "same-run-onchain",
        })
      : {}),
    ...(redemptionCapacity.metadata ?? {}),
  };
  const commonWarnings = [...priceMapWarnings, ...redemptionCapacity.warnings];

  // If debt reconciliation is configured, compute collateralizationRatio from
  // the sum of priced branch balances and the on-chain debt read.
  if (debtSelector && debtRaw != null) {
    const totalDebtUsd = decimalNumberFromBigInt(debtRaw, debtDecimals);
    const totalCollateralUsd = balances.reduce((sum, entry) => {
      if (entry.balanceRaw == null || entry.balanceRaw <= 0n) return sum;
      const price = entry.branch.priceUsd ?? priceMap.get(entry.branch.name);
      if (price == null) return sum;
      return sum + decimalNumberFromBigInt(entry.balanceRaw, entry.branch.token.decimals) * price;
    }, 0);
    const collateralizationRatio = totalDebtUsd > 0 ? totalCollateralUsd / totalDebtUsd : null;
    const warnings: LiveReserveWarning[] = [];
    if (collateralizationRatio != null && collateralizationRatio < 1.0) {
      warnings.push(reserveDegradedWarning(
        "undercollateralized",
        `${ADAPTER_KEY} collateralization ratio ${collateralizationRatio.toFixed(4)} below 1.0 (collateral ${totalCollateralUsd.toFixed(2)} USD vs debt ${totalDebtUsd.toFixed(2)} USD)`,
      ));
    }
    const result = adaptBranchBalanceReserves({
      adapterKey: ADAPTER_KEY,
      balances,
      priceMap,
      metadata: {
        ...(baseMetadata ?? {}),
        totalDebtUsd,
        ...(collateralizationRatio != null ? { collateralizationRatio } : {}),
      },
    });
    const merged = [...warnings, ...commonWarnings];
    return merged.length > 0
      ? { ...result, warnings: [...(result.warnings ?? []), ...merged] }
      : result;
  }

  const result = adaptBranchBalanceReserves({
    adapterKey: ADAPTER_KEY,
    balances,
    priceMap,
    metadata: baseMetadata,
  });
  return commonWarnings.length > 0
    ? { ...result, warnings: [...(result.warnings ?? []), ...commonWarnings] }
    : result;
}
