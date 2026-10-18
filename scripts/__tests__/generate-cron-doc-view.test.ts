import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CRON_SCHEDULE_CADENCES } from "@shared/lib/cron-cadences";
import { CRON_SCHEDULES, CRON_TRIGGER_SCHEDULES, type CronScheduleKey } from "@shared/lib/cron-jobs";
import { SCHEDULED_SLOT_PLANS, SCHEDULED_TASK_DESCRIPTORS } from "@shared/lib/scheduled-runner-registry";
import {
  loadCronDocTriggers,
  renderCronDocView,
  renderScheduledTaskTopology,
  replaceCronDocView,
  START_MARKER,
  END_MARKER,
  TASK_START_MARKER,
  TASK_END_MARKER,
} from "../maintenance/generate-cron-doc-view";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const triggers = loadCronDocTriggers(ROOT);

describe("generate-cron-doc-view", () => {
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

  it("projects every executable task with its chain position and descriptor policies", () => {
    const block = renderScheduledTaskTopology();
    const rows = block.split("\n").filter((line) => line.startsWith("| `"));
    expect(rows).toHaveLength(SCHEDULED_TASK_DESCRIPTORS.length);
    for (const descriptor of SCHEDULED_TASK_DESCRIPTORS) {
      const matches = rows.filter((row) => row.startsWith(`| \`${descriptor.scheduleKey}\` | \`${descriptor.job}\` |`));
      expect(matches).toHaveLength(1);
      expect(matches[0]).toContain(`| ${descriptor.maxConnections} | ${descriptor.timeoutMs / 1_000} |`);
      expect(matches[0]).toContain(descriptor.chainIndex == null
        ? `side stage, task ${descriptor.taskIndex + 1}`
        : `chain ${descriptor.chainIndex + 1}, task ${descriptor.taskIndex + 1}`);
    }
    expect(block).toContain("at most four authoritative production edits");
    expect(block).toContain("300-second timeout");
    expect(block).toContain("30 / 3");
    expect(block).toContain("admission evidence required");
    expect(block).toContain("DEX publication slot");
    expect(block).toContain("Monday UTC");
    expect(block).toContain("not leased by the scheduled wrapper");
  });

  it("inserts and independently refreshes both generated blocks without changing authored prose", () => {
    const doc = "# Worker Infrastructure\n\n## Cron Scheduling\n\nAuthored scheduling.\n\n## Shared Database Helpers\n\nAuthored database.\n";
    const cadence = renderCronDocView(triggers);
    const tasks = renderScheduledTaskTopology();
    const withCadence = replaceCronDocView(doc, cadence);
    const next = replaceCronDocView(withCadence, tasks, "tasks");
    for (const marker of [START_MARKER, END_MARKER, TASK_START_MARKER, TASK_END_MARKER]) {
      expect(next.split(marker)).toHaveLength(2);
    }
    expect(next).toContain("Authored scheduling.");
    expect(next).toContain("Authored database.");
    expect(next.indexOf(TASK_START_MARKER)).toBeGreaterThan(next.indexOf("Authored scheduling."));
    expect(next.indexOf(TASK_END_MARKER)).toBeLessThan(next.indexOf("## Shared Database Helpers"));
    expect(replaceCronDocView(replaceCronDocView(next, cadence), tasks, "tasks")).toBe(next);
  });

  it("rejects missing, reversed or duplicate generated-task markers", () => {
    const tasks = renderScheduledTaskTopology();
    for (const doc of [
      TASK_START_MARKER,
      TASK_END_MARKER,
      `${TASK_END_MARKER}\n${TASK_START_MARKER}`,
      `${tasks}\n${TASK_START_MARKER}`,
      `${tasks}\n${TASK_END_MARKER}`,
    ]) {
      expect(() => replaceCronDocView(doc, tasks, "tasks")).toThrow("Expected exactly one complete scheduled-task-topology");
    }
    expect(() => replaceCronDocView("no insertion heading", tasks, "tasks")).toThrow("Shared Database Helpers");
  });
});
