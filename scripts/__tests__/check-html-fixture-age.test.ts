import { describe, expect, it } from "vitest";

import {
  HTML_FIXTURE_MAX_AGE_DAYS,
  evaluateHtmlFixtureAges,
  runHtmlFixtureAgeCheck,
} from "../ci/check-html-fixture-age.ts";
import { type HtmlFixtureCapture } from "../maintenance/refresh-reserve-html-fixtures.ts";

const NOW = new Date("2026-04-01T12:00:00Z");

function makeCapture(fixture: string, overrides: Partial<HtmlFixtureCapture> = {}): HtmlFixtureCapture {
  return {
    fixture,
    path: `/fixtures/${fixture}`,
    capturedAt: "2026-03-22T12:00:00Z",
    archivedReason: null,
    trimmedReason: null,
    refreshed: true,
    ...overrides,
  };
}

function inspectOne(capture: HtmlFixtureCapture, now: Date = NOW) {
  return evaluateHtmlFixtureAges({ captures: [capture], now, targets: [] }).findings[0];
}

describe("check-html-fixture-age", () => {
  it("reports every violating fixture and keeps a passing corpus quiet", () => {
    const stderr: string[] = [];
    const stdout: string[] = [];
    const writers = {
      stdout: { write: (chunk: string) => stdout.push(chunk) },
      stderr: { write: (chunk: string) => stderr.push(chunk) },
    };

    const failing = runHtmlFixtureAgeCheck({
      captures: [
        makeCapture("stale.html", { capturedAt: "2025-01-01T00:00:00Z" }),
        makeCapture("future.html", { capturedAt: "2027-01-01T00:00:00Z" }),
        makeCapture("ok.html"),
      ],
      now: NOW,
      targets: [],
      ...writers,
    });

    expect(failing).toBe(1);
    expect(stderr.join("")).toContain("stale.html");
    expect(stderr.join("")).toContain("future.html");
    expect(stderr.join("")).not.toContain("ok.html");
    expect(stderr.join("")).toContain("npm run refresh:html-fixtures");

    stdout.length = 0;
    stderr.length = 0;
    const passing = runHtmlFixtureAgeCheck({
      captures: [makeCapture("ok.html")],
      now: NOW,
      targets: [],
      ...writers,
    });

    expect(passing).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("")).toContain("1 file");
  });

  it.each([
    ["2026-03-22T12:00:00Z", "fresh", 10],
    // 2026-01-01 is exactly the bound: the gate expires captures older than it.
    ["2026-01-01T12:00:00Z", "fresh", HTML_FIXTURE_MAX_AGE_DAYS],
    ["2025-12-31T12:00:00Z", "stale", HTML_FIXTURE_MAX_AGE_DAYS + 1],
  ])("treats a %s capture as %s at %i days", (capturedAt, verdict, ageDays) => {
    const finding = inspectOne(makeCapture("live.html", { capturedAt }));

    expect(finding.verdict).toBe(verdict);
    expect(finding.ageDays).toBe(ageDays);
    expect(finding.violation === null).toBe(verdict === "fresh");
  });

  it("rejects a capture that postdates the run, even by one second", () => {
    const finding = inspectOne(makeCapture("live.html", { capturedAt: "2026-04-01T12:00:01Z" }));

    expect(finding.verdict).toBe("future");
    expect(finding.violation).toContain("captured-at 2026-04-01T12:00:01Z is after now");
  });

  // `Date.parse` accepts these, so a bare date would otherwise be aged from a
  // guessed midnight and a locale string from the runner's timezone.
  it("validates capture metadata without a calendar-dependent verdict", () => {
    const captures = [
      makeCapture("old.json", { capturedAt: "2020-01-01T00:00:00Z" }),
      makeCapture("later.html", { capturedAt: "2030-01-01T00:00:00Z" }),
    ];
    const evaluate = (now: Date) => evaluateHtmlFixtureAges({ captures, now, targets: [], metadataOnly: true });
    expect(evaluate(NOW).violations).toEqual([]);
    expect(evaluate(new Date("2040-01-01T00:00:00Z"))).toEqual(evaluate(NOW));
    expect(evaluate(NOW).findings.every((finding) => finding.verdict === "valid-metadata")).toBe(true);
  });

  it.each(["2026-02-30T00:00:00Z", "2026-03-22T12:00:00.123Z", null])(
    "rejects invalid capture metadata %s in the stable mode",
    (capturedAt) => {
      expect(evaluateHtmlFixtureAges({
        captures: [makeCapture("invalid.json", { capturedAt })],
        now: NOW,
        targets: [],
        metadataOnly: true,
      }).failed).toBe(true);
    },
  );

  it("fails a refresh target that no longer ages: deleted, archived, or hand-trimmed", () => {
    const target = { name: "Live source", url: "https://issuer.example/reserves", fixture: "live.html", path: "/x/live.html" };
    const evaluate = (captures: Parameters<typeof evaluateHtmlFixtureAges>[0]["captures"]) =>
      evaluateHtmlFixtureAges({ captures, now: NOW, targets: [target] }).violations;

    // A directory scan alone reports one fewer file and passes.
    expect(evaluate([])).toEqual(["live.html: listed for refresh but missing from the fixtures directory"]);
    expect(evaluate([makeCapture("live.html", { archivedReason: "frozen upstream" })])).toEqual([
      "live.html: archived but still listed for refresh, which would overwrite the frozen capture",
    ]);
    expect(evaluate([makeCapture("live.html", { trimmedReason: "hand-trimmed accordion" })])).toEqual([
      "live.html: manually trimmed but still listed for refresh, which would overwrite the trim",
    ]);
    expect(evaluate([makeCapture("live.html")])).toEqual([]);
  });
});
