import { describe, expect, it } from "vitest";
import { parseEpoch } from "../epoch";

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
