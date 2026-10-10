import { describe, expect, it } from "vitest";
import { parseEpoch, parseEpochSeconds } from "../epoch";

const frontendOptions = {
  numericTextPolicy: "any" as const,
  millisecondsThreshold: 10_000_000_000,
  millisecondsThresholdInclusive: true,
};

const workerOptions = {
  numericTextPolicy: "digits-only" as const,
  millisecondsThreshold: 1_000_000_000_000,
  millisecondsThresholdInclusive: true,
};

describe("parseEpoch", () => {
  it("keeps the frontend numeric policy and 10^10 boundary", () => {
    expect(parseEpoch(9_999_999_999, frontendOptions)).toEqual({ kind: "seconds", seconds: 9_999_999_999 });
    expect(parseEpoch(10_000_000_000, frontendOptions)).toEqual({ kind: "seconds", seconds: 10_000_000 });
    expect(parseEpoch("-1.5", frontendOptions)).toEqual({ kind: "seconds", seconds: -1.5 });
  });

  it("keeps the worker digit-only policy and 10^12 boundary", () => {
    expect(parseEpoch("10000000000", workerOptions)).toEqual({ kind: "seconds", seconds: 10_000_000_000 });
    expect(parseEpoch("999999999999", workerOptions)).toEqual({ kind: "seconds", seconds: 999_999_999_999 });
    expect(parseEpoch("1000000000000", workerOptions)).toEqual({ kind: "seconds", seconds: 1_000_000_000 });
    expect(parseEpoch("-1700000000", workerOptions)).toEqual({ kind: "invalid" });
    expect(parseEpoch("1700000000.5", workerOptions)).toEqual({ kind: "invalid" });
  });

  it.each(["-1", "+1", "1.5", "2026-02-30", "2025-02-29", "2026-04-31", "01/05/2026"])("rejects malformed epoch or calendar text %s", (value) => {
    expect(parseEpoch(value, workerOptions)).toEqual({ kind: "invalid" });
  });

  it("accepts valid leap dates and ISO offset timestamps", () => {
    expect(parseEpoch("2024-02-29", workerOptions)).toEqual({ kind: "seconds", seconds: Date.parse("2024-02-29") / 1000 });
    expect(parseEpoch("2026-01-01T01:00:00+01:00", workerOptions)).toEqual({ kind: "seconds", seconds: Date.parse("2026-01-01") / 1000 });
  });

  it.each([
    "2026-01-01T01:00", "2026-01-01T01:00Z", "2026-01-01T01:00+01:00",
    "2026-01-01T01:00:00", "2026-01-01T01:00:00.123",
    "2026-01-01T01:00:00.123Z", "2026-01-01T01:00:00.123+01:00",
  ])("preserves optional ISO time components in %s", (value) => {
    expect(parseEpoch(value, workerOptions)).toEqual({ kind: "seconds", seconds: Date.parse(value) / 1000 });
  });

  it.each([
    "2026-01-01T01:00.123Z", "2026-01-01T24:00:00Z", "2026-01-01T01:60:00Z",
    "2026-01-01T01:00:60Z", "2026-01-01T01:00:00+24:00", "2026-01-01T01:00:00+01:60",
    "2026-01-01T01:00:00.Z", "2026-01-01T01:00:00Zsuffix",
  ])("rejects malformed ISO time components in %s", (value) => {
    expect(parseEpoch(value, workerOptions)).toEqual({ kind: "invalid" });
  });

  it("parses ISO text and rejects empty or invalid text", () => {
    expect(parseEpoch("2025-01-01T00:00:00Z", workerOptions)).toEqual({ kind: "seconds", seconds: 1_735_689_600 });
    expect(parseEpoch("", frontendOptions)).toEqual({ kind: "invalid" });
    expect(parseEpoch("not-a-time", frontendOptions)).toEqual({ kind: "invalid" });
  });
});

describe("parseEpochSeconds", () => {
  const options = { numericTextPolicy: "any" as const, millisecondsThreshold: 10_000_000_000, millisecondsThresholdInclusive: false, floor: true, minExclusive: 0 };
  it.each([
    [9_999_999_999.9, options, 9_999_999_999], [10_000_000_000, options, 10_000_000_000], [10_000_000_001, options, 10_000_000], ["1700000000.9", options, 1_700_000_000],
    ["2025-01-01T00:00:00.999Z", options, 1_735_689_600], [-1, options, null], [1_000_000_000_000, { ...options, millisecondsThreshold: 1_000_000_000_000, millisecondsThresholdInclusive: true }, 1_000_000_000],
    [946_684_800_999, { ...options, minExclusive: 946_684_800 }, null],
  ])("normalizes %s with explicit policy", (value, parserOptions, expected) => expect(parseEpochSeconds(value, parserOptions)).toBe(expected));
});
