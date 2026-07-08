import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { encodeAddress, encodeUint256 } from "../../lib/evm-selectors";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchDefiLlamaPrices,
  makeOnchainCallers,
  notApplicableFreshnessMetadata,
  requireOnchainInput,
  slicesFromValues,
  valueUsdFromBigIntPrice,
} from "./helpers";

/**
 * Abracadabra cauldron config as defined in the adapter params schema.
 * Each cauldron is an isolated lending market holding a single collateral type.
 */
interface CauldronConfig {
  address: string;
  collateralSymbol: string;
  collateralAddress: string;
  collateralDecimals: number;
  risk: ReserveSlice["risk"];
  coinId?: string;
  depType?: ReserveSlice["depType"];
  version?: 2 | 3 | 4;
}

interface AbracadabraParams {
  rpcUrl?: string;
  fallbackRpcUrl?: string;
  bentoBoxAddress: string;
  cauldrons: CauldronConfig[];
}

/** Selector for `totalCollateralShare() returns (uint256)` */
const TOTAL_COLLATERAL_SHARE_SELECTOR = "0x473e3ce7";
/** Selector for `toAmount(address token, uint256 share, bool roundUp) returns (uint256)` */
const TO_AMOUNT_SELECTOR = "0x56623118";

function encodeToAmountCall(token: string, share: bigint): string {
  return `${TO_AMOUNT_SELECTOR}${encodeAddress(token)}${encodeUint256(share)}${encodeUint256(0n)}`;
}

/** Parsed result from reading a single cauldron on-chain. */
export interface CauldronCollateralReading {
  cauldron: CauldronConfig;
  collateralAmountRaw: bigint;
}

function readParams(config: LiveReservesConfig): AbracadabraParams {
  return parseLiveReserveAdapterParams("abracadabra", config.params);
}

/**
 * Pure transform: given per-cauldron collateral readings (already converted
 * from BentoBox shares to underlying token amounts) and their USD prices,
 * produce normalized reserve slices.
 */
export function adaptAbracadabraReserves(
  readings: CauldronCollateralReading[],
  priceMap: Map<string, number>,
): AdapterResult {
  const values: Array<{
    value: number;
    name: string;
    risk: ReserveSlice["risk"];
    coinId?: string;
    depType?: ReserveSlice["depType"];
  }> = [];

  for (const { cauldron, collateralAmountRaw } of readings) {
    if (collateralAmountRaw <= 0n) continue;

    const price = priceMap.get(cauldron.collateralAddress.toLowerCase());
    if (price == null) {
      throw new Error(
        `abracadabra adapter missing DefiLlama price for ${cauldron.collateralSymbol} (${cauldron.collateralAddress})`,
      );
    }

    const usd = valueUsdFromBigIntPrice(collateralAmountRaw, cauldron.collateralDecimals, price);
    if (!Number.isFinite(usd) || usd <= 0) continue;

    values.push({
      value: usd,
      name: cauldron.collateralSymbol,
      risk: cauldron.risk,
      ...(cauldron.coinId ? { coinId: cauldron.coinId } : {}),
      ...(cauldron.depType ? { depType: cauldron.depType } : {}),
    });
  }

  const slices = slicesFromValues(values);
  const totalUsd = values.reduce((sum, v) => sum + v.value, 0);

  return {
    slices,
    metadata: {
      cauldronCount: readings.length,
      activeCauldronCount: values.length,
      totalCollateralUsd: totalUsd,
      ...notApplicableFreshnessMetadata({
        proofKind: "abracadabra-cauldron-collateral",
      }),
    },
  };
}

/**
 * I/O entrypoint: reads totalCollateralShare from each configured cauldron,
 * converts the share to the underlying token amount via BentoBox.toAmount,
 * fetches collateral prices from DefiLlama, and returns the normalized
 * reserve breakdown.
 */
export async function fetchAbracadabraReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, "abracadabra");
  const params = readParams(config);
  const onchain = makeOnchainCallers(input, {
    signal,
    ctx,
    rpcUrl: params.rpcUrl,
    fallbackRpcUrl: params.fallbackRpcUrl,
  });

  const shareReadings = await Promise.all(
    params.cauldrons.map(async (cauldron) => {
      const raw = await onchain.uint256(cauldron.address, TOTAL_COLLATERAL_SHARE_SELECTOR);

      if (raw == null) {
        throw new Error(
          `abracadabra adapter could not read totalCollateralShare for cauldron ${cauldron.address} (${cauldron.collateralSymbol})`,
        );
      }

      return { cauldron, share: raw };
    }),
  );

  const cache = ctx?.requestCache;
  const readings: CauldronCollateralReading[] = await Promise.all(
    shareReadings.map(async ({ cauldron, share }): Promise<CauldronCollateralReading> => {
      if (share === 0n) {
        return { cauldron, collateralAmountRaw: 0n };
      }

      const collateralKey = cauldron.collateralAddress.toLowerCase();
      const cacheKey = `abracadabra:toAmount:${input.chain}:${params.bentoBoxAddress.toLowerCase()}:${collateralKey}:${share.toString()}`;
      const cached = cache?.get(cacheKey) as Promise<bigint | null> | undefined;
      const promise: Promise<bigint | null> =
        cached
        ?? onchain.uint256(params.bentoBoxAddress, encodeToAmountCall(cauldron.collateralAddress, share));
      if (!cached && cache) cache.set(cacheKey, promise);
      const amount = await promise;

      if (amount == null) {
        throw new Error(
          `abracadabra adapter could not convert share to amount for cauldron ${cauldron.address} (${cauldron.collateralSymbol})`,
        );
      }

      return { cauldron, collateralAmountRaw: amount };
    }),
  );

  const uniqueAssets = new Map(
    params.cauldrons.map((c) => [
      c.collateralAddress.toLowerCase(),
      {
        key: c.collateralAddress.toLowerCase(),
        chain: input.chain,
        address: c.collateralAddress,
      },
    ]),
  );

  const priceMap = await fetchDefiLlamaPrices(
    Array.from(uniqueAssets.values()),
    signal,
    ctx,
  );

  return adaptAbracadabraReserves(readings, priceMap);
}
