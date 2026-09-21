import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { getCanonicalReserveAssetRisk } from "@shared/lib/reserve-asset-risk";
import type { AdapterContext, AdapterResult } from "./types";
import {
  decimalNumberFromBigInt,
  fetchDefiLlamaPrices,
  makeOnchainCallers,
  notApplicableFreshnessMetadata,
  requireOnchainInput,
  slicesFromValues,
  valueUsdFromBigIntPrice,
} from "./helpers";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";

const TOKEN_META = {
  wstETH: {
    chain: "ethereum",
    // The pool's `getTotalRawCollaterals()` reports collateral in the pool's *base*
    // token unit: the wstETH pool's base token is stETH (wstETH enters through the
    // pool's rate provider, currently ~1.2436 stETH per wstETH), so the raw amount
    // is stETH-denominated and must be valued with the stETH price. The issuer API
    // names the same figure `stETHBalance`. Pricing it with the wstETH price
    // overstates this pool by ~24%.
    rawUnitAddress: "0xae7ab96520de3a18e5e111b5eaab095312d7fe84", // stETH
    rawUnitDecimals: 18,
    risk: getCanonicalReserveAssetRisk("WSTETH") ?? "low",
    name: "wstETH (Lido)",
    poolAddress: "0x6Ecfa38FeE8a5277B91eFdA204c235814F0122E8",
  },
  wbtc: {
    chain: "ethereum",
    // The WBTC pool's rate provider is identity (rate 1), so its raw collateral is
    // WBTC itself, expressed on the pool's unified 1e18 scale.
    rawUnitAddress: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", // WBTC
    rawUnitDecimals: 18,
    risk: getCanonicalReserveAssetRisk("WBTC") ?? "medium",
    name: "WBTC",
    poolAddress: "0xAB709e26Fa6B0A30c119D8c55B887DeD24952473",
  },
};

const GET_TOTAL_RAW_COLLATERALS_SELECTOR = "0xee65a03c";
const GET_TOTAL_RAW_DEBTS_SELECTOR = "0xf9d45fd2";

type FxBalance = { key: keyof typeof TOKEN_META; amountRaw: bigint; debtRaw: bigint };

async function buildFxResult(
  balances: FxBalance[],
  signal: AbortSignal,
  ctx: AdapterContext | undefined,
): Promise<AdapterResult> {
  if (balances.length === 0) {
    throw new Error("fx returned no positive collateral balances");
  }

  const warnings: NonNullable<AdapterResult["warnings"]> = [];
  const priceMap = await fetchDefiLlamaPrices(
    balances.map(({ key }) => ({
      key,
      chain: TOKEN_META[key].chain,
      address: TOKEN_META[key].rawUnitAddress,
    })),
    signal,
    ctx,
    warnings,
  );

  const knownValues = balances.map(({ key, amountRaw }) => {
    const price = priceMap.get(key);
    if (price == null) {
      throw new Error(`Missing DefiLlama price for ${key}`);
    }
    return {
      sourceKey: `fx:${key.toLowerCase()}`,
      value: valueUsdFromBigIntPrice(amountRaw, TOKEN_META[key].rawUnitDecimals, price),
      name: TOKEN_META[key].name,
      risk: TOKEN_META[key].risk,
    };
  });
  const capacityUsd = balances.reduce(
    (sum, entry) => sum + decimalNumberFromBigInt(entry.debtRaw, 18),
    0,
  );

  return {
    slices: slicesFromValues(knownValues),
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...notApplicableFreshnessMetadata({
        proofKind: "fx-pool-direct-onchain",
        poolCount: balances.length,
      }),
      ...(capacityUsd > 0
        ? {
            redemption: {
              capacityUsd,
              capacityKind: "live-proxy-validated" as const,
              freshnessKind: "same-run-api" as const,
              routeStatus: "open" as const,
              routeStatusSource: "protocol-api" as const,
              holderEligibility: "any-holder",
              settlementDelaySec: 0,
              sourceUrls: ["https://fxprotocol.gitbook.io/fx-docs"],
            },
          }
        : {}),
    },
  };
}

export async function fetchFxReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, "fx");
  const params = parseLiveReserveAdapterParams("fx", config.params);
  const balances = await Promise.all(
    (Object.keys(TOKEN_META) as Array<keyof typeof TOKEN_META>).map(async (key): Promise<FxBalance> => {
      const meta = TOKEN_META[key];
      const onchain = makeOnchainCallers(input, {
        signal,
        ctx,
        rpcUrl: params.rpcUrl,
        fallbackRpcUrl: params.fallbackRpcUrl,
        timeoutMs: 12_000,
      });
      const [amountRaw, debtRaw] = await Promise.all([
        onchain.uint256(meta.poolAddress, GET_TOTAL_RAW_COLLATERALS_SELECTOR),
        onchain.uint256(meta.poolAddress, GET_TOTAL_RAW_DEBTS_SELECTOR),
      ]);
      if (amountRaw == null) {
        throw new Error(`fx on-chain collateral read failed for ${key}`);
      }
      if (debtRaw == null) {
        throw new Error(`fx on-chain debt read failed for ${key}`);
      }
      return { key, amountRaw, debtRaw };
    }),
  );

  return buildFxResult(
    balances.filter((entry) => entry.amountRaw > 0n),
    signal,
    ctx,
  );
}
