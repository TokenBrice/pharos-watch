import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { getCanonicalReserveAssetRisk } from "@shared/lib/reserve-asset-risk";
import type { AdapterContext, AdapterResult } from "./types";
import {
  decimalNumberFromBigInt,
  fetchDefiLlamaPrices,
  fetchJsonWithRetry,
  isHttpJsonInput,
  makeOnchainCallers,
  notApplicableFreshnessMetadata,
  requireJsonInput,
  requireOnchainInput,
  slicesFromValues,
  unverifiedFreshnessMetadata,
  valueUsdFromBigIntPrice,
} from "./helpers";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";

interface FxPoolInfo {
  collateralBalance?: string;
  debtBalance?: string;
}

interface FxPayload {
  data?: {
    poolInfo?: Record<string, FxPoolInfo>;
  };
}

const TOKEN_META = {
  wstETH: {
    chain: "ethereum",
    address: "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",
    apiDecimals: 18,
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
    address: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599",
    apiDecimals: 8,
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

export function adaptFx(payload: FxPayload): {
  balances: FxBalance[];
  unknownKeys: string[];
} {
  const poolInfo = payload.data?.poolInfo ?? {};
  const unexpectedPositiveKeys = Object.entries(poolInfo)
    .filter(([key]) => !(key in TOKEN_META))
    .filter(([, info]) => Number(info?.collateralBalance ?? "0") > 0)
    .map(([key]) => key);

  return {
    balances: (Object.keys(TOKEN_META) as Array<keyof typeof TOKEN_META>)
    .map((key) => {
      const rawBalance = poolInfo[key]?.collateralBalance ?? "0";
      const balance = typeof rawBalance === "string" && /^\d+$/.test(rawBalance)
        ? BigInt(rawBalance)
        : 0n;
      const rawDebt = poolInfo[key]?.debtBalance ?? "0";
      const debt = typeof rawDebt === "string" && /^\d+$/.test(rawDebt)
        ? BigInt(rawDebt)
        : 0n;
      return {
        key,
        amountRaw: balance > 0n ? balance : 0n,
        debtRaw: debt > 0n ? debt : 0n,
      };
    })
    .filter((entry) => entry.amountRaw > 0n),
    unknownKeys: unexpectedPositiveKeys,
  };
}

async function buildFxResult(
  balances: FxBalance[],
  signal: AbortSignal,
  ctx: AdapterContext | undefined,
  freshnessMetadata: Record<string, unknown>,
  sourceUrls: string[],
  valuationByKey: Record<keyof typeof TOKEN_META, { address: string; decimals: number }>,
): Promise<AdapterResult> {
  if (balances.length === 0) {
    throw new Error("fx returned no positive collateral balances");
  }

  const warnings: NonNullable<AdapterResult["warnings"]> = [];
  const priceMap = await fetchDefiLlamaPrices(
    balances.map(({ key }) => ({
      key,
      chain: TOKEN_META[key].chain,
      address: valuationByKey[key].address,
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
      value: valueUsdFromBigIntPrice(amountRaw, valuationByKey[key].decimals, price),
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
      ...freshnessMetadata,
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
              sourceUrls,
            },
          }
        : {}),
    },
  };
}

async function fetchFxApiReserves(
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireJsonInput(config.inputs.primary, "fx");
  const payload = await fetchJsonWithRetry<FxPayload>(input.url, signal, 12_000, ctx);
  const { balances, unknownKeys } = adaptFx(payload);
  if (unknownKeys.length > 0) {
    throw new Error(`fx returned unmapped positive collateral keys with unquantified exposure: ${unknownKeys.join(", ")}`);
  }

  return buildFxResult(
    balances,
    signal,
    ctx,
    unverifiedFreshnessMetadata(
      "protocol-pool-api",
      "FX protocol pool payload does not expose a trustworthy source timestamp",
    ),
    [
      "https://api.aladdin.club/api1/get_fx_tvl",
      "https://fxprotocol.gitbook.io/fx-docs",
    ],
    {
      wstETH: { address: TOKEN_META.wstETH.address, decimals: TOKEN_META.wstETH.apiDecimals },
      wbtc: { address: TOKEN_META.wbtc.address, decimals: TOKEN_META.wbtc.apiDecimals },
    },
  );
}

async function fetchFxOnchainReserves(
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
    notApplicableFreshnessMetadata({
      proofKind: "fx-pool-direct-onchain",
      poolCount: balances.length,
    }),
    [
      "https://fxprotocol.gitbook.io/fx-docs",
    ],
    {
      wstETH: { address: TOKEN_META.wstETH.rawUnitAddress, decimals: TOKEN_META.wstETH.rawUnitDecimals },
      wbtc: { address: TOKEN_META.wbtc.rawUnitAddress, decimals: TOKEN_META.wbtc.rawUnitDecimals },
    },
  );
}

export async function fetchFxReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  if (isHttpJsonInput(config.inputs.primary)) {
    return fetchFxApiReserves(config, signal, ctx);
  }

  return fetchFxOnchainReserves(config, signal, ctx);
}
