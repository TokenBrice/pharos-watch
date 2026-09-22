import { describe, expect, it } from "vitest";
import { parseBoundedDateSec } from "../safety-score-v9/extension-shared";

const CLOCK_SEC = Date.parse("2026-09-21T00:00:00.000Z") / 1_000;

describe("Safety Score v9 bounded review dates", () => {
  it("rejects a malformed assurance review date as invalid", () => {
    expect(() => parseBoundedDateSec("not-a-date", CLOCK_SEC, "assurance")).toThrow(
      "Safety Score v9 assurance has an invalid review date",
    );
  });

  it("rejects an assurance review date later than the scoring clock", () => {
    expect(() => parseBoundedDateSec("2026-09-22", CLOCK_SEC, "assurance")).toThrow(
      "Safety Score v9 assurance review is later than the scoring clock",
    );
  });
});
