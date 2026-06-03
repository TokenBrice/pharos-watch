import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateReserveFixtureFreshness,
  parseCapturedAtHeader,
  renderReserveFixtureFreshnessResult,
} from "../ci/check-reserve-fixture-freshness.mjs";

describe("check-reserve-fixture-freshness", () => {
  it("parses captured-at fixture headers", () => {
    const parsed = parseCapturedAtHeader("<!-- captured-at: 2026-04-16T21:31:55Z -->\n<html />");

    expect(parsed).toMatchObject({
      iso: "2026-04-16T21:31:55Z",
    });
    expect(parsed?.date.toISOString()).toBe("2026-04-16T21:31:55.000Z");
    expect(parseCapturedAtHeader("<html />")).toBeNull();
  });

  it("classifies fresh, stale, and missing fixture headers", () => {
    const dir = join(tmpdir(), `pharos-reserve-fixtures-${Date.now()}-${Math.random()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "fresh.html"), "<!-- captured-at: 2026-04-01T00:00:00Z -->\n<html />");
    writeFileSync(join(dir, "stale.html"), "<!-- captured-at: 2026-01-01T00:00:00Z -->\n<html />");
    writeFileSync(join(dir, "missing.html"), "<html />");
    writeFileSync(join(dir, "ignored.json"), "{}");

    const result = evaluateReserveFixtureFreshness({
      fixturesDir: dir,
      now: new Date("2026-04-15T00:00:00Z"),
      maxAgeDays: 90,
    });

    expect(result.files).toEqual(["fresh.html", "missing.html", "stale.html"]);
    expect(result.ok).toEqual([{ file: "fresh.html", ageDays: 14 }]);
    expect(result.missing).toEqual(["missing.html"]);
    expect(result.stale).toEqual([
      { file: "stale.html", ageDays: 104, capturedAt: "2026-01-01T00:00:00Z" },
    ]);
    expect(renderReserveFixtureFreshnessResult(result)).toContain("FAILED");
  });
});
