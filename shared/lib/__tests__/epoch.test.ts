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

  it("parses ISO text and rejects empty or invalid text", () => {
    expect(parseEpoch("2025-01-01T00:00:00Z", workerOptions)).toEqual({ kind: "seconds", seconds: 1_735_689_600 });
    expect(parseEpoch("", frontendOptions)).toEqual({ kind: "invalid" });
    expect(parseEpoch("not-a-time", frontendOptions)).toEqual({ kind: "invalid" });
  });
});

describe("parseEpochSeconds", () => {
  const positiveFlooredOptions = {
    numericTextPolicy: "any" as const,
    millisecondsThreshold: 10_000_000_000,
    millisecondsThresholdInclusive: false,
    floor: true,
    minExclusive: 0,
  };

  it("preserves the exclusive 10^10 adapter threshold and floors both units", () => {
    expect(parseEpochSeconds(9_999_999_999.9, positiveFlooredOptions)).toBe(9_999_999_999);
    expect(parseEpochSeconds(10_000_000_000, positiveFlooredOptions)).toBe(10_000_000_000);
    expect(parseEpochSeconds(10_000_000_001, positiveFlooredOptions)).toBe(10_000_000);
  });

  it("preserves the inclusive 10^12 freshness threshold", () => {
    const freshnessOptions = {
      ...positiveFlooredOptions,
      numericTextPolicy: "digits-only" as const,
      millisecondsThreshold: 1_000_000_000_000,
      millisecondsThresholdInclusive: true,
    };
    expect(parseEpochSeconds(999_999_999_999, freshnessOptions)).toBe(999_999_999_999);
    expect(parseEpochSeconds(1_000_000_000_000, freshnessOptions)).toBe(1_000_000_000);
  });

  it("makes numeric text, ISO, positivity, and flooring policies explicit", () => {
    expect(parseEpochSeconds("1700000000.9", positiveFlooredOptions)).toBe(1_700_000_000);
    expect(parseEpochSeconds(-1, positiveFlooredOptions)).toBeNull();
    expect(parseEpochSeconds("2025-01-01T00:00:00.999Z", positiveFlooredOptions)).toBe(1_735_689_600);
    expect(parseEpochSeconds("1700000000.9", {
      ...positiveFlooredOptions,
      numericTextPolicy: "digits-only",
    })).toBeNull();
  });

  it("can preserve adapter-specific minimum and numeric-text fallback behavior", () => {
    expect(parseEpochSeconds("0", {
      ...positiveFlooredOptions,
      isoMinExclusive: null,
      numericTextMinRejectionPolicy: "iso-fallback",
    })).toBe(Math.floor(Date.parse("0") / 1000));
    expect(parseEpochSeconds("1960-01-01T00:00:00Z", {
      ...positiveFlooredOptions,
      isoMinExclusive: null,
    })).toBe(-315_619_200);
  });

  it("applies the minimum after milliseconds conversion and flooring", () => {
    const etherfuseOptions = {
      ...positiveFlooredOptions,
      minExclusive: 946_684_800,
    };
    expect(parseEpochSeconds(946_684_800_999, etherfuseOptions)).toBeNull();
    expect(parseEpochSeconds(946_684_801_000, etherfuseOptions)).toBe(946_684_801);
  });
});
