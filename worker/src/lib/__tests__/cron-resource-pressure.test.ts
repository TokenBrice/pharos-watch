import { describe, expect, it } from "vitest";
import { buildResourcePressure, selectLatestResourcePressure } from "../cron-resource-pressure";

describe("buildResourcePressure", () => {
  it("distinguishes unavailable measurements from measured zero and never claims heap", () => {
    expect(buildResourcePressure({ observedAt: 100 })).toMatchObject({
      intakeBytes: null, cacheBytes: null, rejectedBodies: null,
      bodyCapBytes: null, inputCapBytes: null, catalogMaxAssets: null,
      inputBytes: null, catalogAssets: null, guard: "not-measured",
      heapUsedBytes: null, heapUnavailableReason: "workers-runtime-no-heap-api",
      platformOutcome: null, platformOutcomeSource: null,
    });
    expect(buildResourcePressure({ intakeBytes: 0 })).toMatchObject({ intakeBytes: 0, intakeBasis: "actual-stream", guard: "within-policy" });
  });

  it("orders rejection above bypass above within-policy", () => {
    expect(buildResourcePressure({ intakeBytes: 5, cacheBypassed: true }).guard).toBe("cache-bypassed");
    expect(buildResourcePressure({ rejectedBodies: 1, cacheBypassed: true }).guard).toBe("resource-budget-exceeded");
    expect(buildResourcePressure({ guard: "resource-budget-exceeded", cacheBypassed: true }).guard).toBe("resource-budget-exceeded");
  });

  it("bounds phase text and rejects invalid counts or unsupported platform claims", () => {
    expect(buildResourcePressure({ phase: "x".repeat(100) }).phase).toHaveLength(80);
    expect(() => buildResourcePressure({ intakeBytes: -1 })).toThrow();
    expect(() => buildResourcePressure({ observedAt: Infinity })).toThrow();
    expect(() => buildResourcePressure({ platformOutcome: "platform-abandoned" })).toThrow();
  });
});

describe("selectLatestResourcePressure", () => {
  it.each([-1, 0, 1])("selects valid candidates only when equally recent or newer (%s)", (offset) => {
    const current = buildResourcePressure({ phase: "decode", observedAt: 100 });
    const candidate = buildResourcePressure({ phase: "publish", observedAt: 100 + offset });
    expect(selectLatestResourcePressure(current, candidate)).toEqual(offset < 0 ? current : candidate);
    expect(selectLatestResourcePressure(null, candidate)).toEqual(candidate);
  });

  it("retains current evidence or absence when a candidate fails the schema", () => {
    const current = buildResourcePressure({ observedAt: 100 });
    for (const candidate of [undefined, null, {}, { ...current, observedAt: -1 }]) {
      expect(selectLatestResourcePressure(current, candidate)).toBe(current);
      expect(selectLatestResourcePressure(null, candidate)).toBeNull();
    }
  });
});
