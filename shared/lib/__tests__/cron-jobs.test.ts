import { describe, expect, it } from "vitest";
import {
  CRON_JOB_DEFINITIONS,
  CRON_GROWTH_HEADROOM_POLICY,
  CRON_SCHEDULES,
  CRON_TRIGGER_SCHEDULES,
  SAFETY_SCORE_V9_PUBLICATION_REFRESH_INTERVAL_SEC,
  SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_REFRESH_INTERVAL_SEC,
  getCronSlotStartedAtForSchedule,
} from "../cron-jobs";

describe("cron job schedule metadata", () => {
  it("keeps the DEX source lane hourly while preserving the half-hourly consumer aliases", () => {
    expect(CRON_SCHEDULES.halfHourlyOffset).toBe("10 * * * *");
    expect(CRON_TRIGGER_SCHEDULES.halfHourlyOffset).toEqual(["10 * * * *"]);
    expect(CRON_SCHEDULES.halfHourlyChartsOffset).toBe("16,46 * * * *");
    expect(CRON_TRIGGER_SCHEDULES.halfHourlyChartsOffset).toEqual([
      "16 * * * *",
      "46 * * * *",
    ]);
  });

  it("declares the bounded nested Curve discovery fan-out", () => {
    expect(CRON_JOB_DEFINITIONS.find((definition) => definition.job === "sync-dex-discovery")).toMatchObject({
      maxConnections: 2,
    });
  });

  // Cloudflare caps Cron expressions with an interval below one hour at 30
  // seconds of CPU time, and 15 minutes at hourly or longer. These four lanes
  // carry CPU-heavy legs (full DefiLlama parse plus price enrichment, the V9
  // capture/DDR pair, the one-shot V9 publication compiler, and a ~600KB status
  // document serialization), so each is deployed as single-minute hourly
  // expressions to earn the hourly class. A regression back to one comma
  // expression silently re-enters the 30-second class and gets the isolate
  // killed mid-chain, which starves the chain tail.
  it("keeps CPU-heavy sub-hourly lanes on hourly physical triggers", () => {
    const hourlyCpuClassLanes = {
      quarterHourly: ["0 * * * *", "15 * * * *", "30 * * * *", "45 * * * *"],
      v9SupplyAttributionOffset: ["8 * * * *", "23 * * * *", "38 * * * *", "53 * * * *"],
      v9PublicationOffset: ["22 * * * *", "52 * * * *"],
      statusSelfCheckOffset: ["9 * * * *", "24 * * * *", "39 * * * *", "54 * * * *"],
    } as const;

    for (const [scheduleKey, triggerSchedules] of Object.entries(hourlyCpuClassLanes)) {
      const key = scheduleKey as keyof typeof hourlyCpuClassLanes;
      expect(CRON_TRIGGER_SCHEDULES[key], scheduleKey).toEqual(triggerSchedules);

      for (const triggerSchedule of triggerSchedules) {
        const [minute, hour] = triggerSchedule.split(" ");
        expect(
          minute.includes(",") || minute.includes("/") || minute === "*",
          `${scheduleKey} trigger "${triggerSchedule}" must fire on exactly one minute so the interval stays hourly`,
        ).toBe(false);
        expect(hour, `${scheduleKey} trigger "${triggerSchedule}" must run every hour`).toBe("*");
      }
    }

    // The logical cadence, and therefore slot identity and status freshness,
    // must not move when the physical topology changes.
    expect(CRON_SCHEDULES.quarterHourly).toBe("*/15 * * * *");
    expect(CRON_SCHEDULES.v9SupplyAttributionOffset).toBe("8,23,38,53 * * * *");
    expect(CRON_SCHEDULES.v9PublicationOffset).toBe("22,52 * * * *");
    expect(CRON_SCHEDULES.statusSelfCheckOffset).toBe("9,24,39,54 * * * *");

    // Every physical alias must normalize to the logical slot it fired in.
    expect(getCronSlotStartedAtForSchedule("quarterHourly", Date.parse("2026-08-21T19:45:03Z"))).toBe(
      Math.floor(Date.parse("2026-08-21T19:45:00Z") / 1000),
    );
    expect(
      getCronSlotStartedAtForSchedule("v9SupplyAttributionOffset", Date.parse("2026-08-21T19:53:04Z")),
    ).toBe(Math.floor(Date.parse("2026-08-21T19:53:00Z") / 1000));
    expect(
      getCronSlotStartedAtForSchedule("v9PublicationOffset", Date.parse("2026-08-21T19:52:04Z")),
    ).toBe(Math.floor(Date.parse("2026-08-21T19:52:00Z") / 1000));
    expect(
      getCronSlotStartedAtForSchedule("statusSelfCheckOffset", Date.parse("2026-08-21T19:24:07Z")),
    ).toBe(Math.floor(Date.parse("2026-08-21T19:24:00Z") / 1000));

    const physicalTriggers = Object.values(CRON_TRIGGER_SCHEDULES).flat();
    expect(physicalTriggers).toHaveLength(34);
    expect(CRON_GROWTH_HEADROOM_POLICY.maxPhysicalTriggersBeforeRebalance).toBe(34);
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

  it("keeps every physical yield trigger in the hourly Cron CPU class", () => {
    // Cloudflare caps Cron expressions with intervals below one hour at 30s of
    // CPU time. sync-yield-data needs ~150-175s of runtime, so a twice-hourly
    // expression gets the invocation killed mid `source-resolution` (production
    // outage 2026-08-18, 11:20-15:00 UTC). Each physical trigger must therefore
    // carry a single minute value, either directly or via the paired-trigger
    // form used by halfHourlyChartsOffset.
    const minutesOf = (schedule: string): number[] =>
      schedule.split(" ")[0]!.split(",").map(Number);

    for (const trigger of CRON_TRIGGER_SCHEDULES.hourlyYieldSync) {
      expect(minutesOf(trigger)).toHaveLength(1);
    }
  });
});
