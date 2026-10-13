import { describe, expect, it } from "vitest";
import type { PublicStatusComponent, PublicStatusTransition } from "@shared/types";
import { PUBLIC_STATUS_COMPONENT_IDS } from "@shared/types/status";
import {
  buildComponentDayCells,
  foldLegacyIncidents,
  foldPublicIncidents,
  getHeadlineSince,
} from "@/lib/status/public-status-timeline";

const DAY = 86_400;
// 2026-10-13T12:00:00Z
const NOW = Date.parse("2026-10-13T12:00:00Z") / 1000;
const TODAY = Math.floor(NOW / DAY) * DAY;

function row(id: number, at: number, components: PublicStatusTransition["components"], extra: Partial<PublicStatusTransition> = {}): PublicStatusTransition {
  const operational = (components ?? []).length === 0;
  return {
    id, at, source: "public", from: "healthy", to: operational ? "healthy" : "degraded",
    transitionType: operational ? "recover" : "degrade", reason: "public-projection-changed", components, ...extra,
  };
}

function live(overrides: Partial<Record<string, PublicStatusComponent["state"]>> = {}) {
  return PUBLIC_STATUS_COMPONENT_IDS.map((id) => ({ id, state: overrides[id] ?? "operational" as const }));
}

describe("buildComponentDayCells", () => {
  it("renders days before public history started as no data, never operational", () => {
    const cells = buildComponentDayCells({
      transitions: [row(1, TODAY - DAY + 3600, [], { transitionType: "init", from: null })],
      liveComponents: live(),
      publicHistoryStartedAt: TODAY - DAY + 3600,
      nowSec: NOW,
      days: 4,
    });
    expect(cells.yield.map((cell) => cell.state)).toEqual(["no-data", "no-data", "operational", "operational"]);
    expect(cells.yield.at(-1)!.date).toBe("2026-10-13");
  });

  it("marks a day with the worst state the component held and leaves others operational", () => {
    const cells = buildComponentDayCells({
      transitions: [
        row(3, TODAY - DAY + 7200, []),
        row(2, TODAY - DAY + 3600, [{ id: "yield", state: "degraded", reasons: ["cache-stale:yield-data"] }]),
      ],
      liveComponents: live(),
      publicHistoryStartedAt: TODAY - 10 * DAY,
      nowSec: NOW,
      days: 3,
    });
    // First row left "healthy", so the earlier stretch is known operational.
    expect(cells.yield.map((cell) => cell.state)).toEqual(["operational", "degraded", "operational"]);
    expect(cells["mint-burn"].map((cell) => cell.state)).toEqual(["operational", "operational", "operational"]);
  });

  it("does not invent the state before the oldest loaded row when it left a non-operational state", () => {
    const cells = buildComponentDayCells({
      transitions: [row(5, TODAY - DAY, [], { from: "degraded" })],
      liveComponents: live(),
      publicHistoryStartedAt: TODAY - 40 * DAY,
      nowSec: NOW,
      days: 3,
    });
    expect(cells.charts.map((cell) => cell.state)).toEqual(["no-data", "operational", "operational"]);
  });

  it("leaves days before the oldest loaded row unknown when the page was truncated", () => {
    const cells = buildComponentDayCells({
      transitions: [
        row(3, TODAY - DAY + 7200, []),
        row(2, TODAY - DAY + 3600, [{ id: "yield", state: "degraded", reasons: ["cache:yield-data:stale"] }]),
      ],
      liveComponents: live(),
      publicHistoryStartedAt: TODAY - 10 * DAY,
      nowSec: NOW,
      days: 3,
      truncated: true,
    });
    expect(cells.yield.map((cell) => cell.state)).toEqual(["no-data", "degraded", "operational"]);
  });

  it("overlays today with the live projection", () => {
    const cells = buildComponentDayCells({
      transitions: [],
      liveComponents: live({ "mint-burn": "delayed" }),
      publicHistoryStartedAt: null,
      nowSec: NOW,
      days: 2,
    });
    expect(cells["mint-burn"].map((cell) => cell.state)).toEqual(["no-data", "delayed"]);
    expect(cells.yield.map((cell) => cell.state)).toEqual(["no-data", "operational"]);
  });
});

describe("foldPublicIncidents", () => {
  it("folds degrade, escalation and recovery rows into one incident with affected components", () => {
    const incidents = foldPublicIncidents([
      row(3, NOW - 600, []),
      row(2, NOW - 1800, [
        { id: "yield", state: "outage", reasons: ["cache-stale:yield-data:outage"] },
        { id: "mint-burn", state: "delayed", reasons: ["mint-burn-sync-age:delayed"] },
      ]),
      row(1, NOW - 3600, [{ id: "yield", state: "degraded", reasons: ["cache-stale:yield-data"] }]),
    ]);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      startedAt: NOW - 3600,
      startKnown: true,
      resolvedAt: NOW - 600,
      worstState: "outage",
      components: [{ id: "yield", worstState: "outage" }, { id: "mint-burn", worstState: "delayed" }],
    });
    expect(incidents[0].reasons).toContain("public-projection-changed");
  });

  it("keeps an unresolved incident ongoing and flags a start before the loaded window", () => {
    const incidents = foldPublicIncidents([
      row(1, NOW - 3600, [{ id: "charts", state: "delayed", reasons: [] }], { from: "degraded" }),
    ]);
    expect(incidents[0]).toMatchObject({ resolvedAt: null, startKnown: false, worstState: "delayed" });
  });

  it("ignores legacy rows and lists incidents newest first", () => {
    const incidents = foldPublicIncidents([
      row(4, NOW - 100, []),
      row(3, NOW - 200, [{ id: "yield", state: "degraded", reasons: [] }]),
      row(2, NOW - 900, []),
      row(1, NOW - 1000, [{ id: "charts", state: "degraded", reasons: [] }]),
      { id: 9, at: NOW - 5000, source: "legacy", from: "healthy", to: "stale", transitionType: "degrade", reason: "raw-stale" },
    ]);
    expect(incidents.map((incident) => incident.id)).toEqual([3, 1]);
  });
});

describe("foldLegacyIncidents", () => {
  it("folds operator rows by overall state and keeps the worst level", () => {
    const incidents = foldLegacyIncidents([
      { id: 3, at: 300, source: "legacy", from: "stale", to: "healthy", transitionType: "recover", reason: "recovered" },
      { id: 2, at: 200, source: "legacy", from: "degraded", to: "stale", transitionType: "degrade", reason: "raw-stale" },
      { id: 1, at: 100, source: "legacy", from: "healthy", to: "degraded", transitionType: "degrade", reason: "raw-degraded-consecutive-threshold" },
    ]);
    expect(incidents).toEqual([{
      id: 1, startedAt: 100, startKnown: true, resolvedAt: 300, worstStatus: "stale",
      reasons: ["raw-degraded-consecutive-threshold", "raw-stale"],
    }]);
  });

  it("closes an operator incident still open at the cutover instead of leaving it ongoing", () => {
    const [incident] = foldLegacyIncidents(
      [{ id: 1, at: 100, source: "legacy", from: "healthy", to: "degraded", transitionType: "degrade", reason: "raw-degraded-consecutive-threshold" }],
      500,
    );
    expect(incident).toMatchObject({ resolvedAt: 500, handedOff: true });
  });

  it("treats rows without a source (pre-projection payloads) as operator rows, never as no incidents", () => {
    const incidents = foldLegacyIncidents([
      { id: 2, at: 200, from: "degraded", to: "healthy", transitionType: "recover", reason: "raw-healthy-recovery-threshold" },
      { id: 1, at: 100, from: "healthy", to: "degraded", transitionType: "degrade", reason: "raw-degraded-consecutive-threshold" },
    ]);
    expect(incidents).toHaveLength(1);
  });
});

describe("getHeadlineSince", () => {
  it("uses the earliest affected since, or the latest recovery when all are operational", () => {
    expect(getHeadlineSince([
      { state: "degraded", since: 500 }, { state: "delayed", since: 300 }, { state: "operational", since: 100 },
    ])).toBe(300);
    expect(getHeadlineSince([{ state: "operational", since: 100 }, { state: "operational", since: 400 }])).toBe(400);
    expect(getHeadlineSince([{ state: "operational", since: 100 }, { state: "operational", since: null }])).toBeNull();
  });
});
