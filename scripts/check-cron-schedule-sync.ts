import { readFileSync } from "fs";
import { CRON_SCHEDULES } from "../shared/lib/cron-jobs";
import { SCHEDULED_RUNNER_KEYS_BY_SCHEDULE } from "../shared/lib/scheduled-runner-registry";

// Parse wrangler.toml cron triggers
const wranglerToml = readFileSync("worker/wrangler.toml", "utf-8");
const cronMatches = wranglerToml.match(/crons\s*=\s*\[([\s\S]*?)\]/);
if (!cronMatches) {
  console.error("Could not find crons array in wrangler.toml");
  process.exit(1);
}
const wranglerCrons = new Set(
  cronMatches[1].match(/"([^"]+)"/g)?.map((s) => s.replace(/"/g, "")) ?? [],
);

const sharedCrons = new Set<string>(Object.values(CRON_SCHEDULES));
const runnerCrons = new Set<string>(Object.keys(SCHEDULED_RUNNER_KEYS_BY_SCHEDULE));

// Compare
const onlyInWrangler = [...wranglerCrons].filter((c) => !sharedCrons.has(c));
const onlyInShared = [...sharedCrons].filter((c) => !wranglerCrons.has(c));
const onlyInRunnerMap = [...runnerCrons].filter((c) => !sharedCrons.has(c));
const missingRunner = [...sharedCrons].filter((c) => !runnerCrons.has(c));

if (onlyInWrangler.length || onlyInShared.length || onlyInRunnerMap.length || missingRunner.length) {
  console.error("Cron schedule mismatch detected!");
  if (onlyInWrangler.length) console.error("In wrangler.toml only:", onlyInWrangler);
  if (onlyInShared.length) console.error("In CRON_SCHEDULES only:", onlyInShared);
  if (onlyInRunnerMap.length) console.error("In SCHEDULED_RUNNER_KEYS_BY_SCHEDULE only:", onlyInRunnerMap);
  if (missingRunner.length) console.error("Missing runner(s) for CRON_SCHEDULES:", missingRunner);
  process.exit(1);
}

console.log(`Cron schedule check passed (${wranglerCrons.size} triggers match, ${runnerCrons.size} runners mapped).`);
