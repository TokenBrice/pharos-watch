import { describe, expect, it } from "vitest";

import {
  bucketUnixMillisecondsToUtcDay,
  bucketUnixSecondsToUtcDay,
  startOfUtcDaySec,
} from "../time-buckets";

describe("UTC-day bucketing", () => {
  it("keeps seconds and milliseconds explicit and unit-preserving", () => {
    expect(bucketUnixSecondsToUtcDay(86_401)).toBe(86_400);
    expect(bucketUnixMillisecondsToUtcDay(86_401_000)).toBe(86_400_000);
    expect(startOfUtcDaySec(new Date(86_401_000))).toBe(86_400);
  });

  it("uses mathematical floor for timestamps before the epoch", () => {
    expect(bucketUnixSecondsToUtcDay(-1)).toBe(-86_400);
    expect(bucketUnixMillisecondsToUtcDay(-1)).toBe(-86_400_000);
    expect(startOfUtcDaySec(new Date(-1))).toBe(-86_400);
  });

  it("buckets future timestamps at exact UTC midnight", () => {
    const futureMs = Date.parse("2126-08-16T23:59:59.999Z");
    const expectedMs = Date.parse("2126-08-16T00:00:00.000Z");
    expect(bucketUnixMillisecondsToUtcDay(futureMs)).toBe(expectedMs);
    expect(bucketUnixSecondsToUtcDay(futureMs / 1000)).toBe(expectedMs / 1000);
  });

  it("rejects non-finite timestamps", () => {
    expect(() => bucketUnixSecondsToUtcDay(Number.NaN)).toThrow(TypeError);
    expect(() => bucketUnixMillisecondsToUtcDay(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => startOfUtcDaySec(new Date(Number.NaN))).toThrow(TypeError);
  });
});
