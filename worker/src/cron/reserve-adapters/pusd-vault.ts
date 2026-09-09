import type { ContractDeployment, ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { CHAIN_META } from "@shared/lib/chains";
import { parseLiveReserveAdapterParams, type LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import { encodeBalanceOfCallData, TOTAL_SUPPLY_SELECTOR } from "../../lib/evm-selectors";
import {
  buildCoverageShortfallWarnings,
  buildRedemptionSnapshotMetadata,
  buildUnknownExposureWarning,
  computeUnknownExposurePct,
  decimalNumberFromBigInt,
  fetchErc20TotalSupply,
  fetchTronErc20TotalSupply,
  makeOnchainCallers,
  normalizeSlices,
  notApplicableFreshnessMetadata,
  requireOnchainInput,
  reserveDegradedWarning,
  reserveInfoWarning,
} from "./helpers";
import { resolveCoinContractAddress } from "./evm";
import type { AdapterContext, AdapterResult } from "./types";

const ADAPTER_KEY = "pusd-vault";

type PusdVaultParams = LiveReserveAdapterParamsByKey["pusd-vault"];

interface PusdVaultAssetConfig {
  address: string;
  decimals: number;
}


interface PusdVaultChainAssetConfig {
  address: string;
  decimals: number;
  name: string;
  risk: ReserveSlice["risk"];
  coinId?: string;
  depType?: ReserveSlice["depType"];
}

function readParams(config: LiveReservesConfig) {
  return parseLiveReserveAdapterParams(ADAPTER_KEY, config.params);
}

function isEvmContract(contract: ContractDeployment): boolean {
  return CHAIN_META[contract.chain]?.type === "evm";
}

function isTronContract(contract: ContractDeployment): boolean {
  return CHAIN_META[contract.chain]?.type === "tron";
}

/** True when an EVM chain has an RPC entry in the context's chainRpc map.
 *  A missing chainRpc map (smoke/test contexts) means the caller did not
 *  supply RPC resolution, so the chain is treated as readable and left to
 *  fail through its normal read path. */
function chainHasRpc(chain: string, ctx?: AdapterContext): boolean {
  const chainRpcs = ctx?.chainRpcs;
  return chainRpcs == null || chainRpcs.has(chain);
}

/**
 * Reads a wrapper token's backing vault: sums `balanceOf(vaultAddress)` across
 * one or more underlying ERC-20 variants (e.g. native USDC + bridged USDC.e)
 * and compares it to the wrapper token's own `totalSupply()`. Built for
 * pUSD-Polymarket, whose immutable backing vault is a separate contract from
 * the CollateralToken itself rather than a value discoverable via a wrapper
 * selector (contrast `m0-wrapper-underlying`).
 *
 * With `params.chains` the adapter instead reads the vault on every configured
 * chain, emits one slice per configured asset, and compares the aggregate
 * holdings against the coin's full multichain `totalSupply()` (EVM + Tron,
 * mirroring `usd1-bundle-oracle`'s supply scope). Assets configured without a
 * `coinId` count toward `unknownExposurePct` instead of a tracked slice.
 */
export async function fetchPusdVaultReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const params = readParams(config);
  if (params.chains != null) {
    return fetchMultichainVaultReserves(coin, params, config, signal, ctx);
  }
  return fetchSingleChainVaultReserves(coin, params, config, signal, ctx);
}

async function fetchSingleChainVaultReserves(
  coin: StablecoinMeta,
  params: PusdVaultParams,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  if (params.vaultAddress == null || params.assets == null || params.slice == null) {
    throw new Error(`${ADAPTER_KEY}: vaultAddress, assets and slice are required without chains`);
  }
  const vaultAddress = params.vaultAddress;
  const assets: PusdVaultAssetConfig[] = params.assets;
  const sliceConfig = params.slice;

  const input = requireOnchainInput(config.inputs.primary, ADAPTER_KEY);
  const tokenAddress = resolveCoinContractAddress(coin, input.chain);
  if (!tokenAddress) {
    throw new Error(`${ADAPTER_KEY}: no ${input.chain} contract configured for ${coin.id}`);
  }
  const tokenDecimals = coin.contracts?.find((contract) => contract.chain === input.chain)?.decimals;
  if (tokenDecimals == null) {
    throw new Error(`${ADAPTER_KEY}: missing token decimals for ${coin.id}`);
  }

  const timeoutMs = 12_000;
  const onchain = makeOnchainCallers(input, {
    signal,
    ctx,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
    timeoutMs,
  });

  const [assetBalancesRaw, totalSupplyRaw] = await Promise.all([
    Promise.all(
      assets.map((asset) => onchain.uint256(asset.address, encodeBalanceOfCallData(vaultAddress))),
    ),
    onchain.uint256(tokenAddress, TOTAL_SUPPLY_SELECTOR),
  ]);

  if (totalSupplyRaw == null || totalSupplyRaw <= 0n) {
    throw new Error(`${ADAPTER_KEY}: totalSupply() failed for ${coin.id}`);
  }

  let vaultBalanceUsd = 0;
  assetBalancesRaw.forEach((raw, index) => {
    if (raw == null) {
      throw new Error(`${ADAPTER_KEY}: balanceOf(vault) failed for asset ${assets[index]?.address}`);
    }
    vaultBalanceUsd += decimalNumberFromBigInt(raw, assets[index]?.decimals ?? 0);
  });

  const supplyUsd = decimalNumberFromBigInt(totalSupplyRaw, tokenDecimals);
  const collateralizationRatio = supplyUsd > 0 ? vaultBalanceUsd / supplyUsd : undefined;
  const capacityRatioOfSupply = collateralizationRatio != null ? Math.min(1, collateralizationRatio) : undefined;
  const warnings = buildCoverageShortfallWarnings({
    code: "reserve-undercollateralized",
    message: (pct) => `pUSD backing vault USDC balance covers ${pct}% of pUSD supply`,
    coverageRatio: collateralizationRatio,
  });

  return {
    slices: [
      {
        name: sliceConfig.name,
        pct: 100,
        risk: sliceConfig.risk,
        ...(sliceConfig.coinId ? { coinId: sliceConfig.coinId } : {}),
        ...(sliceConfig.depType ? { depType: sliceConfig.depType } : {}),
        blacklistable: true,
      },
    ],
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...notApplicableFreshnessMetadata({ proofKind: "pusd-vault-balance" }),
      chain: input.chain,
      vaultAddress,
      tokenAddress,
      totalSupplyRaw: totalSupplyRaw.toString(),
      vaultBalanceUsd,
      supplyUsd,
      ...(collateralizationRatio != null && Number.isFinite(collateralizationRatio)
        ? { collateralizationRatio }
        : {}),
      ...buildRedemptionSnapshotMetadata({
        capacityUsd: vaultBalanceUsd,
        ...(capacityRatioOfSupply != null ? { capacityRatioOfSupply } : {}),
        capacityKind: "live-direct-bounded",
        freshnessKind: "same-run-onchain",
        routeStatus: "open",
        routeStatusSource: "onchain",
        holderEligibility: "any-holder",
        settlementDelaySec: 0,
        ...(params.sourceUrls ? { sourceUrls: params.sourceUrls } : {}),
      }),
    },
  };
}

interface MultichainHolding extends PusdVaultChainAssetConfig {
  balanceRaw: bigint;
  usd: number;
}

async function fetchMultichainVaultReserves(
  coin: StablecoinMeta,
  params: PusdVaultParams,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, ADAPTER_KEY);
  const chains = params.chains ?? [];
  const timeoutMs = 12_000;

  const chainHoldings = await Promise.all(
    chains.map(async (chainConfig) => {
      if (CHAIN_META[chainConfig.chain]?.type !== "evm") {
        throw new Error(`${ADAPTER_KEY}: chain ${chainConfig.chain} is not an EVM chain`);
      }
      const onchain = makeOnchainCallers(
        { chain: chainConfig.chain, rpcMode: input.rpcMode },
        {
          signal,
          ctx,
          rpcUrl: params.rpcUrl,
          fallbackRpcUrl: params.fallbackRpcUrl,
          timeoutMs,
        },
      );
      const balances = await Promise.all(
        chainConfig.assets.map((asset) =>
          onchain.uint256(asset.address, encodeBalanceOfCallData(chainConfig.vaultAddress)),
        ),
      );
      const assets: MultichainHolding[] = chainConfig.assets.map((asset, index) => {
        const raw = balances[index];
        if (raw == null) {
          throw new Error(`${ADAPTER_KEY}: balanceOf(vault) failed for ${asset.address} on ${chainConfig.chain}`);
        }
        return { ...asset, balanceRaw: raw, usd: decimalNumberFromBigInt(raw, asset.decimals) };
      });
      return { chain: chainConfig.chain, vaultAddress: chainConfig.vaultAddress, assets };
    }),
  );

  const holdings = chainHoldings.flatMap((entry) => entry.assets);
  const vaultBalanceUsd = holdings.reduce((sum, holding) => sum + holding.usd, 0);
  if (!Number.isFinite(vaultBalanceUsd) || vaultBalanceUsd <= 0) {
    throw new Error(`${ADAPTER_KEY}: vault holdings sum to zero for ${coin.id}`);
  }
  const unknownUsd = holdings
    .filter((holding) => holding.coinId == null)
    .reduce((sum, holding) => sum + holding.usd, 0);
  const unknownExposurePct = computeUnknownExposurePct(unknownUsd, vaultBalanceUsd);

  const slices = normalizeSlices(
    holdings.map((holding) => ({
      name: holding.name,
      pct: (holding.usd / vaultBalanceUsd) * 100,
      risk: holding.risk,
      ...(holding.coinId ? { coinId: holding.coinId } : {}),
      ...(holding.depType ? { depType: holding.depType } : {}),
      blacklistable: true,
    })),
  );

  // The liability denominator is the coin's full multichain supply (EVM +
  // Tron), mirroring usd1-bundle-oracle's supply scope. Chains that cannot be
  // read are omitted loudly (warning + supplyReadComplete=false), never
  // silently.
  const allContracts = coin.contracts ?? [];
  const tronContracts = allContracts.filter(isTronContract);
  const evmContracts = allContracts.filter(isEvmContract);
  const omittedNonEvmChains = allContracts
    .filter((contract) => !isEvmContract(contract) && !isTronContract(contract))
    .map((contract) => contract.chain);
  const readableContracts = [...evmContracts, ...tronContracts];
  if (readableContracts.length === 0) {
    throw new Error(`${ADAPTER_KEY}: no EVM or Tron contracts available for ${coin.id}`);
  }

  const supplyReads = await Promise.all(
    readableContracts.map(
      async (contract): Promise<{ chain: string; tokenAddress: string; decimals: number | null; raw: bigint | null; noRpc: boolean }> => {
        if (contract.decimals == null) {
          return { chain: contract.chain, tokenAddress: contract.address, decimals: null, raw: null, noRpc: false };
        }
        if (!isTronContract(contract) && !chainHasRpc(contract.chain, ctx)) {
          return { chain: contract.chain, tokenAddress: contract.address, decimals: contract.decimals, raw: null, noRpc: true };
        }
        const raw = isTronContract(contract)
          ? await fetchTronErc20TotalSupply(contract.address, signal, ctx)
          : await fetchErc20TotalSupply(
              { ...input, chain: contract.chain },
              contract.address,
              signal,
              ctx,
              params.rpcUrl,
              params.fallbackRpcUrl,
            );
        return { chain: contract.chain, tokenAddress: contract.address, decimals: contract.decimals, raw, noRpc: false };
      },
    ),
  );

  const successful = supplyReads.filter(
    (entry): entry is { chain: string; tokenAddress: string; decimals: number; raw: bigint; noRpc: boolean } =>
      entry.raw != null && entry.raw > 0n && entry.decimals != null,
  );
  // A null read is an RPC/read failure (or a missing decimals config); a zero
  // read is a valid empty deployment.
  const failedChains = supplyReads.filter((entry) => entry.raw == null && !entry.noRpc).map((entry) => entry.chain);
  const omittedNoRpcChains = supplyReads.filter((entry) => entry.noRpc).map((entry) => entry.chain);

  if (successful.length === 0) {
    throw new Error(`${ADAPTER_KEY}: totalSupply() calls failed on all chains for ${coin.id}`);
  }
  const totalSupplyRaw = successful.reduce((sum, entry) => sum + entry.raw, 0n);
  const supplyUsd = successful.reduce(
    (sum, entry) => sum + decimalNumberFromBigInt(entry.raw, entry.decimals),
    0,
  );
  if (supplyUsd <= 0) {
    throw new Error(`${ADAPTER_KEY}: observed zero supply for ${coin.id}`);
  }

  const collateralizationRatio = vaultBalanceUsd / supplyUsd;
  const capacityRatioOfSupply = Math.min(1, collateralizationRatio);

  const warnings: LiveReserveWarning[] = [
    ...buildCoverageShortfallWarnings({
      code: "reserve-undercollateralized",
      message: (pct) => `pUSD backing vault holdings cover ${pct}% of pUSD multichain supply`,
      coverageRatio: collateralizationRatio,
    }),
  ];
  if (unknownExposurePct > 0) {
    warnings.push(
      buildUnknownExposureWarning({ adapterKey: "pusd-vault", code: "reserve-unmapped-vault-asset",
      message: "pUSD vault holds assets without a tracked coinId mapping",
      unknownExposurePct, }),
    );
  }
  if (omittedNonEvmChains.length > 0) {
    warnings.push(
      reserveInfoWarning("por-supply-chain-omitted", `Supply aggregation omits non-EVM chains: ${omittedNonEvmChains.join(", ")}`),
    );
  }
  if (omittedNoRpcChains.length > 0) {
    warnings.push(
      reserveInfoWarning("por-supply-chain-omitted", `Supply aggregation omits chains with no RPC configured: ${omittedNoRpcChains.join(", ")}`),
    );
  }
  if (failedChains.length > 0) {
    warnings.push(
      reserveDegradedWarning("partial-supply-read-failure", `Supply aggregation omits chains whose totalSupply() read failed: ${failedChains.join(", ")}`),
    );
  }

  return {
    slices,
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...notApplicableFreshnessMetadata({ proofKind: "pusd-vault-balance" }),
      mode: "multichain",
      vaultBalanceUsd,
      supplyUsd,
      collateralizationRatio,
      totalSupplyRaw: totalSupplyRaw.toString(),
      supplyContributions: successful.map((entry) => ({
        chain: entry.chain,
        tokenAddress: entry.tokenAddress,
        supplyRaw: entry.raw.toString(),
        decimals: entry.decimals,
      })),
      supplyReadComplete: failedChains.length === 0,
      chains: chainHoldings.map((entry) => ({
        chain: entry.chain,
        vaultAddress: entry.vaultAddress,
        holdings: entry.assets.map((asset) => ({
          address: asset.address,
          name: asset.name,
          ...(asset.coinId ? { coinId: asset.coinId } : {}),
          balanceRaw: asset.balanceRaw.toString(),
          decimals: asset.decimals,
          usd: asset.usd,
        })),
      })),
      unknownExposurePct,
      ...buildRedemptionSnapshotMetadata({
        capacityUsd: vaultBalanceUsd,
        capacityRatioOfSupply,
        capacityKind: "live-direct-bounded",
        freshnessKind: "same-run-onchain",
        routeStatus: "open",
        routeStatusSource: "onchain",
        holderEligibility: "any-holder",
        settlementDelaySec: 0,
        ...(params.sourceUrls ? { sourceUrls: params.sourceUrls } : {}),
      }),
    },
  };
}
