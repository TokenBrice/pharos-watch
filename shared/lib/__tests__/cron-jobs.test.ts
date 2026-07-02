import { describe, expect, it } from "vitest";
import { getCronSlotStartedAtForSchedule } from "../cron-jobs";

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
});
