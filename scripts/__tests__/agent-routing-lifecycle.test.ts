import { describe, expect, it } from "vitest";
import { buildFocusedCheckPlan } from "../maintenance/run-focused-checks";

describe("scheduled lifecycle routing", () => {
  it.each([
    "worker/src/handlers/scheduled.ts",
    "worker/src/handlers/scheduled/dispatch.ts",
    "worker/src/lib/scheduled-slot-fence.ts",
    "worker/src/lib/cron-lease-primitives.ts",
    "worker/src/lib/cron-timeouts.ts",
    "worker/src/lib/v9-slot-window.ts",
  ])("preserves cron context and checks for %s", (file) => {
    const plan = buildFocusedCheckPlan([file]);
    expect(plan.classification.mappings.map((mapping) => mapping.id)).toContain("worker-cron");
    const checks = plan.checks.map((check) => check.command).join("\n");
    expect(checks).toContain("check:cron-sync");
    expect(checks).toContain("check:cron-connections");
    expect(checks).toContain("cron-leases-scheduled-slot.test.ts");
    expect(checks).toContain("cron-timeouts.test.ts");
  });

  it("keeps an ordinary Worker helper outside the sensitive cron family", () => {
    const plan = buildFocusedCheckPlan(["worker/src/lib/format.ts"]);
    expect(plan.classification.mappings.map((mapping) => mapping.id)).not.toContain("worker-cron");
  });
});
