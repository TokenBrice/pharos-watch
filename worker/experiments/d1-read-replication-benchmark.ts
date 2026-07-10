interface BenchmarkEnv {
  DB: D1Database;
  BENCHMARK_TOKEN: string;
}

type D1ReadClient = Pick<D1Database, "prepare" | "batch">;
type BenchmarkMode = "primary" | "replica";

const CASES = [
  "stablecoins-cache",
  "status-cron-window",
  "blacklist-page",
  "depeg-page",
  "tape-page",
] as const;
type BenchmarkCase = typeof CASES[number];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function authorized(request: Request, expectedToken: string): Promise<boolean> {
  const supplied = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!supplied || !expectedToken) return false;
  const [suppliedHash, expectedHash] = await Promise.all([sha256(supplied), sha256(expectedToken)]);
  let mismatch = suppliedHash.length ^ expectedHash.length;
  for (let index = 0; index < Math.min(suppliedHash.length, expectedHash.length); index += 1) {
    mismatch |= suppliedHash.charCodeAt(index) ^ expectedHash.charCodeAt(index);
  }
  return mismatch === 0;
}

function parseMode(value: string | null): BenchmarkMode | null {
  return value === "primary" || value === "replica" ? value : null;
}

function parseCase(value: string | null): BenchmarkCase | null {
  return CASES.includes(value as BenchmarkCase) ? value as BenchmarkCase : null;
}

function parseAsOf(value: string | null): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function queryForCase(client: D1ReadClient, benchmarkCase: BenchmarkCase, asOf: number): D1PreparedStatement {
  switch (benchmarkCase) {
    case "stablecoins-cache":
      return client
        .prepare(
          `SELECT key, LENGTH(value) AS payload_bytes, updated_at
             FROM cache
            WHERE key IN ('stablecoins', 'report-cards:snapshot', 'yield-rankings')
            ORDER BY key ASC`,
        );
    case "status-cron-window":
      return client
        .prepare(
          `SELECT job, started_at, duration_ms, status, item_count
             FROM cron_runs INDEXED BY idx_cron_runs_started_job_id
            WHERE started_at >= ? AND started_at <= ?
            ORDER BY started_at DESC, job ASC, id DESC
            LIMIT 250`,
        )
        .bind(asOf - 86_400, asOf);
    case "blacklist-page":
      return client
        .prepare(
          `SELECT id, stablecoin, chain_id, event_type, timestamp
             FROM blacklist_events INDEXED BY idx_blacklist_events_public_date_page
            WHERE suppression_reason IS NULL AND timestamp <= ?
            ORDER BY timestamp DESC, id DESC
            LIMIT 100`,
        )
        .bind(asOf);
    case "depeg-page":
      return client
        .prepare(
          `SELECT id, stablecoin_id, started_at, ended_at, peak_deviation_bps
             FROM depeg_events_with_provenance
            WHERE started_at <= ?
            ORDER BY started_at DESC, id DESC
            LIMIT 100`,
        )
        .bind(asOf);
    case "tape-page":
      return client
        .prepare(
          `SELECT id, type, severity, ts, coin_id
             FROM tape_events
            WHERE ts <= ?
            ORDER BY ts DESC, id DESC
            LIMIT 100`,
        )
        .bind(asOf * 1000);
  }
}

export default {
  async fetch(request: Request, env: BenchmarkEnv): Promise<Response> {
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
    if (!await authorized(request, env.BENCHMARK_TOKEN)) return json({ error: "Unauthorized" }, 401);

    const url = new URL(request.url);
    const mode = parseMode(url.searchParams.get("mode"));
    const benchmarkCase = parseCase(url.searchParams.get("case"));
    const asOf = parseAsOf(url.searchParams.get("asOf"));
    if (!mode || !benchmarkCase || !asOf) {
      return json({ error: "mode=primary|replica, a supported case, and integer asOf are required" }, 400);
    }

    const session = mode === "replica" ? env.DB.withSession("first-unconstrained") : null;
    const client: D1ReadClient = session ?? env.DB;
    const startedAt = performance.now();
    try {
      const result = await queryForCase(client, benchmarkCase, asOf).all<Record<string, unknown>>();
      const elapsedMs = performance.now() - startedAt;
      return json({
        mode,
        case: benchmarkCase,
        asOf,
        rowCount: result.results.length,
        payloadHash: await sha256(JSON.stringify(result.results)),
        elapsedMs: Math.round(elapsedMs * 1000) / 1000,
        d1: {
          durationMs: result.meta.duration ?? null,
          sqlDurationMs: result.meta.timings?.sql_duration_ms ?? null,
          rowsRead: result.meta.rows_read ?? null,
          servedByPrimary: result.meta.served_by_primary ?? null,
          servedByRegion: result.meta.served_by_region ?? null,
          servedByColo: result.meta.served_by_colo ?? null,
          bookmark: session?.getBookmark() ?? null,
        },
      });
    } catch (error) {
      return json({
        mode,
        case: benchmarkCase,
        error: error instanceof Error ? error.message : String(error),
      }, 500);
    }
  },
};
