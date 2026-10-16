import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CRON_SCHEDULE_CADENCES } from "@shared/lib/cron-cadences";
import { CRON_SCHEDULES, CRON_TRIGGER_SCHEDULES, type CronScheduleKey } from "@shared/lib/cron-jobs";
import { SCHEDULED_SLOT_PLANS } from "@shared/lib/scheduled-runner-registry";
import {
  loadCronDocTriggers,
  renderCronDocView,
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
});
