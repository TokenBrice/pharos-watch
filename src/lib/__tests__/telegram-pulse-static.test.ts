import { describe, expect, it } from "vitest";
import { TELEGRAM_PULSE_STATIC } from "../telegram-pulse-static";

describe("TELEGRAM_PULSE_STATIC", () => {
  it("holds either real baked figures or an explicit quiet state", () => {
    expect(
      TELEGRAM_PULSE_STATIC.activeWatchers === null ||
        (Number.isInteger(TELEGRAM_PULSE_STATIC.activeWatchers) && TELEGRAM_PULSE_STATIC.activeWatchers >= 0),
    ).toBe(true);
    if (TELEGRAM_PULSE_STATIC.activeWatchers === null) {
      // A quiet snapshot must not claim a capture date.
      expect(TELEGRAM_PULSE_STATIC.asOf).toBeNull();
    } else {
      expect(TELEGRAM_PULSE_STATIC.asOf).toMatch(/^\d{4}-\d{2}-\d{2}/);
    }
  });
});
