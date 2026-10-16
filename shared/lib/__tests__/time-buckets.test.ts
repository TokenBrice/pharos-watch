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

  it("rejects non-finite timestamps", () => {
    expect(() => bucketUnixSecondsToUtcDay(Number.NaN)).toThrow(TypeError);
    expect(() => bucketUnixMillisecondsToUtcDay(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => startOfUtcDaySec(new Date(Number.NaN))).toThrow(TypeError);
  });
});
