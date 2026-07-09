import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig, LiveReserveWarning } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { AdapterContext, AdapterResult } from "./types";
import {
  buildCoverageShortfallWarnings,
  fetchJsonWithRetry,
  parsePositiveNumericLike,
  parseTimestampLikeToUnixSeconds,
  requireJsonInput,
  reserveDegradedWarning,
  verifiedFreshnessMetadata,
} from "./helpers";

export interface UnitedPorPayload {
  accountName: string;
  totalReserve: string;
  totalToken: string;
  updatedAt: string;
  ripcord: boolean;
  ripcordDetails: string[];
}

interface UnitedPorSliceConfig {
  name: ReserveSlice["name"];
  risk: ReserveSlice["risk"];
  coinId?: string;
  depType?: ReserveSlice["depType"];
}

/**
 * Reads United Stables' public aggregate PoR payload
 * (`https://u.tech/u-client-api/v1/public/u/por`): `totalReserve` vs
 * `totalToken` as decimal strings, an ISO `updatedAt`, and the attestor's own
 * `ripcord` data-quality alarm. This proves the aggregate reserve-vs-token
 * ratio only; per-asset composition detail stays on the coin's curated
 * `reserves` slice (passed in as `slice`), so the emitted slice mirrors that
 * curated bucket rather than inventing a split the source doesn't disclose.
 */
export function adaptUnitedPorPayload(
  payload: UnitedPorPayload,
  slice: UnitedPorSliceConfig,
): AdapterResult {
  const totalReserveUsd = parsePositiveNumericLike(payload.totalReserve);
  if (totalReserveUsd == null) {
    throw new Error("United PoR payload has invalid totalReserve");
  }

  const supplyUsd = parsePositiveNumericLike(payload.totalToken);
  if (supplyUsd == null) {
    throw new Error("United PoR payload has invalid totalToken");
  }

  const sourceTimestamp = parseTimestampLikeToUnixSeconds(payload.updatedAt);
  if (sourceTimestamp == null) {
    throw new Error("United PoR payload has an unreadable updatedAt");
  }

  const collateralizationRatio = totalReserveUsd / supplyUsd;

  const warnings: LiveReserveWarning[] = buildCoverageShortfallWarnings({
    code: "united-por-reserve-under-token",
    message: (pct) => `United PoR reserves cover ${pct}% of outstanding U token supply`,
    coverageRatio: collateralizationRatio,
  });

  // The attestor's own ripcord flag is a data-quality alarm, not just a low
  // ratio: treat it as degraded regardless of the measured ratio so a
  // ripcord snapshot never scores as healthy, and carry the disclosed
  // details into the warning message rather than a bare boolean.
  if (payload.ripcord) {
    const detail = payload.ripcordDetails.length > 0
      ? payload.ripcordDetails.join("; ")
      : "no further detail disclosed";
    warnings.push(
      reserveDegradedWarning(
        "united-por-ripcord",
        `United Stables PoR reports a ripcord data-quality alarm: ${detail}`,
      ),
    );
  }

  return {
    slices: [{
      name: slice.name,
      pct: 100,
      risk: slice.risk,
      ...(slice.coinId ? { coinId: slice.coinId } : {}),
      ...(slice.depType ? { depType: slice.depType } : {}),
    }],
    metadata: {
      ...verifiedFreshnessMetadata(sourceTimestamp),
      collateralizationRatio,
      totalReserveUsd,
      supplyUsd,
      details: {
        accountName: payload.accountName,
        ripcord: payload.ripcord,
        ...(payload.ripcordDetails.length > 0 ? { ripcordDetails: payload.ripcordDetails } : {}),
      },
    },
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export async function fetchUnitedPorReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireJsonInput(config.inputs.primary, "united-por");
  const params = parseLiveReserveAdapterParams("united-por", config.params);
  const payload = await fetchJsonWithRetry<UnitedPorPayload>(input.url, signal, 12_000, ctx);
  return adaptUnitedPorPayload(payload, params.slice);
}
