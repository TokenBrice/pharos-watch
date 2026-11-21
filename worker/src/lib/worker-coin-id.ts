import {
  WORKER_ACTIVE_META_BY_ID,
  WORKER_TRACKED_META_BY_ID,
  type WorkerRuntimeStablecoinMeta,
} from "@shared/lib/stablecoins/worker-runtime-registry";
import { errorResponse } from "./api-response";

export interface DecodedWorkerCoinId {
  canonicalId: string;
  meta: WorkerRuntimeStablecoinMeta;
}

/**
 * Decode a strict percent-encoded path segment and resolve directly against
 * the compact worker runtime registry without pulling the full stablecoin catalog.
 */
export function decodeWorkerCoinPathId(
  raw: string,
  options: { activeOnly?: boolean; malformedMessage?: string } = {},
): DecodedWorkerCoinId | Response {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return errorResponse(400, options.malformedMessage ?? "Malformed URI");
  }
  if (encodeURIComponent(decoded) !== raw) {
    return errorResponse(404, "Not found");
  }
  const map = options.activeOnly ? WORKER_ACTIVE_META_BY_ID : WORKER_TRACKED_META_BY_ID;
  const meta = map.get(decoded);
  if (!meta) {
    return errorResponse(404, `Unknown stablecoin: ${decoded}`);
  }
  return { canonicalId: decoded, meta };
}
