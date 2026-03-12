import { jsonFreshResponse, errorResponse } from "../lib/api-utils";
import { TRACKED_IDS } from "@shared/lib/stablecoins";
import type { ReserveSlice } from "@shared/types";

interface ReserveCompositionRow {
  stablecoin_id: string;
  slices: string;
  fetched_at: number;
  source: string;
}

export async function handleStablecoinReserves(
  db: D1Database,
  stablecoinId: string,
): Promise<Response> {
  // Reject unknown IDs early
  if (!TRACKED_IDS.has(stablecoinId)) {
    return errorResponse(404, "Not found");
  }

  const row = await db
    .prepare(
      "SELECT stablecoin_id, slices, fetched_at, source FROM reserve_composition WHERE stablecoin_id = ?",
    )
    .bind(stablecoinId)
    .first<ReserveCompositionRow>();

  if (!row) {
    return errorResponse(404, "Not found");
  }

  let slices: ReserveSlice[];
  try {
    slices = JSON.parse(row.slices) as ReserveSlice[];
  } catch {
    return errorResponse(500, "Malformed reserve data");
  }

  return jsonFreshResponse(
    {
      stablecoinId: row.stablecoin_id,
      slices,
      fetchedAt: row.fetched_at,
      source: row.source,
      estimated: false,
    },
    { cacheControl: "public, s-maxage=3600, max-age=300" },
  );
}
