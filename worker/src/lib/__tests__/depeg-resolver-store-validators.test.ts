import { describe, expect, it } from "vitest";
import { DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC } from "@shared/lib/methodology-versions/depeg-resolver";
import { assertHash, assertLockMetadata, assertNonEmpty, assertNonNegativeInteger, assertPositiveInteger } from "../depeg-resolver-store-validators";

describe("DDR store input rejection", () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid positive integer %s before persistence", (value) => {
      expect(() => assertPositiveInteger(value, "eventId")).toThrow("eventId must be a positive safe integer");
    },
  );
  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid non-negative integer %s", (value) => {
    expect(() => assertNonNegativeInteger(value, "deferrals")).toThrow("deferrals must be a non-negative safe integer");
  });
  it("rejects blank identities and non-canonical hashes", () => {
    expect(() => assertNonEmpty(" \n ", "runId")).toThrow("runId must be non-empty");
    for (const hash of ["a".repeat(63), "A".repeat(64), "g".repeat(64)]) {
      expect(() => assertHash(hash, "featureHash")).toThrow("featureHash must be a 64-character lowercase hex hash");
    }
  });
  it.each([-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid readiness score %s", (score) => {
    expect(() => assertLockMetadata({ forecastReadinessScore: score })).toThrow("forecastReadinessScore");
    expect(() => assertLockMetadata({ readinessThreshold: score })).toThrow("readinessThreshold");
  });
  it("rejects incomplete readiness locks rather than persisting optimistic eligibility", () => {
    expect(() => assertLockMetadata({ lockTrigger: "forecast_readiness" })).toThrow("requires forecastReadinessScore");
    expect(() => assertLockMetadata({ lockTrigger: "forecast_readiness", forecastReadinessScore: 0.7 })).toThrow("requires forecastReadinessVersion");
    expect(() => assertLockMetadata({ lockTrigger: "forecast_readiness", forecastReadinessScore: 0.7, forecastReadinessVersion: "v1" })).toThrow("requires readinessThreshold");
  });
  it("requires the complete reviewed backstop window", () => {
    expect(() => assertLockMetadata({ lockTrigger: "readiness_backstop" })).toThrow("requires backstopAt");
    expect(() => assertLockMetadata({ lockTrigger: "readiness_backstop", backstopAt: 123 })).toThrow("requires backstopDelaySec");
    expect(() => assertLockMetadata({ lockTrigger: "readiness_backstop", backstopAt: 123, backstopDelaySec: DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC - 1 })).toThrow("readiness-72h backstop delay");
  });
});
