import { describe, expect, it } from "vitest";
import { makeTapeEvent } from "@shared/test-utils/tape-event";
import { projectTapeEventForReader, projectTapeEventsForReader, formatTapeEventSummary, formatTapeEventTitle } from "../tape-derive";

function yieldWarning(newSignals: unknown, overrides = {}) {
  const label = Array.isArray(newSignals) ? newSignals.join(", ") : "";
  return makeTapeEvent({
    id: "evt-yield",
    type: "yield.warning_emitted",
    coinId: "usde-ethena",
    title: `USDe yield warning: ${label}`,
    summary: `New yield warning signal${Array.isArray(newSignals) && newSignals.length > 1 ? "s" : ""} (${label}) detected on selected source.`,
    payload: { signals: newSignals, prevSignals: [], newSignals, sourceKey: "ethena" },
    ...overrides,
  });
}

describe("projectTapeEventForReader", () => {
  it.each(["aging", "data-stale", "data-freshness-unknown", "reference-benchmark-degraded", "benchmark-degraded", "benchmark-stale"])(
    "omits an operational-only event (%s)", (signal) => {
      expect(projectTapeEventForReader(yieldWarning([signal]))).toBeNull();
    });

  it("rebuilds a mixed event from its investment signals and preserves identity", () => {
    const raw = yieldWarning(["yield-spike", "aging"]);
    const projected = projectTapeEventForReader(raw)!;
    expect(projected.id).toBe(raw.id);
    expect(projected.ts).toBe(raw.ts);
    expect(projected.payload.newSignals).toEqual(["yield-spike"]);
    expect(projected.payload.signals).toEqual(["yield-spike"]);
    expect(projected.title).toBe("USDe yield warning: yield-spike");
    expect(projected.summary).toBe("New yield warning signal (yield-spike) detected on selected source.");
    expect(formatTapeEventTitle(projected)).toBe("USDe yield warning: Yield spike");
    expect(formatTapeEventSummary(projected)).not.toMatch(/aging|Aging/);
    // The raw event is not mutated.
    expect(raw.payload.newSignals).toEqual(["yield-spike", "aging"]);
  });

  it("returns the same object when nothing is operational", () => {
    const raw = yieldWarning(["yield-spike", "safety-unrated"]);
    expect(projectTapeEventForReader(raw)).toBe(raw);
  });

  it.each([undefined, null, [], [1, "aging"], "aging"])("shows neutral detail for malformed signals %j", (bad) => {
    const projected = projectTapeEventForReader(yieldWarning(bad, { title: "USDe yield warning: aging", summary: "New yield warning signal (aging) detected." }))!;
    expect(projected.summary).toBe("Signal details unavailable.");
    expect(`${projected.title} ${projected.summary}`).not.toMatch(/aging/);
  });

  it("passes other event types through and filters lists in order", () => {
    const depeg = makeTapeEvent({ id: "d" });
    const out = projectTapeEventsForReader([depeg, yieldWarning(["aging"]), yieldWarning(["yield-spike"], { id: "y2" })]);
    expect(out.map((e) => e.id)).toEqual(["d", "y2"]);
  });
});
