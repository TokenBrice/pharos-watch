import { parseStrictCliArgs, parseCliInteger, runDirectCli, writeCliHelpIfRequested, CliUsageError } from "../lib/cli-args.mjs";
import { createD1Client } from "../lib/remote-d1.ts";

const USAGE = `Usage: npm run ops:cron-delivery -- [--minutes 120] [--source all|analytics|d1] [--raw]
Reads scheduled delivery evidence (no mutations):
  analytics: Cloudflare GraphQL workersInvocationsScheduled for one script.
  d1: remote D1 cron_slot_executions start lag (started_at - slot_started_at) for both Worker roles.
Analytics requires CLOUDFLARE_API_TOKEN or CLOUDFLARE_WORKERS_ANALYTICS_API_TOKEN with Analytics read permission.
Optional: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_WORKER_NAME (default stablecoin-api). D1 uses Wrangler auth.
--minutes: integer 1..1440; --source: default all; --raw: emit JSON; -h/--help: show help.`;
const LIMIT = 10_000;
const SOURCES = ["all", "analytics", "d1"];
/** Same late-start budget as the admin `scheduled_delivery_lag_elevated` cause. */
export const LATE_START_SEC = 300;

export function parseCronDeliveryArgs(argv) {
  const { values } = parseStrictCliArgs(argv, { options: {
    minutes: { type: "string", default: "120" }, raw: { type: "boolean" }, source: { type: "string", default: "all" },
  } });
  if (values.help) return { help: true };
  if (!SOURCES.includes(values.source)) throw new CliUsageError(`--source must be one of ${SOURCES.join(", ")}`);
  return {
    minutes: parseCliInteger(values.minutes, { name: "--minutes", min: 1, max: 1440 }),
    raw: values.raw === true,
    source: values.source,
  };
}

export function resolveAnalyticsToken(env) {
  return env.CLOUDFLARE_API_TOKEN?.trim() || env.CLOUDFLARE_WORKERS_ANALYTICS_API_TOKEN?.trim() || undefined;
}

export function buildScheduledInvocationQuery(limit = LIMIT) {
  return `query($a:String!,$f:Time!,$t:Time!,$s:String!){viewer{accounts(filter:{accountTag:$a}){
    workersInvocationsScheduled(limit:${limit},filter:{scriptName:$s,datetime_geq:$f,datetime_leq:$t},orderBy:[datetime_ASC]){
      datetime scheduledDatetime cron status cpuTimeUs }}}}`;
}

export async function readCronDelivery({ minutes = 120, token, accountId = "a8e445f07ec0022391b6b090c6ce01c2", scriptName = "stablecoin-api", now = new Date(), fetchImpl = fetch }) {
  if (!token?.trim()) throw new Error("CLOUDFLARE_API_TOKEN or CLOUDFLARE_WORKERS_ANALYTICS_API_TOKEN is required (Analytics read permission)");
  const from = new Date(now.getTime() - minutes * 60_000);
  const query = buildScheduledInvocationQuery();
  const response = await fetchImpl("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST", signal: AbortSignal.timeout(30_000),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { a: accountId, s: scriptName, f: from.toISOString(), t: now.toISOString() } }),
  });
  if (!response.ok) throw new Error(`Cloudflare Analytics HTTP ${response.status}`);
  const body = await response.json();
  if (Array.isArray(body.errors) && body.errors.length > 0) throw new Error("Cloudflare Analytics GraphQL errors; delivery evidence unavailable");
  const accounts = body.data?.viewer?.accounts;
  if (!Array.isArray(accounts) || accounts.length !== 1) throw new Error("Cloudflare Analytics account evidence unavailable");
  const rows = accounts[0].workersInvocationsScheduled;
  if (!Array.isArray(rows)) throw new Error("Cloudflare Analytics scheduled evidence malformed");
  if (rows.length >= LIMIT) throw new Error("Cloudflare Analytics result may be truncated; use a smaller --minutes window");
  for (const row of rows) {
    if (typeof row.datetime !== "string" || !Number.isFinite(Date.parse(row.datetime))
      || typeof row.scheduledDatetime !== "string" || !Number.isFinite(Date.parse(row.scheduledDatetime))
      || typeof row.cron !== "string" || typeof row.status !== "string" || !Number.isFinite(row.cpuTimeUs)) {
      throw new Error("Cloudflare Analytics scheduled row malformed");
    }
  }
  return { scriptName, from: from.toISOString(), to: now.toISOString(), rows };
}

/**
 * Actual slot starts from D1. A slot appears only once its invocation claimed
 * it, so a never-delivered slot is absent here too: absence is not success.
 */
export function readSlotDeliveryLag({ minutes = 120, now = new Date(), query = (sql) => createD1Client("stablecoin-db").query(sql) }) {
  const toSec = Math.floor(now.getTime() / 1000);
  const fromSec = toSec - minutes * 60;
  const rows = query(`SELECT slot_key, slot_started_at, started_at, started_at - slot_started_at AS lag_sec, state, result_status
      FROM cron_slot_executions
     WHERE started_at > ${fromSec} AND started_at <= ${toSec}
     ORDER BY started_at ASC
     LIMIT ${LIMIT}`);
  if (!Array.isArray(rows)) throw new Error("D1 slot evidence malformed");
  if (rows.length >= LIMIT) throw new Error("D1 slot result may be truncated; use a smaller --minutes window");
  for (const row of rows) {
    if (typeof row.slot_key !== "string" || !Number.isInteger(row.slot_started_at) || !Number.isInteger(row.started_at)
      || !Number.isInteger(row.lag_sec) || typeof row.state !== "string") {
      throw new Error("D1 slot row malformed");
    }
  }
  const late = rows.filter((row) => row.lag_sec > LATE_START_SEC);
  return {
    from: new Date(fromSec * 1000).toISOString(), to: new Date(toSec * 1000).toISOString(), rows,
    lateSlots: late.length, maxLagSec: rows.length > 0 ? Math.max(...rows.map((row) => row.lag_sec)) : null,
  };
}

function printAnalytics(result) {
  console.log(`script=${result.scriptName} rows=${result.rows.length} window=${result.from}..${result.to}`);
  if (result.rows.length === 0) console.log("No scheduled invocation evidence in this window; absence is not a success claim.");
  for (const row of result.rows) console.log(row.datetime, row.scheduledDatetime, row.status, `${Math.round(row.cpuTimeUs / 1000)}ms`, row.cron);
}

function printSlotLag(result) {
  console.log(`d1 slots=${result.rows.length} late(>${LATE_START_SEC}s)=${result.lateSlots} maxLag=${result.maxLagSec ?? "n/a"}s window=${result.from}..${result.to}`);
  if (result.rows.length === 0) console.log("No slot starts in this window; absence is not a success claim.");
  for (const row of result.rows) {
    if (row.lag_sec > LATE_START_SEC) {
      console.log(new Date(row.slot_started_at * 1000).toISOString(), new Date(row.started_at * 1000).toISOString(),
        `${row.lag_sec}s`, row.slot_key, row.state, row.result_status ?? "");
    }
  }
}

runDirectCli(import.meta.url, async () => {
  const args = parseCronDeliveryArgs(process.argv.slice(2));
  if (writeCliHelpIfRequested(args, USAGE)) return;
  const readers = {
    analytics: () => readCronDelivery({ ...args,
      token: resolveAnalyticsToken(process.env),
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      scriptName: process.env.CLOUDFLARE_WORKER_NAME,
    }),
    d1: () => readSlotDeliveryLag(args),
  };
  const printers = { analytics: printAnalytics, d1: printSlotLag };
  const sources = args.source === "all" ? ["analytics", "d1"] : [args.source];
  const raw = {};
  for (const source of sources) {
    try {
      const result = await readers[source]();
      if (args.raw) raw[source] = result.rows;
      else printers[source](result);
    } catch (error) {
      // One unavailable source must not read as clean delivery from the other.
      if (sources.length === 1) throw error;
      process.exitCode = 1;
      if (args.raw) raw[source] = null;
      console.error(`${source} delivery evidence unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (args.raw) console.log(JSON.stringify(sources.length === 1 ? raw[sources[0]] : raw));
});
