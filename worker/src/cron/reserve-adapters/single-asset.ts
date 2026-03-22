import type { LiveReservesConfig, ReserveSlice, StablecoinMeta } from "@shared/types";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchOnchainRateBps,
  fetchJsonWithRetry,
  getAdapterTimeout,
  getJsonPath,
  isHttpJsonInput,
  isReserveRisk,
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
  const params = (config.params ?? {}) as Partial<SingleAssetParams>;
  if (!params.label || !params.risk) {
    throw new Error("single-asset adapter requires params.label and params.risk");
  }
  if (!isReserveRisk(params.risk)) {
    throw new Error(`single-asset adapter: invalid risk value "${params.risk}"`);
  }
  return params as SingleAssetParams;
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
    const payload = await fetchJsonWithRetry<Record<string, unknown>>(primary.url, signal, getAdapterTimeout(config, 12_000));
    const value = getJsonPath(payload, probe.path);
    const asString = typeof value === "string" ? value : String(value ?? "");
    if (!asString || asString === "0" || asString === "0.0") {
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
      ...(redemptionFeeBps != null ? { metadata: { redemptionFeeBps } } : {}),
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
  };
}
