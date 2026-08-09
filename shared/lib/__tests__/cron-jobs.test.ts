import { describe, expect, it } from "vitest";
import {
  CRON_JOB_DEFINITIONS,
  CRON_SCHEDULES,
  CRON_TRIGGER_SCHEDULES,
  SAFETY_SCORE_V9_PUBLICATION_REFRESH_INTERVAL_SEC,
  SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_REFRESH_INTERVAL_SEC,
  getCronSlotStartedAtForSchedule,
} from "../cron-jobs";

describe("cron job schedule metadata", () => {
  it("preserves half-hourly DEX slot identity across hourly physical triggers", () => {
    expect(CRON_SCHEDULES.halfHourlyOffset).toBe("10,40 * * * *");
    expect(CRON_TRIGGER_SCHEDULES.halfHourlyOffset).toEqual([
      "10 * * * *",
      "40 * * * *",
    ]);
    expect(CRON_SCHEDULES.halfHourlyChartsOffset).toBe("16,46 * * * *");
    expect(CRON_TRIGGER_SCHEDULES.halfHourlyChartsOffset).toEqual([
      "16 * * * *",
      "46 * * * *",
    ]);
  });

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

  // The V9 publication consumes whatever attribution packet exists when it runs.
  // If the capture is scheduled after the publication, every publication consumes
  // the previous cycle's packet and burns most of the 45-minute consumer
  // acceptance window before it starts. For xaut-tether that is not a soft
  // degradation: safetyScoreV9ChainRows returns no rows without a packet, so the
  // card takes the 55 control-unverified ceiling instead of its 78. Each
  // publication minute must be preceded, within its own half hour, by a capture
  // that itself follows the prepare slot producing the capture's source input.
  it("schedules every V9 capture between its prepare slot and its publication", () => {
    const minutesOf = (schedule: string): number[] =>
      schedule.split(" ")[0]!.split(",").map(Number);

    // prepare-safety-score-v9-input is the last long job in halfHourlyChartsOffset;
    // that slot's worst observed completion is start + 130s. quarterHourly, which
    // runV9AfterCoreWithinWindow gates on, is worst observed at start + 212s. Both
    // clear three minutes after the halfHourlyChartsOffset minute.
    const PREPARE_SETTLE_MINUTES = 3;
    // The capture runs 6-19s and must release the shared V9 memory lane before the
    // publication acquires it.
    const PUBLICATION_HEADROOM_MINUTES = 2;

    const prepareMinutes = minutesOf(CRON_SCHEDULES.halfHourlyChartsOffset);
    const captureMinutes = minutesOf(CRON_SCHEDULES.v9SupplyAttributionOffset);

    for (const publishMinute of minutesOf(CRON_SCHEDULES.v9PublicationOffset)) {
      const prepareMinute = Math.max(
        ...prepareMinutes.filter((minute) => minute < publishMinute),
      );
      const eligible = captureMinutes.filter(
        (minute) =>
          minute >= prepareMinute + PREPARE_SETTLE_MINUTES &&
          minute <= publishMinute - PUBLICATION_HEADROOM_MINUTES,
      );
      expect(
        eligible,
        `no V9 capture between prepare :${prepareMinute} and publication :${publishMinute}`,
      ).not.toHaveLength(0);
    }
  });

  it("captures V9 supply attribution before its dedicated publication trigger", () => {
    expect(CRON_SCHEDULES.v9SupplyAttributionOffset).toBe(
      "5,20,35,50 * * * *",
    );
    expect(CRON_SCHEDULES.v9PublicationOffset).toBe(
      "22,52 * * * *",
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
