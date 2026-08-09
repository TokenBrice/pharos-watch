import { describe, expect, it } from "vitest";

import { CRON_SCHEDULE_CADENCES, V9_EVIDENCE_PRODUCER_INTERVAL_SEC } from "../cron-cadences";
import { CRON_INTERVALS, CRON_JOB_DEFINITIONS, CRON_SCHEDULES } from "../cron-jobs";

describe("cron cadence split", () => {
  it("keeps a cadence entry for every schedule key the job table uses", () => {
    for (const key of Object.keys(CRON_SCHEDULES)) {
      expect(CRON_SCHEDULE_CADENCES).toHaveProperty(key);
    }
    expect(Object.keys(CRON_SCHEDULE_CADENCES).sort()).toEqual(Object.keys(CRON_SCHEDULES).sort());
  });

  it("binds every job to a cadence with a positive interval", () => {
    for (const definition of CRON_JOB_DEFINITIONS) {
      expect(CRON_SCHEDULE_CADENCES[definition.scheduleKey].intervalSec).toBeGreaterThan(0);
      expect(definition.intervalSec).toBeGreaterThan(0);
    }
  });

  it("pins the Safety Score v9 evidence-freshness producers to their live cron cadence", () => {
    for (const [job, intervalSec] of Object.entries(V9_EVIDENCE_PRODUCER_INTERVAL_SEC)) {
      expect(CRON_INTERVALS[job], `producer cadence drifted for ${job}`).toBe(intervalSec);
    }
  });
});
