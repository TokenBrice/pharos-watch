import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CRON_CONNECTION_BUDGET_ENTRIES,
  CRON_JOB_DEFINITIONS,
  CRON_SCHEDULES,
} from "../../shared/lib/cron-jobs";
import {
  flattenScheduledSlotPlanJobs,
  getScheduledSlotPlanBudgetEntries,
  SCHEDULED_SLOT_PLANS,
  SCHEDULED_SLOT_PLANS_BY_SCHEDULE,
} from "../../shared/lib/scheduled-runner-registry";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Parse wrangler.toml cron triggers
const wranglerToml = readFileSync(join(ROOT, "worker/wrangler.toml"), "utf-8");
const cronMatches = wranglerToml.match(/crons\s*=\s*\[([\s\S]*?)\]/);
if (!cronMatches) {
  console.error("Could not find crons array in wrangler.toml");
  process.exit(1);
}
const wranglerCrons = new Set(
  cronMatches[1].match(/"([^"]+)"/g)?.map((s) => s.replace(/"/g, "")) ?? [],
);

const sharedCrons = new Set<string>(Object.values(CRON_SCHEDULES));
const slotPlanCrons = new Set<string>(Object.keys(SCHEDULED_SLOT_PLANS_BY_SCHEDULE));

// Compare
const onlyInWrangler = [...wranglerCrons].filter((c) => !sharedCrons.has(c));
const onlyInShared = [...sharedCrons].filter((c) => !wranglerCrons.has(c));
const onlyInSlotPlans = [...slotPlanCrons].filter((c) => !sharedCrons.has(c));
const missingSlotPlan = [...sharedCrons].filter((c) => !slotPlanCrons.has(c));
const planKeys = new Set(Object.keys(SCHEDULED_SLOT_PLANS));
const missingPlanKeys = Object.keys(CRON_SCHEDULES).filter((key) => !planKeys.has(key));
const extraPlanKeys = [...planKeys].filter((key) => !(key in CRON_SCHEDULES));

const runtimeJobs = new Set(Object.values(SCHEDULED_SLOT_PLANS).flatMap(flattenScheduledSlotPlanJobs));
const expectedCronJobs = new Set(CRON_JOB_DEFINITIONS.map((definition) => definition.job));
const missingRuntimeJobs = [...expectedCronJobs].filter((job) => !runtimeJobs.has(job));
const unknownRuntimeJobs = [...runtimeJobs].filter((job) => !expectedCronJobs.has(job));

const scheduledBudgetJobs = new Set(
  Object.values(SCHEDULED_SLOT_PLANS).flatMap(getScheduledSlotPlanBudgetEntries),
);
const expectedBudgetJobs = new Set(CRON_CONNECTION_BUDGET_ENTRIES.map((definition) => definition.job));
const missingBudgetJobs = [...expectedBudgetJobs].filter((job) => !scheduledBudgetJobs.has(job));
const unknownBudgetJobs = [...scheduledBudgetJobs].filter((job) => !expectedBudgetJobs.has(job));

if (
  onlyInWrangler.length ||
  onlyInShared.length ||
  onlyInSlotPlans.length ||
  missingSlotPlan.length ||
  missingPlanKeys.length ||
  extraPlanKeys.length ||
  missingRuntimeJobs.length ||
  unknownRuntimeJobs.length ||
  missingBudgetJobs.length ||
  unknownBudgetJobs.length
) {
  console.error("Cron schedule mismatch detected!");
  if (onlyInWrangler.length) console.error("In wrangler.toml only:", onlyInWrangler);
  if (onlyInShared.length) console.error("In CRON_SCHEDULES only:", onlyInShared);
  if (onlyInSlotPlans.length) console.error("In SCHEDULED_SLOT_PLANS_BY_SCHEDULE only:", onlyInSlotPlans);
  if (missingSlotPlan.length) console.error("Missing slot plan(s) for CRON_SCHEDULES:", missingSlotPlan);
  if (missingPlanKeys.length) console.error("Missing SCHEDULED_SLOT_PLANS keys:", missingPlanKeys);
  if (extraPlanKeys.length) console.error("Unexpected SCHEDULED_SLOT_PLANS keys:", extraPlanKeys);
  if (missingRuntimeJobs.length) console.error("CRON_JOB_DEFINITIONS absent from slot plans:", missingRuntimeJobs);
  if (unknownRuntimeJobs.length) console.error("Unknown runtime jobs in slot plans:", unknownRuntimeJobs);
  if (missingBudgetJobs.length) console.error("CRON_CONNECTION_BUDGET_ENTRIES absent from slot plans:", missingBudgetJobs);
  if (unknownBudgetJobs.length) console.error("Unknown budget entries in slot plans:", unknownBudgetJobs);
  process.exit(1);
}

console.log(
  `Cron schedule check passed (${wranglerCrons.size} triggers match, ${slotPlanCrons.size} slot plans mapped).`,
);
