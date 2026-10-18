import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createD1Client } from "../lib/remote-d1.ts";
import { readCronDelivery } from "./cron-delivery.mjs";
import { summarizeWorkerEvidence, renderWorkerEvidenceTable } from "./worker-evidence-report.mjs";

const DAY = 86400;
const LIMIT = 50000;
const WORKERS = ["stablecoin-api", "stablecoin-heavy"];
// Only known structural fields cross the artifact boundary: no errors, arbitrary metadata, SQL or credentials.
const CHILD_FIELDS = ["job", "started_at", "duration_ms", "status", "slot_started_at", "schedule_key", "invocation_id", "worker_version", "productive", "publication_count", "synthetic_reason", "child_disposition", "synthetic_invocation", "output_published_at"];
const PUBLICATION_FIELDS = ["surface", "generation_id", "state", "started_at", "published_at", "expected_rows", "published_rows"];
const pick = (row, fields) => Object.fromEntries(fields.map((key) => [key, row[key] ?? null]));
const label = (rows, reason = null) => ({ coverage: reason ? "partial" : rows.length >= LIMIT ? "partial" : "complete", reason: reason ?? (rows.length >= LIMIT ? "row-limit-reached" : null), rows });

export function assembleIncidentBundle(shards, endSec) {
  const startSec = endSec - 21 * DAY;
  const days = new Map();
  for (const shard of shards) {
    if (shard.schemaVersion !== 1 || !Number.isInteger(shard.from) || shard.to !== shard.from + DAY || shard.from < startSec || shard.to > endSec) continue;
    days.set(shard.from, shard);
  }
  const missingDays = [];
  for (let from = startSec; from < endSec; from += DAY) if (!days.has(from)) missingDays.push(new Date(from * 1000).toISOString().slice(0, 10));
  const ordered = [...days.values()].sort((a, b) => a.from - b.from);
  return { schemaVersion: 1, from: startSec, to: endSec, days: ordered, missingDays,
    coverage: missingDays.length || ordered.some((day) => Object.values(day.sources).some((source) => source.coverage !== "complete")) ? "partial" : "complete",
    reasons: missingDays.length ? ["daily-artifact-history-missing"] : [],
    limitations: ["Deployment API is a bounded recent inventory, not an activation-time proof", "Delivered-to-child joins require singleton cron + scheduled time and explicit worker version; ambiguous matches remain unjoined", "Publication timestamps are evidence, not proof of child causality without a matching persisted generation", "No hot D1 retention extension; missing historical days cannot be reconstructed as success"],
  };
}

export function joinIncidentEvidence(deliveries, children, deployments, publications, scheduleDefinitions) {
  return deliveries.map((delivery) => {
    const slot = Date.parse(delivery.scheduledDatetime) / 1000;
    const scheduleKeys = Object.entries(scheduleDefinitions).filter(([, definition]) => (definition.triggerSchedules ?? [definition.schedule]).includes(delivery.cron)).map(([key]) => key);
    const peers = deliveries.filter((candidate) => candidate.scriptName === delivery.scriptName && candidate.cron === delivery.cron && candidate.scheduledDatetime === delivery.scheduledDatetime);
    const candidates = children.filter((child) => child.slot_started_at === slot && scheduleKeys.includes(child.schedule_key));
    const invocationIds = new Set(candidates.map((child) => child.invocation_id ?? child.synthetic_invocation).filter(Boolean));
    const versions = new Set(candidates.map((child) => child.worker_version).filter(Boolean));
    const matchedDeployment = deployments.filter((deployment) => deployment.scriptName === delivery.scriptName && deployment.versions?.some((version) => versions.has(version.id)));
    const joined = peers.length === 1 && scheduleKeys.length === 1 && invocationIds.size === 1 && versions.size === 1 && matchedDeployment.length === 1;
    return { ...delivery, join: joined ? "singleton-version-match" : "unattributed", reason: joined ? null : "missing-or-ambiguous-identity",
      deployment: joined ? matchedDeployment[0].id : null, invocationId: joined ? [...invocationIds][0] : null,
      children: joined ? candidates : [],
      publications: joined ? publications.filter((publication) => candidates.some((child) => child.output_published_at != null && publication.published_at === child.output_published_at))
        .map((publication) => ({ ...publication, correlation: "timestamp-only-not-causal-proof" })) : [],
    };
  });
}

export async function captureWorkerIncidentBundle(args, { env = process.env, now = new Date(), query, fetchImpl = fetch, deliveryReader = readCronDelivery } = {}) {
  const to = Math.floor(now.getTime() / 1000 / DAY) * DAY;
  const from = to - DAY;
  const outDir = resolve(args.outDir ?? "agents/worker-incidents");
  mkdirSync(outDir, { recursive: true });
  const sources = {};
  let collectionFailed = false;
  query ??= (sql) => createD1Client(args.database, { target: args.remote ? "remote" : "local", maxBuffer: 64 * 1024 * 1024 }).query(sql);
  const select = (key, sql, fields) => {
    try { const rows = query(sql).map((row) => pick(row, fields)); sources[key] = label(rows); return rows; }
    catch { sources[key] = label([], `${key}-read-failed`); collectionFailed = true; return []; }
  };
  const children = select("children", `SELECT job, started_at, duration_ms, status, slot_started_at, schedule_key, invocation_id, worker_version, productive, publication_count,
    CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.reason') END AS synthetic_reason,
    CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.childDisposition') END AS child_disposition,
    CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.slotOwner') END AS synthetic_invocation,
    CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.outputPublishedAt') END AS output_published_at
    FROM cron_runs WHERE COALESCE(slot_started_at, started_at) >= ${from} AND COALESCE(slot_started_at, started_at) < ${to}
    ORDER BY COALESCE(slot_started_at, started_at), job LIMIT ${LIMIT}`, CHILD_FIELDS);
  const publications = [
    ...select("surfacePublications", `SELECT surface, generation_id, state, started_at, published_at, expected_rows, published_rows FROM surface_publication_generations WHERE started_at >= ${from} AND started_at < ${to} ORDER BY started_at LIMIT ${LIMIT}`, PUBLICATION_FIELDS),
    ...select("dexPublications", `SELECT 'dex-liquidity' AS surface, generation_id, state, started_at, published_at, expected_row_count AS expected_rows, current_row_count AS published_rows FROM dex_liquidity_publication_generations WHERE started_at >= ${from} AND started_at < ${to} ORDER BY started_at LIMIT ${LIMIT}`, PUBLICATION_FIELDS),
    ...select("yieldPublications", `SELECT 'yield-rankings' AS surface, generation_id, state, started_at, published_at, ranking_count AS published_rows FROM yield_publication_generations WHERE started_at >= ${from} AND started_at < ${to} ORDER BY started_at LIMIT ${LIMIT}`, PUBLICATION_FIELDS),
  ];
  const deliveries = [];
  const deployments = [];
  for (const scriptName of WORKERS) {
    try {
      const result = await deliveryReader({ minutes: 1440, now: new Date(to * 1000), token: env.CLOUDFLARE_WORKERS_ANALYTICS_API_TOKEN, accountId: env.CLOUDFLARE_ACCOUNT_ID, scriptName, fetchImpl });
      const rows = result.rows.filter((row) => Date.parse(row.scheduledDatetime) >= from * 1000 && Date.parse(row.scheduledDatetime) < to * 1000)
        .map((row) => ({ ...pick(row, ["datetime", "scheduledDatetime", "cron", "status", "cpuTimeUs"]), scriptName }));
      sources[`deliveries:${scriptName}`] = label(rows); deliveries.push(...rows);
    } catch { sources[`deliveries:${scriptName}`] = label([], "scheduled-invocations-unavailable"); collectionFailed = true; }
    try {
      if (!env.CLOUDFLARE_API_TOKEN || !/^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID ?? "")) throw new Error();
      const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${scriptName}/deployments`, {
        headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` }, redirect: "error", signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error(); }
      const body = await response.json();
      if (body.success !== true || !Array.isArray(body.result?.deployments)) throw new Error();
      const rows = body.result.deployments.slice(0, 100).map((row) => ({ ...pick(row, ["id", "created_on"]), scriptName,
        versions: (row.versions ?? []).map((version) => pick(version, ["id", "percentage"])) }));
      sources[`deployments:${scriptName}`] = label(rows, "recent-inventory-not-full-window"); deployments.push(...rows);
    } catch { sources[`deployments:${scriptName}`] = label([], "deployment-inventory-unavailable"); collectionFailed = true; }
  }
  const { CRON_SCHEDULE_DEFINITIONS } = await import("../../shared/lib/cron-jobs.ts");
  const shard = { schemaVersion: 1, from, to, capturedAt: now.toISOString(), sources,
    chains: joinIncidentEvidence(deliveries, children, deployments, publications, CRON_SCHEDULE_DEFINITIONS),
    summary: summarizeWorkerEvidence(children, { publications }),
  };
  let previous = [];
  const previousPath = args.archiveDir ? resolve(args.archiveDir, "bundle.json") : null;
  if (previousPath && existsSync(previousPath)) {
    try {
      const archive = JSON.parse(readFileSync(previousPath, "utf8"));
      if (archive.schemaVersion !== 1 || !Array.isArray(archive.days)) throw new Error();
      previous = archive.days;
    } catch { collectionFailed = true; shard.sources.archive = label([], "previous-artifact-unreadable"); }
  }
  const bundle = assembleIncidentBundle([...previous, shard], to);
  writeFileSync(resolve(outDir, "bundle.json"), `${JSON.stringify(bundle)}\n`);
  writeFileSync(resolve(outDir, "report.md"), [`# Worker incident evidence (21-day bounded archive)`, "", `Coverage: **${bundle.coverage}**; missing UTC days: ${bundle.missingDays.join(", ") || "none"}.`, "",
    ...bundle.limitations.map((limitation) => `- ${limitation}`), "", `## Latest captured day: ${new Date(from * 1000).toISOString().slice(0, 10)}`, "",
    renderWorkerEvidenceTable(shard.summary), "", ...Object.entries(sources).map(([key, source]) => `- ${key}: ${source.coverage}; ${source.reason ?? "bounded read complete"}; ${source.rows.length} rows`), "",
  ].join("\n"));
  return { coverage: bundle.coverage, missingDays: bundle.missingDays, collectionFailed, output: outDir };
}
