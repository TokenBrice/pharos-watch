import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchJsonPostWithRetry,
  freshnessMetadataFromTimestamp,
  parseTimestampLikeToUnixSeconds,
  reserveDegradedWarning,
  requireJsonInputFromConfig,
  slicesFromValues,
  summarizeSourceTimestamps,
} from "./helpers";

interface M0GraphQlResponse {
  data?: {
    minterGateway_totalCollateralSnapshots?: Array<{
      timestamp?: string | number;
      value?: string | number;
    }>;
    minterGateway_minters?: Array<{
      id?: string;
      collateral?: string | number;
    }>;
    collateralUpdateds?: Array<{
      timestamp?: string | number;
      blockTimestamp?: string | number;
    }>;
    minterGateway_latestUpdateTimestampSnapshots?: Array<{
      timestamp?: string | number;
      value?: string | number;
    }>;
  };
  errors?: Array<{ message?: string }>;
}

// M0's Protocol API retired the off-chain CollateralCurrent composition feed in
// 2026-08 (the resolver survives in the schema but returns the gateway 500
// envelope). The supported replacement is the on-chain-indexed Minter Gateway
// total: minterGateway_totalCollateralSnapshots. Composition (cash vs treasury
// split) is no longer observable through the API, so the adapter publishes one
// protocol-constrained slice; curated reserve evidence carries the detail.
const M0_TOTAL_COLLATERAL_QUERY = `
  query LiveReserveTotalCollateral {
    minterGateway_totalCollateralSnapshots(first: 1, orderBy: timestamp, orderDirection: desc) {
      timestamp
      value
    }
    minterGateway_minters {
      id
      collateral
    }
    collateralUpdateds(first: 1, orderBy: timestamp, orderDirection: desc) {
      timestamp
      blockTimestamp
    }
    minterGateway_latestUpdateTimestampSnapshots(first: 1, orderBy: timestamp, orderDirection: desc) {
      timestamp
      value
    }
  }
`;

// Minter Gateway collateral values are 6-decimal token units (observed
// 277097642539488 -> $277.10M against the M0 dashboard on 2026-08-20).
const M0_COLLATERAL_DECIMALS_DIVISOR = 1_000_000;

// The total snapshot and the per-minter rows are written at slightly different
// index times, so an exact match is not expected (observed skew ~4e-6 of the
// total). A divergence beyond this ratio means the snapshot no longer describes
// the minter set and operators should look at the upstream indexer.
const M0_MINTER_RECONCILIATION_WARN_RATIO = 0.005;

// The published value comes from the latest total-collateral snapshot; the
// collateral-update event stream routinely runs ahead of it by an indexing
// cadence of ~2h (observed 2026-08-20). Only a lag well beyond that cadence
// indicates the total has stopped tracking known collateral updates.
const M0_SNAPSHOT_LAG_DEGRADE_SEC = 6 * 60 * 60;

function parseNumericValue(value: string | number | undefined): number | null {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function adaptM0Collateral(payload: M0GraphQlResponse): AdapterResult {
  const snapshot = payload.data?.minterGateway_totalCollateralSnapshots?.[0];
  if (!snapshot) {
    throw new Error("M0 GraphQL response missing minterGateway_totalCollateralSnapshots");
  }

  const rawTotal = parseNumericValue(snapshot.value);
  if (rawTotal == null || rawTotal < 0) {
    throw new Error(`M0 total collateral snapshot value is not a usable number: ${String(snapshot.value)}`);
  }
  const totalUsd = rawTotal / M0_COLLATERAL_DECIMALS_DIVISOR;

  const warnings = [];

  const minterCollaterals = (payload.data?.minterGateway_minters ?? [])
    .map((minter) => parseNumericValue(minter.collateral))
    .filter((value): value is number => value != null);
  const minterCollateralTotalUsd = minterCollaterals.length > 0
    ? minterCollaterals.reduce((acc, value) => acc + value, 0) / M0_COLLATERAL_DECIMALS_DIVISOR
    : null;
  if (
    minterCollateralTotalUsd != null
    && totalUsd > 0
    && Math.abs(minterCollateralTotalUsd - totalUsd) / totalUsd > M0_MINTER_RECONCILIATION_WARN_RATIO
  ) {
    warnings.push(reserveDegradedWarning(
      "minter-collateral-reconciliation",
      `M0 per-minter collateral sum ($${minterCollateralTotalUsd.toFixed(0)}) diverges from the total collateral snapshot ($${totalUsd.toFixed(0)})`,
    ));
  }

  const snapshotTimestamp = parseTimestampLikeToUnixSeconds(snapshot.timestamp);
  const updateTimestampSummary = summarizeSourceTimestamps([
    payload.data?.collateralUpdateds?.[0]?.timestamp,
    payload.data?.collateralUpdateds?.[0]?.blockTimestamp,
    payload.data?.minterGateway_latestUpdateTimestampSnapshots?.[0]?.value,
    payload.data?.minterGateway_latestUpdateTimestampSnapshots?.[0]?.timestamp,
  ]);
  const snapshotLagSec = snapshotTimestamp != null && updateTimestampSummary != null
    ? Math.max(0, updateTimestampSummary.latestSourceTimestamp - snapshotTimestamp)
    : null;
  if (snapshotLagSec != null && snapshotLagSec > M0_SNAPSHOT_LAG_DEGRADE_SEC) {
    warnings.push(reserveDegradedWarning(
      "total-collateral-snapshot-lag",
      `M0 total collateral snapshot lags the latest collateral update by ${snapshotLagSec}s`,
    ));
  }

  const slices = slicesFromValues([
    {
      name: "U.S. Treasury bills & cash (M0 eligible collateral)",
      value: totalUsd,
      risk: "very-low",
    },
  ]);

  return {
    slices,
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...freshnessMetadataFromTimestamp(
        snapshotTimestamp,
        "protocol-api-graphql",
        "M0 total collateral snapshot did not expose a parseable timestamp",
      ),
      collateralValueDivisor: M0_COLLATERAL_DECIMALS_DIVISOR,
      normalizedReserveTotal: totalUsd,
      ...(minterCollateralTotalUsd != null
        ? {
            minterCount: minterCollaterals.length,
            minterCollateralTotalUsd,
          }
        : {}),
      ...(updateTimestampSummary != null
        ? {
            earliestCollateralUpdateTimestamp: updateTimestampSummary.sourceTimestamp,
            latestCollateralUpdateTimestamp: updateTimestampSummary.latestSourceTimestamp,
          }
        : {}),
      ...(snapshotLagSec != null ? { snapshotLagSec } : {}),
    },
  };
}

export async function fetchM0Reserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const apiKey = ctx?.m0ApiKey?.trim();
  if (!apiKey) {
    throw new Error("M0_API_KEY not configured; the M0 Protocol API requires keyed access");
  }
  const primaryInput = requireJsonInputFromConfig(config, "m0");
  const payload = await fetchJsonPostWithRetry<M0GraphQlResponse>(
    primaryInput.url,
    { query: M0_TOTAL_COLLATERAL_QUERY },
    signal,
    12_000,
    ctx,
    { headers: { Authorization: `ApiKey ${apiKey}` } },
  );
  if (payload.errors?.length) {
    const message = payload.errors.map((error) => error.message).filter(Boolean).join("; ");
    throw new Error(message || "M0 GraphQL returned errors");
  }

  return adaptM0Collateral(payload);
}
