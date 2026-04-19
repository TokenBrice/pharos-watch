import { describe, expect, it } from "vitest";
import {
  getCronScheduleKey,
  getCronSlotStartedAtForSchedule,
} from "../cron-jobs";

describe("cron job schedule metadata", () => {
  it("maps the DEWS/PSI offset expression and derives 26/56 minute slots", () => {
    expect(getCronScheduleKey("26,56 * * * *")).toBe("dewsPsiOffset");

    const firstSlot = Date.parse("2026-04-19T16:26:30Z");
    const secondSlot = Date.parse("2026-04-19T16:56:05Z");

    expect(getCronSlotStartedAtForSchedule("dewsPsiOffset", firstSlot)).toBe(
      Math.floor(Date.parse("2026-04-19T16:26:00Z") / 1000),
    );
    expect(getCronSlotStartedAtForSchedule("dewsPsiOffset", secondSlot)).toBe(
      Math.floor(Date.parse("2026-04-19T16:56:00Z") / 1000),
    );
  });
});
