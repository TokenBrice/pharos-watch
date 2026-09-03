import { jsonResponse } from "../lib/api-response";
import type { HealthResponse } from "@shared/types/status";
import { assessPublicHealth, buildPublicHealthResponse } from "../lib/public-health-assessment";
import { CACHE_PROFILES } from "../lib/constants";
import { loadStatusRawSnapshot } from "../lib/status/raw-snapshot";

export const handleHealth = async (db: D1Database): Promise<Response> => {
  const now = Math.floor(Date.now() / 1000);
  const snapshot = await loadStatusRawSnapshot(db, now);
  if (snapshot.kind === "fresh" && snapshot.publicHealth) {
    return jsonResponse(snapshot.publicHealth, { headers: { "Cache-Control": CACHE_PROFILES.realtime } });
  }

  const assessment = await assessPublicHealth(db, now, { logPrefix: "health" });
  const body: HealthResponse = buildPublicHealthResponse(assessment, now);
  return jsonResponse(body, { headers: { "Cache-Control": CACHE_PROFILES.realtime } });
};
