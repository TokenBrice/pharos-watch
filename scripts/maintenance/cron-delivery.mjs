import { parseStrictCliArgs, parseCliInteger, runDirectCli, writeCliHelpIfRequested } from "../lib/cli-args.mjs";

const USAGE = `Usage: npm run ops:cron-delivery -- [--minutes 120] [--raw]
Reads Cloudflare workersInvocationsScheduled delivery ground truth (no mutations).
Requires CLOUDFLARE_API_TOKEN with Analytics read permission.
Optional: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_WORKER_NAME.
--minutes: integer 1..1440; --raw: emit JSON rows; -h/--help: show help.`;
const LIMIT = 10_000;

export function parseCronDeliveryArgs(argv) {
  const { values } = parseStrictCliArgs(argv, { options: {
    minutes: { type: "string", default: "120" }, raw: { type: "boolean" },
  } });
  if (values.help) return { help: true };
  return { minutes: parseCliInteger(values.minutes, { name: "--minutes", min: 1, max: 1440 }), raw: values.raw === true };
}

export async function readCronDelivery({ minutes = 120, token, accountId = "a8e445f07ec0022391b6b090c6ce01c2", scriptName = "stablecoin-api", now = new Date(), fetchImpl = fetch }) {
  if (!token?.trim()) throw new Error("CLOUDFLARE_API_TOKEN is required (Analytics read permission)");
  const from = new Date(now.getTime() - minutes * 60_000);
  const query = `query($a:String!,$f:Time!,$t:Time!,$s:String!){viewer{accounts(filter:{accountTag:$a}){
    workersInvocationsScheduled(limit:${LIMIT},filter:{scriptName:$s,datetime_geq:$f,datetime_leq:$t},orderBy:[datetime_ASC]){
      datetime scheduledDatetime cron status cpuTimeUs }}}}`;
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
  return { from: from.toISOString(), to: now.toISOString(), rows };
}

runDirectCli(import.meta.url, async () => {
  const args = parseCronDeliveryArgs(process.argv.slice(2));
  if (writeCliHelpIfRequested(args, USAGE)) return;
  const result = await readCronDelivery({ ...args,
    token: process.env.CLOUDFLARE_API_TOKEN,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    scriptName: process.env.CLOUDFLARE_WORKER_NAME,
  });
  if (args.raw) { console.log(JSON.stringify(result.rows)); return; }
  console.log(`rows=${result.rows.length} window=${result.from}..${result.to}`);
  if (result.rows.length === 0) console.log("No scheduled invocation evidence in this window; absence is not a success claim.");
  for (const row of result.rows) console.log(row.datetime, row.scheduledDatetime, row.status, `${Math.round(row.cpuTimeUs / 1000)}ms`, row.cron);
});
