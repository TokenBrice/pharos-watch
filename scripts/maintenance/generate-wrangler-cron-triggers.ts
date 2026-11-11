import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  listScheduledExpressionsForWorker,
  SCHEDULED_SLOT_PLANS,
  type ScheduledWorkerRole,
} from "@shared/lib/scheduled-runner-registry";
import { parseStrictCliArgs, runDirectCli, writeCliHelpIfRequested } from "../lib/cli-args.mjs";
import { parseAssignments } from "../lib/wrangler-toml.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WORKER_CONFIGS = { public: "worker/wrangler.toml", heavy: "worker/wrangler.heavy.toml" } as const;
// Preserve deployed order: registry order, with these historical tail lanes last.
const DEPLOYMENT_TAIL_SCHEDULE_KEYS = ["daily0300Utc", "v9PublicationOffset"] as const;
const USAGE = `Usage: node --import tsx scripts/maintenance/generate-wrangler-cron-triggers.ts [options]

Options:
  --check       Check cron array bytes without writing
  -h, --help    Show this help`;

export function replaceWranglerCronTriggers(toml: string, role: ScheduledWorkerRole): string {
  const sections = [...toml.matchAll(/^\[triggers\][ \t]*\r?\n[\s\S]*?(?=^\[|(?![\s\S]))/gm)];
  const assignments = parseAssignments(toml).filter(({ section, key }) => section === "triggers" && key === "crons");
  if (sections.length !== 1 || assignments.length !== 1) {
    throw new Error("Expected exactly one [triggers].crons array");
  }
  const section = sections[0];
  const arrays = [...section[0].matchAll(/^(crons = \[\r?\n)[\s\S]*?^\]/gm)];
  if (arrays.length !== 1) throw new Error("Expected a multiline crons = [ array with a closing ] line");
  const array = arrays[0];
  const expressions = listScheduledExpressionsForWorker(role);
  const tailExpressions = new Set(DEPLOYMENT_TAIL_SCHEDULE_KEYS.flatMap((key) => SCHEDULED_SLOT_PLANS[key].triggerSchedules));
  const ordered = [
    ...expressions.filter((expression) => !tailExpressions.has(expression)),
    ...expressions.filter((expression) => tailExpressions.has(expression)),
  ];
  const newline = array[1].endsWith("\r\n") ? "\r\n" : "\n";
  const start = section.index! + array.index! + array[1].length;
  const end = section.index! + array.index! + array[0].length - 1;
  return `${toml.slice(0, start)}${ordered.map((expression) => `  "${expression}",${newline}`).join("")}${toml.slice(end)}`;
}

export function syncWranglerCronTriggers(repoRoot = ROOT, check = false): void {
  const views = (Object.entries(WORKER_CONFIGS) as [ScheduledWorkerRole, string][]).map(([role, config]) => {
    const path = resolve(repoRoot, config);
    const existing = readFileSync(path, "utf8");
    return { config, path, existing, next: replaceWranglerCronTriggers(existing, role) };
  });
  const stale = views.filter(({ existing, next }) => existing !== next);
  if (check && stale.length > 0) {
    throw new Error(`${stale.map(({ config }) => config).join(", ")} cron arrays are out of date. Run npm run generate:wrangler-crons`);
  }
  if (!check) {
    for (const { path, next } of stale) writeFileSync(path, next, "utf8");
  }
}

runDirectCli(import.meta.url, () => {
  const { values } = parseStrictCliArgs(process.argv.slice(2), { options: { check: { type: "boolean" } } });
  if (writeCliHelpIfRequested(values, USAGE)) return;
  syncWranglerCronTriggers(ROOT, values.check === true);
  console.log(values.check === true ? "Wrangler cron arrays are current" : "Wrangler cron arrays generated");
}, { label: "wrangler-cron-triggers", usage: USAGE });
