import { describe, expect, it } from "vitest";
import {
  CRON_JOB_DEFINITIONS,
  CRON_SCHEDULES,
  SAFETY_SCORE_V9_PUBLICATION_REFRESH_INTERVAL_SEC,
  SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_REFRESH_INTERVAL_SEC,
  getCronSlotStartedAtForSchedule,
} from "../cron-jobs";

describe("cron job schedule metadata", () => {
  it("derives 26/56 minute slots for the DEWS/PSI offset schedule", () => {
    const firstSlot = Date.parse("2026-04-19T16:26:30Z");
    const secondSlot = Date.parse("2026-04-19T16:56:05Z");

    expect(getCronSlotStartedAtForSchedule("dewsPsiOffset", firstSlot)).toBe(
      Math.floor(Date.parse("2026-04-19T16:26:00Z") / 1000),
    );
    expect(getCronSlotStartedAtForSchedule("dewsPsiOffset", secondSlot)).toBe(
      Math.floor(Date.parse("2026-04-19T16:56:00Z") / 1000),
    );
  });

  it("keeps private V9 work on dedicated post-publication triggers", () => {
    expect(CRON_SCHEDULES.v9SupplyAttributionOffset).toBe(
      "8,23,38,53 * * * *",
    );
    expect(CRON_SCHEDULES.v9PublicationOffset).toBe(
      "14,44 * * * *",
    );
    expect(CRON_SCHEDULES.halfHourlyMintBurnExtended).toBe(
      "18,48 * * * *",
    );
    expect(
      CRON_JOB_DEFINITIONS.find(
        (definition) =>
          definition.job === "sync-v9-supply-attribution",
      ),
    ).toMatchObject({
      scheduleKey: "v9SupplyAttributionOffset",
      intervalSec: SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_REFRESH_INTERVAL_SEC,
      triggerMode: "isolated",
      connectionGroup: "v9-supply-attribution-chain",
    });
    expect(
      CRON_JOB_DEFINITIONS.find(
        (definition) =>
          definition.job === "compute-safety-score-v9",
      ),
    ).toMatchObject({
      scheduleKey: "v9PublicationOffset",
      intervalSec: SAFETY_SCORE_V9_PUBLICATION_REFRESH_INTERVAL_SEC,
      triggerMode: "isolated",
      connectionGroup: "v9-publication-chain",
    });
    expect(
      CRON_JOB_DEFINITIONS.filter(
        (definition) => definition.scheduleKey === "quarterHourly",
      ).map((definition) => definition.job),
    ).not.toContain("sync-v9-supply-attribution");
  });
});
