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

  // applySafetyScoreV9SupplyAttributionGeneration admits a generation only when
  // captureClockSec <= fixedInput.clockSec: a publication must not depend on an
  // observation taken after its own input snapshot. prepare-safety-score-v9-input
  // stamps that clock, so a capture must precede the prepare slot it will be
  // consumed against — NOT sit between prepare and the publication. A capture in
  // that gap is rejected as capture-clock-after-consumer, and
  // isSafetyScoreV9SupplyAttributionGenerationCadenceDeferred then skips the
  // publication on every subsequent cycle. Proven in production on 2026-08-09:
  // moving the grid to 5,20,35,50 froze publications at the 10:22 slot with
  // reason supply-attribution-generation-cadence-deferred.
  //
  // The capture must also stay inside the 45-minute consumer acceptance window,
  // or the publication rejects it as generation-stale and xaut-tether falls to
  // the 55 control-unverified ceiling (safetyScoreV9ChainRows returns no rows
  // for XAUT without a packet).
  // The generation cache is a single row, so each capture overwrites the last and
  // the publication only ever sees the MOST RECENT capture. It is that capture,
  // not the best-fitting one, that must satisfy both admission rules.
  it("keeps the last V9 capture before each publication admissible", () => {
    const minutesOf = (schedule: string): number[] =>
      schedule.split(" ")[0]!.split(",").map(Number);

    // SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_CONSUMER_ACCEPTANCE_WINDOW_SEC.
    const CONSUMER_ACCEPTANCE_WINDOW_MINUTES = 45;

    const prepareMinutes = minutesOf(CRON_SCHEDULES.halfHourlyChartsOffset);
    const captureMinutes = minutesOf(CRON_SCHEDULES.v9SupplyAttributionOffset);

    for (const publishMinute of minutesOf(CRON_SCHEDULES.v9PublicationOffset)) {
      const prepareMinute = Math.max(
        ...prepareMinutes.filter((minute) => minute < publishMinute),
      );
      // Lag back from the publication, wrapping the hour so a capture in the
      // previous half hour is still reachable.
      const lagOf = (minute: number) =>
        minute < publishMinute ? publishMinute - minute : publishMinute - minute + 60;
      const lastCaptureLag = Math.min(...captureMinutes.map(lagOf));
      const prepareLag = publishMinute - prepareMinute;

      // captureClockSec <= fixedInput.clockSec: the last capture must be at or
      // before the prepare slot, i.e. at least as far back from the publication.
      expect(
        lastCaptureLag,
        `the last V9 capture before publication :${publishMinute} lands after prepare :${prepareMinute}, so it is rejected as capture-clock-after-consumer and the publication cadence-defers forever`,
      ).toBeGreaterThanOrEqual(prepareLag);

      expect(
        lastCaptureLag,
        `the last V9 capture before publication :${publishMinute} is older than the ${CONSUMER_ACCEPTANCE_WINDOW_MINUTES}min consumer window`,
      ).toBeLessThanOrEqual(CONSUMER_ACCEPTANCE_WINDOW_MINUTES);
    }
  });

  it("captures V9 supply attribution before its dedicated publication trigger", () => {
    expect(CRON_SCHEDULES.v9SupplyAttributionOffset).toBe(
      "8,23,38,53 * * * *",
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

  it("runs yield after each dedicated V9 publication slot", () => {
    const minutesOf = (schedule: string): number[] =>
      schedule.split(" ")[0]!.split(",").map(Number);

    expect(CRON_SCHEDULES.v9PublicationOffset).toBe("22,52 * * * *");
    expect(CRON_SCHEDULES.hourlyYieldSync).toBe("28,58 * * * *");

    const yieldMinutes = minutesOf(CRON_SCHEDULES.hourlyYieldSync);
    const v9Minutes = minutesOf(CRON_SCHEDULES.v9PublicationOffset);

    expect(yieldMinutes).toEqual(v9Minutes.map((minute) => minute + 6));
  });
});
