import { CRON_JOB_DEFINITIONS } from "../shared/lib/cron-jobs";

const MAX_CONNECTIONS_PER_TRIGGER = 6;

// Group jobs by their schedule key (which maps to a cron trigger).
const jobsByTrigger = new Map<string, { job: string; maxConnections: number }[]>();

for (const def of CRON_JOB_DEFINITIONS) {
  const key = def.scheduleKey;
  if (!jobsByTrigger.has(key)) jobsByTrigger.set(key, []);
  jobsByTrigger.get(key)!.push({
    job: def.job,
    maxConnections: def.maxConnections ?? 0,
  });
}

let failed = false;

for (const [scheduleKey, jobs] of jobsByTrigger) {
  const totalConnections = jobs.reduce((sum, j) => sum + j.maxConnections, 0);

  if (totalConnections > MAX_CONNECTIONS_PER_TRIGGER) {
    console.error(
      `FAIL: Trigger "${scheduleKey}" uses ${totalConnections}/${MAX_CONNECTIONS_PER_TRIGGER} connections:`,
    );
    for (const j of jobs) {
      console.error(`  - ${j.job}: ${j.maxConnections} connections`);
    }
    failed = true;
  } else {
    console.log(
      `OK: "${scheduleKey}" — ${totalConnections}/${MAX_CONNECTIONS_PER_TRIGGER} connections (${jobs.length} jobs)`,
    );
  }
}

if (failed) {
  console.error("\nConnection budget exceeded. Rebalance jobs across triggers.");
  process.exit(1);
} else {
  console.log(`\nAll ${jobsByTrigger.size} triggers within connection budget.`);
}
