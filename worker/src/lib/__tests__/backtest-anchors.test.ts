import { describe, expect, it } from "vitest";
import { BACKTEST_ANCHORS, BACKTEST_NEGATIVE_CONTROLS } from "../backtest-anchors";

describe("BACKTEST_ANCHORS fixture", () => {
  it("has at least 3 anchors and is frozen", () => {
    expect(BACKTEST_ANCHORS.length).toBeGreaterThanOrEqual(3);
    expect(Object.isFrozen(BACKTEST_ANCHORS)).toBe(true);
  });
  it("every onset is before resolved (when resolved is non-null)", () => {
    for (const a of BACKTEST_ANCHORS) {
      if (a.resolvedAt !== null) expect(a.resolvedAt).toBeGreaterThan(a.onsetAt);
    }
  });
  it("peakAbsBps is positive and finite", () => {
    for (const a of BACKTEST_ANCHORS) {
      expect(Number.isFinite(a.peakAbsBps)).toBe(true);
      expect(a.peakAbsBps).toBeGreaterThan(0);
    }
  });
  it("stablecoinId is kebab-case and non-empty", () => {
    for (const a of BACKTEST_ANCHORS) {
      expect(a.stablecoinId).toMatch(/^[a-z0-9-]+$/);
    }
  });
  it("rejects placeholder verification metadata", () => {
    for (const fixture of [...BACKTEST_ANCHORS, ...BACKTEST_NEGATIVE_CONTROLS]) {
      expect(fixture.verificationNote.toLowerCase()).not.toContain("todo");
      expect(fixture.verificationNote.toLowerCase()).not.toContain("placeholder");
      expect(fixture.sourceUrls.length).toBeGreaterThan(0);
      for (const url of fixture.sourceUrls) {
        expect(url).toMatch(/^https:\/\//);
        expect(url.toLowerCase()).not.toContain("example.com");
      }
    }
  });
  it("anchors carry live Pharos verification provenance", () => {
    for (const anchor of BACKTEST_ANCHORS) {
      expect(anchor.verificationNote).toMatch(/^Verified against live Pharos \/api\/depeg-events row on \d{4}-\d{2}-\d{2}\.$/);
      expect(anchor.sourceUrls.some((url) => url.includes("/api/depeg-events?stablecoin="))).toBe(true);
    }
  });
  it("negative controls are frozen even when no verified calm windows are available", () => {
    expect(Object.isFrozen(BACKTEST_NEGATIVE_CONTROLS)).toBe(true);
  });
});
