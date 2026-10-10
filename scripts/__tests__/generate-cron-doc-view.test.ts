import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CRON_SCHEDULE_CADENCES } from "@shared/lib/cron-cadences";
import { CRON_SCHEDULES, CRON_TRIGGER_SCHEDULES, type CronScheduleKey } from "@shared/lib/cron-jobs";
import { SCHEDULED_SLOT_PLANS } from "@shared/lib/scheduled-runner-registry";
import { selectGeneratedArtifacts } from "../lib/automation-registry.mjs";
import {
  END_MARKER,
  START_MARKER,
  loadCronDocTriggers,
  renderCronDocView,
  replaceCronDocView,
  runCronDocViewCli,
} from "../maintenance/generate-cron-doc-view";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const triggers = loadCronDocTriggers(ROOT);
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(resolve(tmpdir(), "pharos-cron-doc-view-"));
  temporaryRoots.push(root);
  mkdirSync(resolve(root, "docs"));
  mkdirSync(resolve(root, "worker"));
  for (const file of ["wrangler.toml", "wrangler.heavy.toml"]) {
    writeFileSync(resolve(root, "worker", file), readFileSync(resolve(ROOT, "worker", file)));
  }
  writeFileSync(resolve(root, "docs/worker-infrastructure.md"), "# Worker\n\n## Cron Scheduling\n\nAuthored fencing contract.\n\n## Next\n\nOther contract.\n");
  return root;
}

describe("generate-cron-doc-view", () => {
  it("preserves logical cadence when physical aliases use hourly expressions", () => {
    const block = renderCronDocView(triggers);
    expect(block).toContain("| `quarterHourly` | `*/15 * * * *` | 900 / 0 | `0 * * * *`<br>`15 * * * *`<br>`30 * * * *`<br>`45 * * * *` | public |");
    expect(block).toContain("| `v9PublicationOffset` | `22,52 * * * *` | 1800 / 1320 | `22 * * * *`<br>`52 * * * *` | heavy |");
    // The historical key name must not invent a half-hour source cadence.
    expect(block).toContain("| `halfHourlyOffset` | `10 * * * *` | 3600 / 600 | `10 * * * *` | public |");
  });

  it("keeps shifted physical delivery separate from logical slot identity", () => {
    const block = renderCronDocView(triggers);
    expect(block).toContain("| `halfHourlyMeasuredExecution` | `0,30 * * * *` | 1800 / 0 | `5 * * * *`<br>`35 * * * *` | public |");
    expect(block).toContain("| `halfHourlyMeasuredExecutionSupplemental` | `15,45 * * * *` | 1800 / 900 | `20 * * * *`<br>`50 * * * *` | public |");
    expect(block).toContain("| `daily0300Utc` | `0 3 * * *` | 86400 / 10800 | `3 3 * * *` | public |");
  });

  it("projects every slot once with its registry role and deployed aliases", () => {
    const block = renderCronDocView(triggers);
    for (const key of Object.keys(CRON_SCHEDULES) as CronScheduleKey[]) {
      const plan = SCHEDULED_SLOT_PLANS[key];
      const cadence = CRON_SCHEDULE_CADENCES[key];
      const physical = CRON_TRIGGER_SCHEDULES[key].map((expression) => `\`${expression}\``).join("<br>");
      const row = `| \`${plan.scheduleKey}\` | \`${plan.schedule}\` | ${cadence.intervalSec} / ${cadence.offsetSec} | ${physical} | ${plan.worker} |`;
      expect(block.split("\n").filter((line) => line === row)).toHaveLength(1);
      for (const expression of plan.triggerSchedules) expect(triggers[plan.worker]).toContain(expression);
    }
    expect(block.split("\n").filter((line) => line.startsWith("| `"))).toHaveLength(Object.keys(CRON_SCHEDULES).length);
  });

  it("rejects missing, duplicate and misowned deployed physical aliases", () => {
    expect(() => renderCronDocView({ ...triggers, heavy: triggers.heavy.slice(1) })).toThrow("Cron sources disagree");
    const alias = triggers.heavy[0];
    expect(() => renderCronDocView({ ...triggers, public: [...triggers.public, alias] })).toThrow("Cron sources disagree");
    expect(() => renderCronDocView({ public: [...triggers.public, alias], heavy: triggers.heavy.slice(1) })).toThrow("Cron sources disagree");
  });

  it("inserts and replaces only the generated block while preserving authored text", () => {
    const authored = "# Worker\n\n## Cron Scheduling\n\nFencing contract.\n\n## Next\n\nNext contract.\n";
    const block = renderCronDocView(triggers);
    const next = replaceCronDocView(authored, block);
    expect(next).toBe(authored.replace("## Cron Scheduling\n", `## Cron Scheduling\n\n${block}\n`));
    expect(replaceCronDocView(next, block)).toBe(next);
    expect(replaceCronDocView(next.replace(block, `${START_MARKER}\nstale\n${END_MARKER}`), block)).toBe(next);
    expect(() => replaceCronDocView(`${START_MARKER}\nincomplete`, block)).toThrow("complete cron-doc-view");
    expect(() => replaceCronDocView(`${next}\n${block}`, block)).toThrow("complete cron-doc-view");
  });

  it("checks without writing and converges in write mode", () => {
    const root = fixtureRoot();
    const path = resolve(root, "docs/worker-infrastructure.md");
    const original = readFileSync(path, "utf8");
    expect(() => runCronDocViewCli(["--check"], root)).toThrow("out of date");
    expect(readFileSync(path, "utf8")).toBe(original);
    runCronDocViewCli([], root);
    const generated = readFileSync(path, "utf8");
    expect(generated).toBe(replaceCronDocView(original, renderCronDocView(triggers)));
    runCronDocViewCli(["--check"], root);
    expect(readFileSync(path, "utf8")).toBe(generated);
    runCronDocViewCli([], root);
    expect(readFileSync(path, "utf8")).toBe(generated);
  });

  it("rejects unknown options before touching the document", () => {
    const root = fixtureRoot();
    const path = resolve(root, "docs/worker-infrastructure.md");
    const original = readFileSync(path, "utf8");
    expect(() => runCronDocViewCli(["--write"], root)).toThrow();
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("registers source and output routing with check and write commands", () => {
    const artifact = selectGeneratedArtifacts({ check: true, only: ["cron-doc-view"] })[0];
    expect(artifact).toMatchObject({
      buildLifecycle: "maintenance-only",
      reproducibility: "deterministic",
      checkCommand: "node --import tsx scripts/maintenance/generate-cron-doc-view.ts --check",
      command: "node --import tsx scripts/maintenance/generate-cron-doc-view.ts",
      outputPaths: ["docs/worker-infrastructure.md"],
    });
    for (const path of ["shared/lib/cron-jobs.ts", "shared/lib/cron-cadences.ts", "shared/lib/scheduled-runner-registry.ts", "worker/wrangler.toml", "worker/wrangler.heavy.toml", "scripts/ci/check-cron-schedule-sync.ts"]) {
      expect(artifact.sourcePaths).toContain(path);
    }
  });

  it("keeps the generated primary section and infrastructure contract within budget", () => {
    const doc = replaceCronDocView(readFileSync(resolve(ROOT, "docs/worker-infrastructure.md"), "utf8"), renderCronDocView(triggers));
    const section = doc.split("## Cron Scheduling\n")[1].split("\n## ")[0];
    expect(Buffer.byteLength(section, "utf8")).toBeLessThanOrEqual(25_000);
    expect(Buffer.byteLength(doc, "utf8")).toBeLessThan(40_000);
  });
});
