import { API_CACHE_PROFILES as CACHE_PROFILES } from "@shared/lib/api-cache-profiles";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { DigestPromoResponseSchema, type DigestPromoEdition } from "@shared/types/digest";
import { jsonFreshResponse, jsonResponse } from "../lib/api-response";
import { NON_BLOCKED_DIGEST_SQL_FILTER, NON_INTERNAL_DIGEST_SQL_FILTER, NON_WEEKLY_DIGEST_SQL_FILTER } from "../lib/digest-sql-filters";
import { logWorkerEvent } from "../lib/structured-log";

type DigestPromoRow = {
  digest_rowid: number;
  digest_title: string | null;
  digest_text: string | null;
  digest_extended: string | null;
  generated_at: number;
  edition_number: number;
  daily_count: number;
};

function projectEdition(row: DigestPromoRow): DigestPromoEdition {
  return {
    digestTitle: row.digest_title,
    editionNumber: row.edition_number,
    generatedAt: row.generated_at,
    slug: new Date(row.generated_at * 1000).toISOString().slice(0, 10),
  };
}

export async function handleDigestPromo(db: D1Database): Promise<Response> {
  try {
    const rows = await db.prepare(
      // Number the full non-blocked daily history, including internal sentinels,
      // before hiding internal rows and bounding this presentation-only read.
      `WITH numbered AS (
         SELECT rowid AS digest_rowid, digest_title, generated_at, digest_meta,
           ROW_NUMBER() OVER (ORDER BY generated_at ASC, rowid ASC) AS edition_number,
           COUNT(*) OVER () AS daily_count
         FROM daily_digest
         WHERE (${NON_WEEKLY_DIGEST_SQL_FILTER}) AND (${NON_BLOCKED_DIGEST_SQL_FILTER})
       ), visible AS (
         SELECT digest_rowid, digest_title, generated_at, edition_number, daily_count,
           ROW_NUMBER() OVER (ORDER BY generated_at DESC, digest_rowid DESC) AS visible_order
         FROM numbered WHERE (${NON_INTERNAL_DIGEST_SQL_FILTER})
         ORDER BY generated_at DESC, digest_rowid DESC LIMIT 3
       )
       SELECT visible.digest_rowid, visible.digest_title, visible.generated_at, visible.edition_number,
         visible.daily_count, body.digest_text, body.digest_extended
       FROM visible LEFT JOIN daily_digest body
         ON body.rowid = visible.digest_rowid AND visible.visible_order = 1
       ORDER BY visible.generated_at DESC, visible.digest_rowid DESC`,
    ).all<DigestPromoRow>();
    if (!rows.success) throw new Error("Digest promo read failed");

    const [current, ...previous] = rows.results;
    const digestText = current?.digest_text?.replace(/\s+/g, " ").trim();
    const firstParagraph = digestText ? null : current?.digest_extended?.split(/\r?\n\s*\r?\n/g)
      .find((paragraph) => paragraph.trim())?.replace(/\s+/g, " ").trim();
    const body = DigestPromoResponseSchema.parse({
      latest: current ? {
        ...projectEdition(current),
        // Match daily-digest's current COUNT-based suffix even if a newer hidden
        // sentinel exists. Prior leaves keep the archive's per-row numbering.
        editionNumber: current.daily_count,
        excerpt: digestText || firstParagraph || null,
      } : null,
      previousEditions: previous
        .filter((row) => row.digest_rowid !== current?.digest_rowid && row.edition_number !== current?.daily_count)
        .map(projectEdition),
    });

    return jsonFreshResponse(body, {
      cacheControl: CACHE_PROFILES.standard,
      updatedAt: current?.generated_at,
      maxAgeSec: API_FRESHNESS_MAX_AGE_SEC.dailyDigest,
    });
  } catch (error) {
    logWorkerEvent({ scope: "api", level: "error", event: "digest_promo_unavailable", message: "Digest promo unavailable", error });
    return jsonResponse({ error: "Digest promo unavailable", reason: "digest-promo-unavailable" }, {
      status: 503,
      noStore: true,
    });
  }
}
