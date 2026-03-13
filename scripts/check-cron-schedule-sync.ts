import { readFileSync } from "fs";
import { CRON_SCHEDULES } from "../shared/lib/cron-jobs.ts";

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

const sharedCrons = new Set(Object.values(CRON_SCHEDULES));

// Compare
const onlyInWrangler = [...wranglerCrons].filter((c) => !sharedCrons.has(c));
const onlyInShared = [...sharedCrons].filter((c) => !wranglerCrons.has(c));

if (onlyInWrangler.length || onlyInShared.length) {
  console.error("Cron schedule mismatch detected!");
  if (onlyInWrangler.length) console.error("In wrangler.toml only:", onlyInWrangler);
  if (onlyInShared.length) console.error("In CRON_SCHEDULES only:", onlyInShared);
  process.exit(1);
}

console.log(`Cron schedule check passed (${wranglerCrons.size} triggers match).`);
