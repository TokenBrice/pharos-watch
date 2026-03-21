import type { LiveReservesConfig, ReserveSlice, StablecoinMeta } from "@shared/types";
import type { AdapterContext, AdapterResult } from "./index";
import {
  fetchErc20TotalSupply,
  fetchJsonWithRetry,
  getAdapterTimeout,
  getJsonPath,
  isHttpJsonInput,
  isReserveRisk,
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
    const onchain = requireOnchainInput(primary, "single-asset");
    const probeContract = coin.contracts?.find((contract) => contract.chain === onchain.chain)?.address;
    if (!probeContract) {
      throw new Error(`single-asset adapter could not find a ${onchain.chain} contract for ${coin.id}`);
    }
    const totalSupply = await fetchErc20TotalSupply(
      onchain,
      probeContract,
      signal,
      ctx,
      params.rpcUrl,
      params.fallbackRpcUrl,
    );
    if (totalSupply == null || totalSupply <= 0n) {
      throw new Error("single-asset adapter totalSupply probe failed");
    }
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
