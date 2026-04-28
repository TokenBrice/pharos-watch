import { CRON_CONNECTION_BUDGET, CRON_JOB_DEFINITIONS } from "../shared/lib/cron-jobs";

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
const headroomFullTriggers: {
  groups: Map<string, { peak: number; jobs: string[] }>;
  scheduleKey: string;
  totalConnections: number;
}[] = [];

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

  if (totalConnections >= CRON_CONNECTION_BUDGET.failAt) {
    console.error(
      `FAIL: Trigger "${scheduleKey}" uses ${totalConnections}/${CRON_CONNECTION_BUDGET.maxPerTrigger} connections:`,
    );
    for (const [groupKey, group] of groups) {
      console.error(`  - ${groupKey}: ${group.peak} connections (${group.jobs.join(" -> ")})`);
    }
    failed = true;
  } else {
    const headroomFull = totalConnections >= CRON_CONNECTION_BUDGET.fullForNewFetchHeavyWorkAt;
    if (headroomFull) {
      headroomFullTriggers.push({ scheduleKey, totalConnections, groups });
    }
    console.log(
      `${headroomFull ? "HEADROOM FULL" : "OK"}: "${scheduleKey}" — ${totalConnections}/${CRON_CONNECTION_BUDGET.maxPerTrigger} connections (${pluralize(groups.size, "group")}, ${pluralize(jobs.length, "job")})`,
    );
  }
}

if (failed) {
  console.error("\nConnection budget exceeded. Rebalance jobs across triggers.");
  process.exit(1);
} else {
  if (headroomFullTriggers.length > 0) {
    console.log(
      `\nConnection headroom policy: ${CRON_CONNECTION_BUDGET.fullForNewFetchHeavyWorkAt}/${CRON_CONNECTION_BUDGET.maxPerTrigger} connections is full for new fetch-heavy work.`,
    );
    for (const trigger of headroomFullTriggers) {
      console.log(`  - ${trigger.scheduleKey}: ${trigger.totalConnections}/${CRON_CONNECTION_BUDGET.maxPerTrigger}`);
      for (const [groupKey, group] of trigger.groups) {
        console.log(`    * ${groupKey}: ${pluralize(group.peak, "connection")} (${group.jobs.join(" -> ")})`);
      }
    }
  }
  console.log(`\nAll ${jobsByTrigger.size} triggers within connection budget.`);
}
