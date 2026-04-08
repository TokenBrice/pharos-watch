import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchDefiLlamaPrices,
  fetchOnchainUint256,
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
}

interface AbracadabraParams {
  rpcUrl?: string;
  fallbackRpcUrl?: string;
  cauldrons: CauldronConfig[];
}

/** Selector for `totalCollateralShare() returns (uint256)` */
const TOTAL_COLLATERAL_SHARE_SELECTOR = "0x966f3e46";

/** Parsed result from reading a single cauldron on-chain. */
export interface CauldronCollateralReading {
  cauldron: CauldronConfig;
  collateralShareRaw: bigint;
}

function readParams(config: LiveReservesConfig): AbracadabraParams {
  return parseLiveReserveAdapterParams("abracadabra", config.params);
}

/**
 * Pure transform: given per-cauldron collateral readings and their USD prices,
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

  for (const { cauldron, collateralShareRaw } of readings) {
    if (collateralShareRaw <= 0n) continue;

    const price = priceMap.get(cauldron.collateralAddress.toLowerCase());
    if (price == null) {
      throw new Error(
        `abracadabra adapter missing DefiLlama price for ${cauldron.collateralSymbol} (${cauldron.collateralAddress})`,
      );
    }

    const usd = valueUsdFromBigIntPrice(collateralShareRaw, cauldron.collateralDecimals, price);
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
 * I/O entrypoint: reads totalCollateralShare from each configured cauldron
 * on Ethereum, fetches collateral prices from DefiLlama, and returns the
 * normalized reserve breakdown.
 */
export async function fetchAbracadabraReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, "abracadabra");
  const params = readParams(config);

  // Read totalCollateralShare from each cauldron in parallel
  const readings = await Promise.all(
    params.cauldrons.map(async (cauldron): Promise<CauldronCollateralReading> => {
      const raw = await fetchOnchainUint256({
        contract: cauldron.address,
        data: TOTAL_COLLATERAL_SHARE_SELECTOR,
        signal,
        ctx,
        rpcUrl: params.rpcUrl,
        fallbackRpcUrl: params.fallbackRpcUrl,
        rpcMode: input.rpcMode,
        chain: input.chain,
      });

      if (raw == null) {
        throw new Error(
          `abracadabra adapter could not read totalCollateralShare for cauldron ${cauldron.address} (${cauldron.collateralSymbol})`,
        );
      }

      return { cauldron, collateralShareRaw: raw };
    }),
  );

  // Collect unique collateral addresses for price lookup
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
