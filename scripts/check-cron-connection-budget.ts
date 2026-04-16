import { CRON_JOB_DEFINITIONS } from "../shared/lib/cron-jobs";

const MAX_CONNECTIONS_PER_TRIGGER = 6;

// Group jobs by their schedule key (which maps to a cron trigger).
const jobsByTrigger = new Map<string, { job: string; maxConnections: number; connectionGroup: string }[]>();

for (const def of CRON_JOB_DEFINITIONS) {
  const key = def.scheduleKey;
  if (!jobsByTrigger.has(key)) jobsByTrigger.set(key, []);
  jobsByTrigger.get(key)!.push({
    job: def.job,
    maxConnections: def.maxConnections ?? 0,
    connectionGroup: def.connectionGroup ?? def.job,
  });
}

let failed = false;

function pluralize(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

for (const [scheduleKey, jobs] of jobsByTrigger) {
  const groups = new Map<string, { peak: number; jobs: string[] }>();
  for (const job of jobs) {
    const group = groups.get(job.connectionGroup) ?? { peak: 0, jobs: [] };
    group.peak = Math.max(group.peak, job.maxConnections);
    group.jobs.push(job.job);
    groups.set(job.connectionGroup, group);
  }
  const totalConnections = Array.from(groups.values()).reduce((sum, group) => sum + group.peak, 0);

  if (totalConnections > MAX_CONNECTIONS_PER_TRIGGER) {
    console.error(
      `FAIL: Trigger "${scheduleKey}" uses ${totalConnections}/${MAX_CONNECTIONS_PER_TRIGGER} connections:`,
    );
    for (const [groupKey, group] of groups) {
      console.error(`  - ${groupKey}: ${group.peak} connections (${group.jobs.join(" -> ")})`);
    }
    failed = true;
  } else {
    console.log(
      `OK: "${scheduleKey}" — ${totalConnections}/${MAX_CONNECTIONS_PER_TRIGGER} connections (${pluralize(groups.size, "group")}, ${pluralize(jobs.length, "job")})`,
    );
  }
}

if (failed) {
  console.error("\nConnection budget exceeded. Rebalance jobs across triggers.");
  process.exit(1);
} else {
  console.log(`\nAll ${jobsByTrigger.size} triggers within connection budget.`);
}
