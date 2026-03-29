import { withErrorHandler, jsonFreshResponse } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { decodeJsonString } from "../lib/cache-json";
import { logMalformedJsonPath } from "../lib/json-decode-observability";

function isDigestInputDataSummary(
  value: unknown,
): value is { stabilityIndex?: { score: number; band: string } | null; totalMcapUsd?: number } {
  return typeof value === "object" && value !== null;
}

function decodeDigestInputData(value: string | null, generatedAt: number) {
  const decoded = decodeJsonString<{ stabilityIndex?: { score: number; band: string } | null; totalMcapUsd?: number }, "missing" | "json-parse-failed" | "invalid-shape">(
    value,
    {
      mode: "best-effort",
      updatedAt: generatedAt,
      missingReason: "missing",
      parseErrorReason: "json-parse-failed",
      normalize: (parsed) => {
        if (!isDigestInputDataSummary(parsed)) {
          return { ok: false, reason: "invalid-shape" };
        }
        return { ok: true, payload: parsed };
      },
    },
  );
  if (!decoded.ok && decoded.reason !== "missing") {
    logMalformedJsonPath({
      scope: "api",
      owner: "digest-archive",
      context: "daily_digest.input_data",
      reason: decoded.reason,
      source: "daily_digest",
      updatedAt: generatedAt,
    });
  }
  return decoded.ok ? decoded.payload : null;
}

function decodeDigestMeta(value: string | null, generatedAt: number) {
  const decoded = decodeJsonString<{ type?: string }, "missing" | "json-parse-failed" | "invalid-shape">(
    value,
    {
      mode: "best-effort",
      updatedAt: generatedAt,
      missingReason: "missing",
      parseErrorReason: "json-parse-failed",
      normalize: (parsed) => {
        if (typeof parsed !== "object" || parsed === null) {
          return { ok: false, reason: "invalid-shape" };
        }
        return { ok: true, payload: parsed as { type?: string } };
      },
    },
  );
  if (!decoded.ok && decoded.reason !== "missing") {
    logMalformedJsonPath({
      scope: "api",
      owner: "digest-archive",
      context: "daily_digest.digest_meta",
      reason: decoded.reason,
      source: "daily_digest",
      updatedAt: generatedAt,
    });
  }
  return decoded.ok ? decoded.payload : null;
}

export const handleDigestArchive = withErrorHandler("digest-archive", async (db: D1Database): Promise<Response> => {
  const rows = await db.prepare(
    "SELECT digest_text, digest_title, generated_at, digest_extended, input_data, digest_meta FROM daily_digest ORDER BY generated_at DESC LIMIT 365"
  ).all<{ digest_text: string; digest_title: string | null; generated_at: number; digest_extended: string | null; input_data: string | null; digest_meta: string | null }>();

  const digests = (rows.results ?? []).map((r) => {
    let psiScore: number | null = null;
    let psiBand: string | null = null;
    let totalMcapUsd: number | null = null;
    const input = decodeDigestInputData(r.input_data, r.generated_at);
    if (input) {
      psiScore = input.stabilityIndex?.score ?? null;
      psiBand = input.stabilityIndex?.band ?? null;
      totalMcapUsd = input.totalMcapUsd ?? null;
    }
    let digestType: "daily" | "weekly" = "daily";
    const meta = decodeDigestMeta(r.digest_meta, r.generated_at);
    if (meta?.type === "weekly") {
      digestType = "weekly";
    }
    return {
      digestText: r.digest_text,
      digestTitle: r.digest_title ?? null,
      digestExtended: r.digest_extended ?? null,
      generatedAt: r.generated_at,
      psiScore,
      psiBand,
      totalMcapUsd,
      digestType,
      editionNumber: 0, // computed below
    };
  });

  // Assign sequential edition numbers per type (oldest first)
  let dailyCount = 0;
  let weeklyCount = 0;
  const chronological = [...digests].sort((a, b) => a.generatedAt - b.generatedAt);
  for (const d of chronological) {
    if (d.digestType === "weekly") {
      d.editionNumber = ++weeklyCount;
    } else {
      d.editionNumber = ++dailyCount;
    }
  }

  const latestTs = digests.length > 0 ? digests[0].generatedAt : Math.floor(Date.now() / 1000);

  return jsonFreshResponse({ digests }, {
    cacheControl: CACHE_PROFILES.standard,
    updatedAt: latestTs,
    maxAgeSec: DAY_SECONDS,
  });
});
