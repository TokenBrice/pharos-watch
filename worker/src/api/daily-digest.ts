import { withErrorHandler, addFreshnessHeaders } from "../lib/api-utils";
import { timingSafeEqual } from "../lib/auth";
import { generateDailyDigest } from "../cron/daily-digest";

export const handleDailyDigest = withErrorHandler("daily-digest", async (db: D1Database): Promise<Response> => {
  const row = await db.prepare(
    "SELECT digest_text, generated_at FROM daily_digest ORDER BY generated_at DESC LIMIT 1"
  ).first<{ digest_text: string; generated_at: number }>();

  if (!row) {
    return new Response(JSON.stringify({ digest: null }), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, s-maxage=300, max-age=60",
      },
    });
  }

  return new Response(JSON.stringify({
    digest: row.digest_text,
    generatedAt: row.generated_at,
  }), {
    headers: addFreshnessHeaders({
      "Content-Type": "application/json",
      "Cache-Control": "public, s-maxage=3600, max-age=300",
    }, row.generated_at, 7200),
  });
});

export const handleTriggerDigest = withErrorHandler("trigger-digest", async (
  db: D1Database,
  adminSecret?: string,
  anthropicApiKey?: string,
  request?: Request,
): Promise<Response> => {
  const key = request?.headers.get("X-Admin-Key");
  if (!adminSecret || !key || !(await timingSafeEqual(key, adminSecret))) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const result = await generateDailyDigest(db, anthropicApiKey ?? null, true);

  return new Response(JSON.stringify({ ok: true, result }), {
    headers: { "Content-Type": "application/json" },
  });
});
