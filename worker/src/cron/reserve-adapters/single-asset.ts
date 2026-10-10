import type { ReserveSlice, ReserveAdapterCoin } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import {
  parseLiveReserveAdapterParams,
  type LiveReserveAdapterParamsByKey,
} from "@shared/lib/live-reserve-adapters";
import type { AdapterContext, AdapterResult } from "./types";
import {
  buildCoverageShortfallWarnings,
  fetchJsonWithRetry,
  unverifiedFreshnessMetadata,
  getJsonPath,
  isHttpJsonInput,
  parsePositiveNumericLike,
  parseTimestampLikeToUnixSeconds,
  probeOnchainTotalSupply,
  requireOnchainInput,
  parseFiniteNumber,
} from "./helpers";

type SingleAssetParams = LiveReserveAdapterParamsByKey["single-asset"];
type JsonPathProbe = NonNullable<SingleAssetParams["reserveProbe"]>;

function readParams(config: LiveReservesConfig): SingleAssetParams {
  return parseLiveReserveAdapterParams("single-asset", config.params);
}

function readScaledProbeValue(payload: Record<string, unknown>, probe: JsonPathProbe, label: string): number {
  const rawValue = getJsonPath(payload, probe.path);
  const parsed = parsePositiveNumericLike(rawValue);
  if (parsed == null) {
    throw new Error(`single-asset source returned zero/empty ${label} probe value`);
  }
  const scale = probe.scale ?? 1;
  const scaled = parsed / scale;
  if (!Number.isFinite(scaled) || scaled <= 0) {
    throw new Error(`single-asset source returned invalid scaled ${label} probe value`);
  }
  return scaled;
}

function nativeProbeMetadata(
  payload: Record<string, unknown>,
  params: SingleAssetParams,
  coin: ReserveAdapterCoin,
): AdapterResult["metadata"] {
  if (!params.reserveProbe || !params.supplyProbe || !params.liabilityTimestampComponents) {
    throw new Error("single-asset native probes require reserve, supply and liability components");
  }
  const reserveQuantity = parseFiniteNumber(
    getJsonPath(payload, params.reserveProbe.path), { label: "single-asset native reserve", min: 0 },
  ) / (params.reserveProbe.scale ?? 1);
  const supplyQuantity = readScaledProbeValue(payload, params.supplyProbe, "native supply");
  const probe = params.liabilityTimestampComponents;
  const rows = getJsonPath(payload, probe.path);
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("single-asset native liability components are missing");
  }
  const aliases: Record<string, string> = { ETH: "ethereum", BASE: "base", SOLANA: "solana" };
  const expectedChains = new Set((coin.contracts ?? []).map((contract) => contract.chain));
  const seen = new Set<string>();
  const missingChains = new Set(expectedChains);
  const unreviewedChains: string[] = [];
  let componentTotal = 0;
  let oldestTimestamp: number | null = null;
  const components = rows.map((row: unknown) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error("single-asset native liability component is malformed");
    }
    const component = row as Record<string, unknown>;
    const rawIdentity = component[probe.identityField];
    if (typeof rawIdentity !== "string" || rawIdentity.trim().length === 0) {
      throw new Error("single-asset native liability component identity is missing");
    }
    const sourceIdentity = rawIdentity.trim().toUpperCase();
    const chain = aliases[sourceIdentity] ?? sourceIdentity.toLowerCase();
    if (seen.has(chain)) throw new Error(`single-asset duplicate native liability chain ${chain}`);
    seen.add(chain);
    missingChains.delete(chain);
    if (!expectedChains.has(chain)) unreviewedChains.push(chain);
    const quantity = parseFiniteNumber(component[probe.quantityField], { label: `single-asset ${chain} supply`, min: 0 })
      / (params.supplyProbe!.scale ?? 1);
    const timestampRaw = component[probe.timestampField];
    const sourceTimestamp = parseTimestampLikeToUnixSeconds(timestampRaw);
    if ((quantity > 0 || timestampRaw != null) && sourceTimestamp == null) {
      throw new Error(`single-asset ${chain} liability timestamp is missing or unreadable`);
    }
    if (quantity > 0 && sourceTimestamp != null) {
      oldestTimestamp = oldestTimestamp == null ? sourceTimestamp : Math.min(oldestTimestamp, sourceTimestamp);
    }
    componentTotal += quantity;
    return { chain, sourceIdentity, quantity, sourceTimestamp };
  });
  if (Math.abs(componentTotal - supplyQuantity) > 0.000001) {
    throw new Error("single-asset native liability component sum does not match total supply");
  }
  const freshness = unverifiedFreshnessMetadata(
    "single-asset-native-reserve-probe",
    "Liability component clocks do not date the issuer's fiat reserves",
  );
  return {
    ...freshness,
    details: {
      ...freshness.details,
      proofKind: "issuer-native-reserve-and-liability-diagnostics",
      compositionMeasured: false,
      reserveSourceLabel: params.reserveSourceLabel ?? params.label,
      reserveUnit: params.reserveUnit,
      nativeReserveQuantity: reserveQuantity,
      nativeSupplyQuantity: supplyQuantity,
      reportedNativeReserveToSupplyRatio: reserveQuantity / supplyQuantity,
      liabilitySourceTimestamp: oldestTimestamp,
      liabilityComponents: components,
      liabilityScopeComplete: missingChains.size === 0 && unreviewedChains.length === 0,
      missingLiabilityChains: [...missingChains].sort(),
      unreviewedLiabilityChains: unreviewedChains.sort(),
    },
  };
}

export async function fetchSingleAssetReserves(
  coin: ReserveAdapterCoin,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const params = readParams(config);
  const primary = config.inputs.primary;
  const slices: ReserveSlice[] = [{
    name: params.label,
    pct: 100,
    risk: params.risk,
    ...(params.coinId ? { coinId: params.coinId } : {}),
    ...(params.depType ? { depType: params.depType } : {}),
  }];

  if (isHttpJsonInput(primary)) {
    const reserveProbe = params.reserveProbe;
    if (!reserveProbe && !params.supplyProbe) {
      throw new Error("single-asset http-json mode requires params.reserveProbe or params.supplyProbe");
    }
    const payload = await fetchJsonWithRetry<Record<string, unknown>>(
      primary.url,
      signal,
      12_000,
      ctx,
    );
    if (params.reserveUnit) {
      return { slices, metadata: nativeProbeMetadata(payload, params, coin) };
    }
    const totalReserveQuantity = reserveProbe
      ? readScaledProbeValue(payload, reserveProbe, "reserve")
      : null;
    const supplyTokens = params.supplyProbe
      ? readScaledProbeValue(payload, params.supplyProbe, "supply")
      : null;
    const timestampRaw = params.timestampProbe
      ? getJsonPath(payload, params.timestampProbe.path)
      : null;
    const sourceTimestamp = params.timestampProbe
      ? parseTimestampLikeToUnixSeconds(timestampRaw)
      : null;

    if (params.timestampProbe && sourceTimestamp == null) {
      throw new Error("single-asset source returned unreadable timestamp probe value");
    }

    const freshnessMetadata = unverifiedFreshnessMetadata(
      "single-asset-json-probe",
      "The issuer quantity probe does not provide a whole-reserve observation clock; any configured timestamp describes chain supply only",
    );
    const basis = params.nativeQuantityBasis;
    const nominalValue = basis?.supplyToken === coin.symbol ? basis.nominalValuePerToken : undefined;
    const collateralizationRatio = totalReserveQuantity != null && supplyTokens != null && nominalValue != null
      ? totalReserveQuantity / (supplyTokens * nominalValue)
      : null;
    const warnings = buildCoverageShortfallWarnings({
      code: "reserve-undercollateralized",
      message: (pct) => `Single-asset reserve probe covers ${pct}% of observed supply`,
      coverageRatio: collateralizationRatio,
    });

    return {
      slices,
      ...(warnings.length > 0 ? { warnings } : {}),
      metadata: {
        ...freshnessMetadata,
        ...(totalReserveQuantity != null ? { totalReserveQuantity } : {}),
        ...(supplyTokens != null ? { supplyTokens } : {}),
        ...(basis ? { nativeQuantityBasis: basis } : {}),
        ...(collateralizationRatio != null
          ? { collateralizationRatio }
          : {}),
        details: {
          ...freshnessMetadata.details,
          compositionMeasured: false,
          proofKind: totalReserveQuantity != null && supplyTokens != null
            ? "reserve-and-supply-probe"
            : "single-asset-liveness-probe",
          reserveSourceLabel: params.reserveSourceLabel ?? params.label,
          ...(sourceTimestamp != null ? {
            chainSupplyObservedAt: sourceTimestamp,
            chainSupplyTimestampPath: params.timestampProbe?.path,
          } : {}),
          quantityScope: "issuer-reported; configured bucket is not measured portfolio composition",
        },
      },
    };
  }

  const onchainInput = requireOnchainInput(primary, "single-asset");
  const scopedTokenQuantity = await probeOnchainTotalSupply(
    coin,
    onchainInput,
    signal,
    "single-asset",
    ctx,
    params.rpcUrl,
    params.fallbackRpcUrl,
  );

  return {
    slices,
    metadata: {
      ...unverifiedFreshnessMetadata(
        "configured-chain-token-liveness",
        "An ERC-20 totalSupply read does not observe offchain reserves",
      ),
      details: {
        proofKind: "erc20-total-supply-liveness",
        compositionMeasured: false,
        observationScope: "configured-chain-token-liveness",
        tokenFreshnessMode: "not-applicable",
        scopedTokenQuantityRaw: scopedTokenQuantity.toString(),
        scopedTokenChain: onchainInput.chain,
        reserveSourceLabel: params.reserveSourceLabel ?? params.label,
      },
    },
  };
}
