import { resolve, dirname, basename } from "node:path";
import { parseAssignments, unquote } from "./wrangler-toml.mjs";

export function selectSmokeConfig(config, mode) {
  const resolved = resolve(config);
  if (![resolve("worker/wrangler.toml"), resolve("worker/wrangler.heavy.toml")].includes(resolved)) {
    throw new Error("WORKER_SMOKE_CONFIG must select the public or Heavy source config");
  }
  const heavy = basename(resolved) === "wrangler.heavy.toml";
  if (heavy !== (mode === "scheduled-heavy")) throw new Error("Heavy config requires scheduled-heavy smoke; public config requires full or runtime");
  return resolved;
}

export function isolatedSmokeConfig(source, sourcePath, entryPath, date) {
  const assignments = parseAssignments(source);
  const root = dirname(sourcePath);
  const values = Object.fromEntries(assignments.filter(({ section }) => section === "root").map(({ key, value }) => [key, value]));
  if (!values.main || !values.compatibility_date || !values.compatibility_flags) throw new Error("Incomplete source runtime config");
  const aliases = Object.fromEntries(assignments.filter(({ section }) => section === "alias").map(({ key, value }) => [unquote(key), resolve(root, unquote(value))]));
  return {
    name: "pharos-isolated-runtime-smoke", main: entryPath,
    compatibility_date: date || unquote(values.compatibility_date),
    compatibility_flags: JSON.parse(values.compatibility_flags),
    minify: values.minify === "true", keep_names: values.keep_names === "true",
    tsconfig: resolve(root, "tsconfig.json"), alias: aliases,
    workers_dev: false, preview_urls: false,
    version_metadata: { binding: "CF_VERSION_METADATA" },
    rules: [{ type: "Data", globs: ["**/*.ttf"], fallthrough: true }, { type: "CompiledWasm", globs: ["**/*.wasm"], fallthrough: true }],
    d1_databases: [{ binding: "DB", database_name: "stablecoin-db", database_id: "00000000-0000-0000-0000-000000000000", migrations_dir: resolve(root, "migrations") }],
  };
}

export function nextHeavySmokeWindow(nowMs) {
  const date = new Date(nowMs);
  date.setUTCMinutes(8, 0, 0);
  if (date.getTime() < nowMs) date.setUTCHours(date.getUTCHours() + 1);
  const scheduledTimeMs = date.getTime();
  return { scheduledTimeMs, deadlineMs: scheduledTimeMs + 180_000 };
}

export function assertHeavySmokeWindow(window, nowMs) {
  if (nowMs < window.scheduledTimeMs || window.deadlineMs - nowMs < 60_000) {
    throw new Error("Heavy smoke requires the actual UTC :08 event with at least 60 seconds remaining");
  }
}

export function assertHeavyNeutralProof(parent, child, counts) {
  const metadata = JSON.parse(child?.metadata ?? "null");
  if (parent?.state !== "finished" || parent.result_status !== "ok" || !parent.worker_version?.trim()
    || child?.status !== "skipped_neutral" || child.productive !== 0 || child.item_count !== 0
    || child.degraded_reason !== "v9-core-slot-not-ready" || metadata?.reason !== "v9-core-slot-not-ready"
    || metadata.coreState !== null || metadata.coreResultStatus !== null || metadata.coreWorkerVersion !== null
    || metadata.expectedWorkerVersion !== parent.worker_version
    || metadata.coreStablecoinsPublicationMatched !== false || metadata.degradedCorePublicationMatched !== false
    || counts.core !== 0 || counts.publications !== 0 || counts.active !== 0 || counts.memory !== 0 || counts.business !== 0) {
    throw new Error("Heavy smoke did not prove the exact absent-core neutral child / ok parent contract");
  }
  return { parentResultStatus: parent.result_status, childStatus: child.status, reason: metadata.reason,
    productivity: { productive: false, reason: metadata.reason }, expectedWorkerVersion: metadata.expectedWorkerVersion,
    coreState: metadata.coreState, coreResultStatus: metadata.coreResultStatus, coreWorkerVersion: metadata.coreWorkerVersion,
    coreStablecoinsPublicationMatched: false, degradedCorePublicationMatched: false, callbackReached: false };
}

export function isolatedEntrySource(entryPath, heavy) {
  return `import worker from ${JSON.stringify(entryPath)};
const allowedWrites = new Set(["cron_leases", "cron_runs", "cron_run_progress", "cron_slot_executions", "scheduled_child_attempts", "worker_producer_history", "worker_producer_heads"]);
globalThis.fetch = async () => { console.error("WORKER_SMOKE_BLOCKED_EGRESS"); throw new Error("Isolated smoke forbids outbound fetch"); };
function isolatedEnv(env) {
  const db = env.DB;
  return { ...env, DB: new Proxy(db, { get(target, key) {
    if (key === "prepare") return (sql) => {
      const mutation = sql.trim().match(/^(?:INSERT(?: OR \\w+)? INTO|UPDATE|DELETE FROM)\\s+["\\x60]?([A-Za-z_][A-Za-z0-9_]*)/i);
      if (mutation && !allowedWrites.has(mutation[1])) { console.error("WORKER_SMOKE_BLOCKED_BUSINESS_WRITE"); throw new Error("Isolated smoke forbids business writes"); }
      return target.prepare(sql);
    };
    if (key === "exec") return () => { throw new Error("Isolated smoke forbids exec"); };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } }) };
}
export default { ${heavy
    ? 'scheduled(controller, env, ctx) { return worker.scheduled(controller, isolatedEnv(env), ctx); }'
    : 'fetch(request, env, ctx) { return worker.fetch(request, isolatedEnv(env), ctx); }'} };
`;
}
