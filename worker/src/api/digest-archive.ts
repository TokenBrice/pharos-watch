import { errorResponse, jsonFreshResponse } from "../lib/api-response";
import { API_CACHE_PROFILES as CACHE_PROFILES } from "@shared/lib/api-cache-profiles";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import type { DigestForwardLookOutcome, DigestNextTrigger, DigestRiskSignal, DigestRiskTapeItem } from "@shared/types/digest";
import { DigestArchiveCursorSchema, DigestSupplyCoverageSchema } from "@shared/types/digest";
import { decodeJsonString } from "../lib/cache-json";
import { NON_BLOCKED_DIGEST_SQL_FILTER } from "../lib/digest-sql-filters";
import { logMalformedJsonPath } from "../lib/json-decode-observability";
import { selectDigestRiskSignal } from "./digest-risk-summary";
import { selectDigestIntelligence } from "./digest-intelligence-summary";

type DigestArchiveInput = {
  stabilityIndex?: { score: number; band: string } | null;
  totalMcapUsd?: number;
  supplyCoverage?: unknown;
  activeDepegCount?: number | null;
  topDepegs?: unknown[];
  dailyDigests?: unknown[];
  nextTriggers?: unknown[];
  forwardLookOutcomes?: unknown[];
  riskTape?: unknown[];
};
type DigestArchiveMeta = {
  llm?: { servedModel?: unknown; copyServedModel?: unknown; attempts?: { servedModel?: unknown }[] };
  type?: string;
  internal?: unknown;
  editorialStyleVersion?: string;
  editorialStyleHash?: string;
};

function isDigestInputDataSummary(
  value: unknown,
): value is DigestArchiveInput {
  return typeof value === "object" && value !== null;
}

function decodeDigestInputData(value: string | null, generatedAt: number) {
  const decoded = decodeJsonString<DigestArchiveInput, "missing" | "json-parse-failed" | "invalid-shape">(
    value,
    {
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

function decodeDigestMeta(value: string | null, generatedAt: number): DigestArchiveMeta | null {
  const decoded = decodeJsonString<DigestArchiveMeta, "missing" | "json-parse-failed" | "invalid-shape">(
    value,
    {
      updatedAt: generatedAt,
      missingReason: "missing",
      parseErrorReason: "json-parse-failed",
      normalize: (parsed) => {
        if (typeof parsed !== "object" || parsed === null) {
          return { ok: false, reason: "invalid-shape" };
        }
        return { ok: true, payload: parsed as DigestArchiveMeta };
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

export const handleDigestArchive = async (db: D1Database, url?: URL): Promise<Response> => {
  const history = url?.searchParams.get("history");
  const rawCursor = url?.searchParams.get("cursor");
  const completeHistory = history === "all";
  if ((history !== undefined && history !== null && !completeHistory) || (rawCursor !== null && rawCursor !== undefined && !completeHistory)) {
    return errorResponse(400, "Invalid digest archive history mode", { noStore: true });
  }
  const parsedCursor = rawCursor == null ? null : DigestArchiveCursorSchema.safeParse(
    rawCursor.length <= 200 && /^\d+\.\d+\.\d+\.\d+\.\d+$/.test(rawCursor) ? rawCursor.split(".").map(Number) : null,
  );
  if (parsedCursor && !parsedCursor.success) return errorResponse(400, "Invalid digest archive cursor", { noStore: true });
  const cursor = parsedCursor?.success ? parsedCursor.data : null;
  if (cursor && (cursor[2] >= cursor[1] || cursor[4] > cursor[0])) {
    return errorResponse(400, "Invalid digest archive cursor", { noStore: true });
  }
  const rows = await db.prepare(
    // Number full non-blocked history (including sentinels) before keyset
    // pagination. The insertion horizon also excludes later backdated inserts.
    `SELECT * FROM (
       SELECT rowid AS archive_id, digest_text, digest_title, generated_at, digest_extended, input_data, digest_meta,
         ${completeHistory ? "COUNT(*) OVER () AS archive_total, MAX(rowid) OVER () AS archive_horizon," : ""}
         ROW_NUMBER() OVER (
           PARTITION BY CASE WHEN json_extract(digest_meta, '$.type') = 'weekly' THEN 'weekly' ELSE 'daily' END
           ORDER BY generated_at ASC, rowid ASC
         ) AS edition_number
       FROM daily_digest WHERE (${NON_BLOCKED_DIGEST_SQL_FILTER})
         ${cursor ? "AND rowid <= ?" : ""}
     ) ${cursor ? "WHERE (generated_at, archive_id) < (?, ?)" : ""}
     ORDER BY generated_at DESC, archive_id DESC LIMIT 365`,
  ).bind(...(cursor ? [cursor[0], cursor[3], cursor[4]] : [])).all<{
    archive_id: number; archive_total: number; archive_horizon: number;
    digest_text: string; digest_title: string | null; generated_at: number;
    digest_extended: string | null; input_data: string | null; digest_meta: string | null; edition_number: number;
  }>();
  const pageRows = rows.results ?? [];
  const total = pageRows[0]?.archive_total ?? 0;
  const horizon = cursor?.[0] ?? pageRows[0]?.archive_horizon ?? 0;
  const scanned = (cursor?.[2] ?? 0) + pageRows.length;
  if (cursor && (total !== cursor[1] || pageRows.length === 0 || scanned > total)) {
    return errorResponse(409, "Digest archive changed during traversal; restart from the first page", { noStore: true });
  }
  const last = pageRows[pageRows.length - 1];
  const pagination = completeHistory ? {
    horizon,
    total,
    scanned,
    nextCursor: scanned < total && last
      ? [horizon, total, scanned, last.generated_at, last.archive_id].join(".")
      : null,
  } : undefined;

  const digests = pageRows.map((r) => {
    let psiScore: number | null = null;
    let psiBand: string | null = null;
    let totalMcapUsd: number | null = null;
    let riskSignal: DigestRiskSignal | null = null;
    let nextTriggers: DigestNextTrigger[] | null = null;
    let forwardLookOutcomes: DigestForwardLookOutcome[] | null = null;
    let riskTape: DigestRiskTapeItem[] | null = null;
    const input = decodeDigestInputData(r.input_data, r.generated_at);
    const coverage = DigestSupplyCoverageSchema.safeParse(input?.supplyCoverage);
    if (input) {
      psiScore = input.stabilityIndex?.score ?? null;
      psiBand = input.stabilityIndex?.band ?? null;
      totalMcapUsd = typeof input.totalMcapUsd === "number" && Number.isFinite(input.totalMcapUsd)
        && (!coverage.success || coverage.data.observedCount > 0) ? input.totalMcapUsd : null;
      riskSignal = selectDigestRiskSignal(input);
      const intelligence = selectDigestIntelligence(input);
      nextTriggers = intelligence.nextTriggers;
      forwardLookOutcomes = intelligence.forwardLookOutcomes;
      riskTape = intelligence.riskTape;
    }
    let digestType: "daily" | "weekly" = "daily";
    const meta = decodeDigestMeta(r.digest_meta, r.generated_at);
    if (meta?.type === "weekly") {
      digestType = "weekly";
    }
    // Heavy-profile editions record which attempt produced the copy: their
    // last attempt can be an evidence audit or a discarded revision.
    const servedModel = typeof meta?.llm?.copyServedModel === "string"
      ? meta.llm.copyServedModel
      : Array.isArray(meta?.llm?.attempts)
        ? meta.llm.attempts[meta.llm.attempts.length - 1]?.servedModel
        : meta?.llm?.servedModel;
    const isInternal = meta?.internal === true || meta?.internal === 1 || meta?.internal === "true";
    // Legacy rows have no stored style provenance. This display-only marker
    // is computed at the API boundary and is never written back to D1.
    return {
      isInternal,
      ...(typeof servedModel === "string" && servedModel ? { llm: { servedModel } } : {}),
      digestText: r.digest_text,
      digestTitle: r.digest_title ?? null,
      digestExtended: r.digest_extended ?? null,
      generatedAt: r.generated_at,
      psiScore,
      psiBand,
      totalMcapUsd,
      ...(coverage.success ? { supplyCoverage: coverage.data } : {}),
      riskSignal,
      nextTriggers,
      forwardLookOutcomes,
      riskTape,
      digestType,
      editorialStyleVersion: meta?.editorialStyleVersion ?? "pre-policy",
      editorialStyleHash: meta?.editorialStyleHash ?? "pre-policy",
      editionNumber: r.edition_number,
    };
  });

  const publicDigests = digests
    .filter((d) => !d.isInternal)
    .map(({ isInternal: _isInternal, ...rest }) => rest);

  const latestTs = publicDigests.length > 0 ? publicDigests[0].generatedAt : Math.floor(Date.now() / 1000);

  return jsonFreshResponse({ digests: publicDigests, ...(pagination ? { pagination } : {}) }, {
    cacheControl: CACHE_PROFILES.standard,
    updatedAt: latestTs,
    maxAgeSec: DAY_SECONDS,
  });
};
