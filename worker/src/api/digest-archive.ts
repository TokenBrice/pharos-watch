import { jsonFreshResponse } from "../lib/api-response";
import { CACHE_PROFILES } from "../lib/constants";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import type { DigestForwardLookOutcome, DigestNextTrigger, DigestRiskSignal, DigestRiskTapeItem } from "@shared/types/digest";
import { decodeJsonString } from "../lib/cache-json";
import { NON_BLOCKED_DIGEST_SQL_FILTER } from "../lib/digest-sql-filters";
import { logMalformedJsonPath } from "../lib/json-decode-observability";
import { selectDigestRiskSignal } from "./digest-risk-summary";
import { selectDigestIntelligence } from "./digest-intelligence-summary";

type DigestArchiveInput = {
  stabilityIndex?: { score: number; band: string } | null;
  totalMcapUsd?: number;
  activeDepegCount?: number;
  topDepegs?: unknown[];
  dailyDigests?: unknown[];
  nextTriggers?: unknown[];
  forwardLookOutcomes?: unknown[];
  riskTape?: unknown[];
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

function decodeDigestMeta(value: string | null, generatedAt: number) {
  const decoded = decodeJsonString<{ type?: string; internal?: unknown }, "missing" | "json-parse-failed" | "invalid-shape">(
    value,
    {
      updatedAt: generatedAt,
      missingReason: "missing",
      parseErrorReason: "json-parse-failed",
      normalize: (parsed) => {
        if (typeof parsed !== "object" || parsed === null) {
          return { ok: false, reason: "invalid-shape" };
        }
        return { ok: true, payload: parsed as { type?: string; internal?: unknown } };
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

export const handleDigestArchive = async (db: D1Database): Promise<Response> => {
  const rows = await db.prepare(
    // Blocked rows never published and get no edition number, so a SQL filter
    // is safe here; internal sentinel rows are numbered first and hidden in JS.
    `SELECT digest_text, digest_title, generated_at, digest_extended, input_data, digest_meta FROM daily_digest WHERE ${NON_BLOCKED_DIGEST_SQL_FILTER} ORDER BY generated_at DESC LIMIT 365`
  ).all<{ digest_text: string; digest_title: string | null; generated_at: number; digest_extended: string | null; input_data: string | null; digest_meta: string | null }>();

  const digests = (rows.results ?? []).map((r) => {
    let psiScore: number | null = null;
    let psiBand: string | null = null;
    let totalMcapUsd: number | null = null;
    let riskSignal: DigestRiskSignal | null = null;
    let nextTriggers: DigestNextTrigger[] | null = null;
    let forwardLookOutcomes: DigestForwardLookOutcome[] | null = null;
    let riskTape: DigestRiskTapeItem[] | null = null;
    const input = decodeDigestInputData(r.input_data, r.generated_at);
    if (input) {
      psiScore = input.stabilityIndex?.score ?? null;
      psiBand = input.stabilityIndex?.band ?? null;
      totalMcapUsd = input.totalMcapUsd ?? null;
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
    const isInternal = meta?.internal === true || meta?.internal === 1 || meta?.internal === "true";
    return {
      isInternal,
      digestText: r.digest_text,
      digestTitle: r.digest_title ?? null,
      digestExtended: r.digest_extended ?? null,
      generatedAt: r.generated_at,
      psiScore,
      psiBand,
      totalMcapUsd,
      riskSignal,
      nextTriggers,
      forwardLookOutcomes,
      riskTape,
      digestType,
      editionNumber: 0, // computed below
    };
  });

  // Assign sequential edition numbers per type (oldest first). Internal
  // sentinel rows are numbered too — hiding them below must not shift the
  // edition numbers already published on socials and detail pages.
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

  const publicDigests = digests
    .filter((d) => !d.isInternal)
    .map(({ isInternal: _isInternal, ...rest }) => rest);

  const latestTs = publicDigests.length > 0 ? publicDigests[0].generatedAt : Math.floor(Date.now() / 1000);

  return jsonFreshResponse({ digests: publicDigests }, {
    cacheControl: CACHE_PROFILES.standard,
    updatedAt: latestTs,
    maxAgeSec: DAY_SECONDS,
  });
};
