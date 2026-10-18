import { readFileSync } from "node:fs";
import { parseStrictCliArgs, requireCliString, runDirectCli, writeCliHelpIfRequested } from "../lib/cli-args.mjs";
import { CronRunStatusSchema } from "../../shared/types/status/cron.ts";

// Reporting preserves stored terminal status; synthetic is an orthogonal provenance count.
export function summarizeWorkerEvidence(runs, publicationGenerations = {}) {
  const counts = Object.assign(Object.create(null), Object.fromEntries(CronRunStatusSchema.options.map((status) => [status, 0])));
  const groups = new Map();
  let synthetic = 0;
  let productive = 0;
  let productiveUnknown = 0;
  let publicationCount = 0;
  let publicationUnknown = 0;
  for (const run of runs) {
    const status = run.status ?? "unknown";
    counts[status] = (counts[status] ?? 0) + 1;
    if (run.productive === 1 || run.productive === true) productive++;
    else if (run.productive !== 0 && run.productive !== false) productiveUnknown++;
    if (Number.isInteger(run.publication_count) && run.publication_count >= 0) publicationCount += run.publication_count;
    else publicationUnknown++;
    let metadata = run.metadata;
    if (typeof metadata === "string") {
      try { metadata = JSON.parse(metadata); } catch { metadata = null; }
    }
    if ((run.synthetic_reason ?? metadata?.reason) !== "stale-slot-reconciled") continue;
    synthetic++;
    const invocation = run.invocation_id ?? run.synthetic_invocation ?? metadata?.slotOwner;
    // Never merge unidentified children into a claimed invocation.
    const key = invocation ? `${run.schedule_key ?? metadata?.slotKey ?? "unknown"}|${run.slot_started_at ?? metadata?.slotStartedAt ?? "unknown"}|${invocation}` : `unattributed:${groups.size}`;
    const group = groups.get(key) ?? { invocation: key, started: 0, notStarted: 0, executionUnknown: 0, jobs: [], statuses: {} };
    const disposition = run.child_disposition ?? metadata?.childDisposition;
    if (disposition === "not_started") group.notStarted++;
    else if (["abandoned", "interrupted-by-deploy"].includes(disposition)) group.started++;
    else group.executionUnknown++;
    group.jobs.push(run.job);
    group.statuses[status] = (group.statuses[status] ?? 0) + 1;
    groups.set(key, group);
  }
  const publicationStates = {};
  for (const [surface, rows] of Object.entries(publicationGenerations)) {
    publicationStates[surface] = {};
    for (const row of rows ?? []) {
      const state = row.state ?? "unknown";
      publicationStates[surface][state] = (publicationStates[surface][state] ?? 0) + 1;
    }
  }
  return { counts, synthetic, productive, productiveUnknown, publicationCount, publicationUnknown, publicationStates,
    syntheticInvocations: [...groups.values()].map((group) => ({ ...group,
      presentation: `${group.started} started + ${group.notStarted} not-started${group.executionUnknown ? ` + ${group.executionUnknown} execution-unknown` : ""}`,
    })) };
}

export function renderWorkerEvidenceTable(summary) {
  return ["| Terminal status | Count |", "| --- | ---: |",
    ...Object.entries(summary.counts).map(([status, count]) => `| ${status} | ${count} |`),
    `| synthetic (stale-slot-reconciled; subset of terminals) | ${summary.synthetic} |`,
    `| productive (explicit evidence) | ${summary.productive} |`,
    `| productive unknown | ${summary.productiveUnknown} |`,
    `| publications (explicit count) | ${summary.publicationCount} |`,
    `| publication count unknown | ${summary.publicationUnknown} |`,
    "", "Synthetic child terminals grouped by invocation (stored statuses unchanged):",
    ...summary.syntheticInvocations.map((group) => `- ${group.invocation}: ${group.presentation}; ${JSON.stringify(group.statuses)}`),
    "", `Publication generation states: ${JSON.stringify(summary.publicationStates)}`,
  ].join("\n");
}

runDirectCli(import.meta.url, () => {
  const { values } = parseStrictCliArgs(process.argv.slice(2), { options: {
    fixture: { type: "string" }, json: { type: "boolean" },
  } });
  if (writeCliHelpIfRequested(values, "Usage: npm run ops:worker-evidence-report -- --fixture <snapshot.json> [--json]\nRender literal terminal and output evidence from a saved cron watcher snapshot.")) return;
  const snapshot = JSON.parse(readFileSync(requireCliString(values.fixture, "--fixture"), "utf8"));
  if (!Array.isArray(snapshot.recentRuns)) throw new Error("Worker snapshot recentRuns must be an array");
  const summary = summarizeWorkerEvidence(snapshot.recentRuns, snapshot.publicationGenerations);
  console.log(values.json ? JSON.stringify(summary, null, 2) : renderWorkerEvidenceTable(summary));
});
