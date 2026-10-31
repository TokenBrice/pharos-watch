import { ApiMetaEnvelopeSchema } from "@pharos/contracts/api-meta";
import type { ApiMetaEnvelope } from "@pharos/contracts/api-meta";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { parseDetailSnapshotSourceClock } from "@shared/lib/detail-snapshot-inputs";
import { projectStablecoinLiveSummary } from "@shared/lib/stablecoin-live-summary";
import { StablecoinDetailResponseSchema } from "@shared/types/market";
import { buildFreshnessMeta } from "../lib/api-freshness";
import { errorResponse, jsonResponse } from "../lib/api-response";
import { handleStablecoinDetail } from "./stablecoin-detail";

/** The detail display contract without provider history or research passthrough fields. */
export async function handleStablecoinLiveSummary(
  db: D1Database,
  id: string,
  ctx: ExecutionContext,
  coingeckoApiKey?: string | null,
): Promise<Response> {
  // Share provider selection, single-flight refresh and canonical price/supply admission.
  // Do not replace this with the differently scoped stablecoin-summary list projection.
  const response = await handleStablecoinDetail(db, id, ctx, coingeckoApiKey);
  if (!response.ok) return response;

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return errorResponse(502, "Invalid stablecoin detail JSON", { noStore: true });
  }
  const parsed = StablecoinDetailResponseSchema.safeParse(payload);
  if (!parsed.success) return errorResponse(502, "Invalid stablecoin detail data", { noStore: true });
  const summary = projectStablecoinLiveSummary(parsed.data);
  const headers = new Headers(response.headers);
  headers.delete("Content-Length");
  const sourceClock = headers.get("X-Data-Updated-At");
  const updatedAt = sourceClock === null ? null : parseDetailSnapshotSourceClock(sourceClock);
  const warning = headers.get("Warning");
  const bodyMeta = ApiMetaEnvelopeSchema.safeParse(parsed.data._meta);
  let meta: ApiMetaEnvelope;
  if (bodyMeta.success) {
    // Match the existing meta-aware reader: valid body provenance wins over HTTP clocks.
    meta = bodyMeta.data;
    if (meta.updatedAt == null) headers.set("Cache-Control", "no-store");
  } else if (updatedAt == null || updatedAt <= 0) {
    headers.set("Cache-Control", "no-store");
    meta = { updatedAt: null, ageSeconds: null, status: "unknown", reason: "producer-timestamp-unavailable" };
  } else {
    meta = buildFreshnessMeta(updatedAt, API_FRESHNESS_MAX_AGE_SEC.stablecoins, "stablecoin-detail");
    // A server-stale floor (genuinely stale enriched inputs) or degraded verdict must survive projection even inside the age budget.
    const inheritedStatus = headers.get("X-Data-Freshness");
    if (inheritedStatus === "stale" || (inheritedStatus === "degraded" && meta.status === "fresh")) {
      meta.status = inheritedStatus;
    }
  }
  if (warning) meta.warning = warning;
  // One verdict per response (R3): the generic freshness header names the same
  // status and reason the body publishes, never the pre-enrichment detail clock.
  headers.set("X-Data-Freshness", meta.status);
  if ("reason" in meta && meta.reason) headers.set("X-Data-Freshness-Reason", meta.reason);
  else headers.delete("X-Data-Freshness-Reason");
  return jsonResponse({ ...summary, _meta: meta }, {
    status: response.status,
    headers: Object.fromEntries(headers.entries()),
  });
}
