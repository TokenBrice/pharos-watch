import type { LiveReservesConfig, ReserveSlice, StablecoinMeta } from "@shared/types";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchOnchainRateBps,
  fetchJsonWithRetry,
  getAdapterTimeout,
  getJsonPath,
  isHttpJsonInput,
  parsePositiveNumericLike,
  probeOnchainTotalSupply,
  requireOnchainInput,
} from "./helpers";

interface SingleAssetParams {
  label: string;
  risk: ReserveSlice["risk"];
  coinId?: string;
  depType?: ReserveSlice["depType"];
  rpcUrl?: string;
  fallbackRpcUrl?: string;
  probe?: {
    kind: "json-path";
    path: string[];
  };
  redemptionRateProbe?: {
    contract: string;
    selector: string;
    decimals?: number;
  };
}

function readParams(config: LiveReservesConfig): SingleAssetParams {
  return parseLiveReserveAdapterParams("single-asset", config.params);
}

export async function fetchSingleAssetReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const params = readParams(config);
  const primary = config.inputs.primary;

  if (isHttpJsonInput(primary)) {
    const probe = params.probe;
    if (!probe || probe.kind !== "json-path") {
      throw new Error("single-asset http-json mode requires params.probe.kind = json-path");
    }
    const payload = await fetchJsonWithRetry<Record<string, unknown>>(
      primary.url,
      signal,
      getAdapterTimeout(config, 12_000),
      ctx,
    );
    const value = getJsonPath(payload, probe.path);
    if (parsePositiveNumericLike(value) == null) {
      throw new Error("single-asset source returned zero/empty probe value");
    }
  } else {
    const onchainInput = requireOnchainInput(primary, "single-asset");
    const supplyProbe = probeOnchainTotalSupply(
      coin,
      onchainInput,
      signal,
      "single-asset",
      ctx,
      params.rpcUrl,
      params.fallbackRpcUrl,
    );
    const redemptionFeeProbe = params.redemptionRateProbe
      ? fetchOnchainRateBps(
          onchainInput,
          params.redemptionRateProbe,
          signal,
          ctx,
          params.rpcUrl,
          params.fallbackRpcUrl,
        )
      : Promise.resolve(null);

    const [, redemptionFeeBps] = await Promise.all([supplyProbe, redemptionFeeProbe]);

    return {
      slices: [{
        name: params.label,
        pct: 100,
        risk: params.risk,
        ...(params.coinId ? { coinId: params.coinId } : {}),
        ...(params.depType ? { depType: params.depType } : {}),
      }],
      metadata: {
        freshnessMode: "not-applicable",
        ...(redemptionFeeBps != null ? { redemptionFeeBps } : {}),
      },
    };
  }

  return {
    slices: [{
      name: params.label,
      pct: 100,
      risk: params.risk,
      ...(params.coinId ? { coinId: params.coinId } : {}),
      ...(params.depType ? { depType: params.depType } : {}),
    }],
    metadata: {
      freshnessMode: "unverified",
    },
  };
}
