import { register } from "tsx/esm/api";

// Run the actual source handler against a SELECT-only D1 transport. Never persist status/self-check state.
export function createReadOnlyProfileDb(query, receipts) {
  function prepare(sql) {
    // Current status queries are SELECTs (including SELECT-only CTEs). Reject mutation, pragmas and multi-statements.
    const tokens = sql.replace(/'(?:''|[^'])*'/g, "''").replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, " ");
    if (!/^\s*(SELECT|WITH)\b/i.test(tokens) || /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA|ATTACH|DETACH)\b/i.test(tokens)
      || /;\s*\S/.test(tokens)) throw new Error("status-profile-read-only-guard");
    const statement = (params = []) => {
      const all = async () => {
        const result = await query(sql, params);
        receipts.push(result.meta ?? {});
        return result;
      };
      return { bind: (...values) => statement(values), all, run: all,
        first: async (column) => { const row = (await all()).results?.[0] ?? null; return column && row ? row[column] : row; },
        raw: async () => (await all()).results.map((row) => Object.values(row)),
      };
    };
    return statement();
  }
  const db = { prepare, batch: async (statements) => {
    const results = [];
    for (const statement of statements) results.push(await statement.all());
    return results;
  } };
  return { ...db, withSession: () => db };
}

export async function profileStatusRoute(args = {}, { env = process.env, fetchImpl = fetch, now = () => new Date(), handler, trackerFactory, query } = {}) {
  register();
  const receipts = [];
  if (!query) {
    const account = env.CLOUDFLARE_ACCOUNT_ID;
    const database = env.CLOUDFLARE_D1_DATABASE_ID;
    const token = env.CLOUDFLARE_API_TOKEN;
    if (!/^[a-f0-9]{32}$/i.test(account ?? "") || !/^[a-f0-9-]{36}$/i.test(database ?? "") || !token?.trim()) {
      throw new Error("Status profile requires CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID and CLOUDFLARE_API_TOKEN (D1 read)");
    }
    query = async (sql, params) => {
      const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ sql, params }),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error("status-profile-d1-http-failed"); }
      const body = await response.json();
      if (body.success !== true || body.result?.length !== 1 || body.result[0].success !== true || !Array.isArray(body.result[0].results)) throw new Error("status-profile-d1-envelope-invalid");
      return body.result[0];
    };
  }
  handler ??= (await import("../../worker/src/api/status.ts")).handleStatus;
  trackerFactory ??= (await import("../../worker/src/lib/d1-cost.ts")).createD1CostTracker;
  const tracker = trackerFactory(createReadOnlyProfileDb(query, receipts));
  const started = performance.now();
  const response = await handler({ db: tracker.db, request: new Request("https://ops-api.pharos.watch/api/status"), trustedAdmin: true });
  const body = await response.json();
  const cost = tracker.snapshot();
  // first() hides binding metadata from the seam; the transport retains those same receipts too.
  const complete = receipts.length > 0 && receipts.every((meta) => Number.isFinite(meta.rows_read) && Number.isFinite(meta.duration ?? meta.timings?.sql_duration_ms));
  const sectionErrors = Object.keys(body.sectionErrors ?? {});
  const durationMs = performance.now() - started;
  let selfCheck = { coverage: "unavailable", reason: "self-check-cost-unavailable", cost: null };
  try {
    const result = await query("SELECT started_at, CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.d1Cost') END AS cost FROM cron_runs WHERE job = 'status-self-check' ORDER BY started_at DESC LIMIT 1", []);
    const row = result.results[0];
    const cost = typeof row?.cost === "string" ? JSON.parse(row.cost) : row?.cost;
    if (cost && typeof cost === "object") selfCheck = { coverage: cost.coverage ?? "partial", reason: null, cost, startedAt: row.started_at };
  } catch { /* Profile retains an explicit unavailable self-check, not a zero-cost claim. */ }
  return { schemaVersion: 1, generatedAt: now().toISOString(), route: "/api/status", mode: "source-handler-remote-d1-read-only",
    statements: cost.queries, rowsRead: complete ? receipts.reduce((sum, meta) => sum + meta.rows_read, 0) : null,
    sqlDurationMs: complete ? receipts.reduce((sum, meta) => sum + (meta.timings?.sql_duration_ms ?? meta.duration), 0) : null,
    durationMs, d1Cost: cost, httpStatus: response.status, sectionErrors, selfCheck,
    coverage: complete && response.ok && sectionErrors.length === 0 && selfCheck.coverage === "complete" && !cost.reasons.includes("failed-attempt-rows-unavailable") ? "complete" : "partial",
    reasons: [...(!complete ? ["d1-meta-unavailable"] : []), ...(sectionErrors.length ? ["status-sections-unavailable"] : []), ...(selfCheck.coverage !== "complete" ? ["self-check-cost-incomplete"] : [])],
    limitations: ["Local source handler, not deployed HTTP/colo wall time", "No optional Cloudflare/price-provider credentials supplied", "Self-check cost is the latest persisted observation, not executed by this command"],
  };
}
