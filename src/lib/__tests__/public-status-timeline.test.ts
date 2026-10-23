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
  it("does not invent Safety Score history before its first observation", () => {
    const cells = buildComponentDayCells({
      transitions: [
        row(1, TODAY - 3 * DAY, [], { transitionType: "init", from: null }),
        row(2, TODAY - DAY + 3600, []),
      ],
      liveComponents: live(),
      liveObservedAt: NOW,
      publicHistoryStartedAt: TODAY - 3 * DAY,
      componentHistoryStartedAt: Object.fromEntries(PUBLIC_STATUS_COMPONENT_IDS.map((id) => [
        id, id === "safety-scores" ? TODAY - DAY + 3600 : TODAY - 3 * DAY,
      ])),
      nowSec: NOW,
      days: 4,
    });
    expect(cells["safety-scores"].map((cell) => cell.state)).toEqual(["no-data", "no-data", "operational", "operational"]);
    expect(cells["risk-signals"].map((cell) => cell.state)).toEqual(["operational", "operational", "operational", "operational"]);
  });

  it("shows no past history when a component has no admitted monitoring start", () => {
    const cells = buildComponentDayCells({
      transitions: [row(1, TODAY - DAY, [])], liveComponents: live(),
      liveObservedAt: NOW,
      publicHistoryStartedAt: TODAY - 3 * DAY, componentHistoryStartedAt: {},
      nowSec: NOW, days: 2,
    });
    expect(cells["safety-scores"].map((cell) => cell.state)).toEqual(["no-data", "operational"]);
  });

  it("renders days before public history started as no data, never operational", () => {
    const cells = buildComponentDayCells({
      transitions: [row(1, TODAY - DAY + 3600, [], { transitionType: "init", from: null })],
      liveComponents: live(),
      liveObservedAt: NOW,
      publicHistoryStartedAt: TODAY - DAY + 3600,
      componentHistoryStartedAt: Object.fromEntries(PUBLIC_STATUS_COMPONENT_IDS.map((id) => [id, TODAY - DAY + 3600])),
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
      liveObservedAt: NOW,
      boundary: { at: TODAY - 10 * DAY, components: [] },
      publicHistoryStartedAt: TODAY - 10 * DAY,
      componentHistoryStartedAt: Object.fromEntries(PUBLIC_STATUS_COMPONENT_IDS.map((id) => [id, TODAY - 10 * DAY])),
      nowSec: NOW,
      days: 3,
    });
    // Only the admitted persisted boundary proves the earlier operational stretch.
    expect(cells.yield.map((cell) => cell.state)).toEqual(["operational", "degraded", "operational"]);
    expect(cells["mint-burn"].map((cell) => cell.state)).toEqual(["operational", "operational", "operational"]);
  });

  it("does not invent the state before the oldest loaded row when it left a non-operational state", () => {
    const cells = buildComponentDayCells({
      transitions: [row(5, TODAY - DAY, [], { from: "degraded" })],
      liveComponents: live(),
      liveObservedAt: NOW,
      publicHistoryStartedAt: TODAY - 40 * DAY,
      componentHistoryStartedAt: Object.fromEntries(PUBLIC_STATUS_COMPONENT_IDS.map((id) => [id, TODAY - 40 * DAY])),
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
      liveObservedAt: NOW,
      boundary: { at: TODAY - 10 * DAY, components: [] },
      publicHistoryStartedAt: TODAY - 10 * DAY,
      componentHistoryStartedAt: Object.fromEntries(PUBLIC_STATUS_COMPONENT_IDS.map((id) => [id, TODAY - 10 * DAY])),
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
      liveObservedAt: NOW,
      publicHistoryStartedAt: null,
      nowSec: NOW,
      days: 2,
    });
    expect(cells["mint-burn"].map((cell) => cell.state)).toEqual(["no-data", "delayed"]);
    expect(cells.yield.map((cell) => cell.state)).toEqual(["no-data", "operational"]);
  });

  it("HISTORY_SMEAR: keeps an empty window operational until today's unpersisted outage", () => {
    const cells = buildComponentDayCells({
      transitions: [], boundary: { at: TODAY - 40 * DAY, components: [] },
      liveComponents: live({ yield: "outage" }), liveObservedAt: NOW,
      publicHistoryStartedAt: TODAY - 40 * DAY,
      componentHistoryStartedAt: { yield: TODAY - 40 * DAY },
      nowSec: NOW, days: 3,
    });
    expect(cells.yield.map(({ state }) => state)).toEqual(["operational", "operational", "outage"]);
  });

  it("retains a pre-window incident when live health recovers without a persisted transition", () => {
    const cells = buildComponentDayCells({
      transitions: [],
      boundary: { at: TODAY - 40 * DAY, components: [{ id: "charts", state: "outage", reasons: [] }] },
      liveComponents: live(), liveObservedAt: NOW,
      publicHistoryStartedAt: TODAY - 50 * DAY,
      componentHistoryStartedAt: { charts: TODAY - 50 * DAY },
      nowSec: NOW, days: 3,
    });
    // Today's recovery cannot erase an outage observed earlier in the same day.
    expect(cells.charts.map(({ state }) => state)).toEqual(["outage", "outage", "outage"]);
  });

  it("leaves an empty window unknown without a persisted boundary, even after monitoring began", () => {
    const cells = buildComponentDayCells({
      transitions: [], liveComponents: live({ yield: "outage" }), liveObservedAt: NOW,
      publicHistoryStartedAt: TODAY - 40 * DAY, componentHistoryStartedAt: { yield: TODAY - 40 * DAY },
      nowSec: NOW, days: 3,
    });
    expect(cells.yield.map(({ state }) => state)).toEqual(["no-data", "no-data", "outage"]);
  });

  it("does not infer operational component history from the oldest row's healthy headline level", () => {
    const cells = buildComponentDayCells({
      transitions: [row(1, TODAY - DAY, [{ id: "yield", state: "delayed", reasons: [] }])],
      liveComponents: live(), liveObservedAt: NOW,
      publicHistoryStartedAt: TODAY - 40 * DAY, componentHistoryStartedAt: { yield: TODAY - 40 * DAY },
      nowSec: NOW, days: 3,
    });
    expect(cells.yield.map(({ state }) => state)).toEqual(["no-data", "delayed", "delayed"]);
  });

  it("uses a pre-window incident seed only until its in-window recovery", () => {
    const cells = buildComponentDayCells({
      transitions: [row(2, TODAY - DAY + 3600, [], { from: "stale" })],
      boundary: { at: TODAY - 40 * DAY, components: [{ id: "yield", state: "outage", reasons: [] }] },
      liveComponents: live(), liveObservedAt: NOW,
      publicHistoryStartedAt: TODAY - 50 * DAY, componentHistoryStartedAt: { yield: TODAY - 50 * DAY },
      nowSec: NOW, days: 3,
    });
    expect(cells.yield.map(({ state }) => state)).toEqual(["outage", "outage", "operational"]);
  });

  it("colours a day only for states held 60 minutes cumulatively, keeping shorter blips as brief", () => {
    const yieldDelayed = [{ id: "yield" as const, state: "delayed" as const, reasons: ["cache:yield-data:delayed"] }];
    const cells = buildComponentDayCells({
      transitions: [
        // Two days ago: a single 15-minute degraded evaluation.
        row(1, TODAY - 2 * DAY + 3600, [{ id: "stablecoin-data", state: "degraded", reasons: ["price-coverage-breadth"] }]),
        row(2, TODAY - 2 * DAY + 4500, []),
        // Yesterday: two 30-minute delayed stretches add up to 60 minutes.
        row(3, TODAY - DAY + 3600, yieldDelayed),
        row(4, TODAY - DAY + 5400, []),
        row(5, TODAY - DAY + 7200, yieldDelayed),
        row(6, TODAY - DAY + 9000, []),
      ],
      liveComponents: live(), liveObservedAt: NOW,
      boundary: { at: TODAY - 10 * DAY, components: [] },
      publicHistoryStartedAt: TODAY - 10 * DAY,
      componentHistoryStartedAt: Object.fromEntries(PUBLIC_STATUS_COMPONENT_IDS.map((id) => [id, TODAY - 10 * DAY])),
      nowSec: NOW, days: 3,
    });
    expect(cells["stablecoin-data"]).toEqual([
      { date: "2026-10-11", state: "operational", brief: "degraded" },
      { date: "2026-10-12", state: "operational" },
      { date: "2026-10-13", state: "operational" },
    ]);
    expect(cells.yield.map(({ state }) => state)).toEqual(["operational", "delayed", "operational"]);
  });

  it("counts worse states toward a milder band and colours any outage, however short", () => {
    const cells = buildComponentDayCells({
      transitions: [
        // 40 min delayed then 25 min degraded: 65 min at delayed-or-worse.
        row(1, TODAY - DAY + 3600, [{ id: "yield", state: "delayed", reasons: [] }]),
        row(2, TODAY - DAY + 6000, [{ id: "yield", state: "degraded", reasons: [] }]),
        row(3, TODAY - DAY + 7500, []),
        // A 15-minute database outage still colours today.
        row(4, TODAY + 3600, PUBLIC_STATUS_COMPONENT_IDS.map((id) => ({ id, state: "outage" as const, reasons: ["db-unavailable"] }))),
        row(5, TODAY + 4500, []),
      ],
      liveComponents: live(), liveObservedAt: NOW,
      boundary: { at: TODAY - 10 * DAY, components: [] },
      publicHistoryStartedAt: TODAY - 10 * DAY,
      componentHistoryStartedAt: Object.fromEntries(PUBLIC_STATUS_COMPONENT_IDS.map((id) => [id, TODAY - 10 * DAY])),
      nowSec: NOW, days: 2,
    });
    expect(cells.yield).toEqual([
      { date: "2026-10-12", state: "delayed", brief: "degraded" },
      { date: "2026-10-13", state: "outage" },
    ]);
    expect(cells.charts.map(({ state }) => state)).toEqual(["operational", "outage"]);
  });

  it("keeps a live non-outage blip brief when persisted history covers the day", () => {
    const cells = buildComponentDayCells({
      transitions: [], boundary: { at: TODAY - 40 * DAY, components: [] },
      liveComponents: live({ yield: "degraded" }), liveObservedAt: NOW,
      publicHistoryStartedAt: TODAY - 40 * DAY, componentHistoryStartedAt: { yield: TODAY - 40 * DAY },
      nowSec: NOW, days: 1,
    });
    expect(cells.yield).toEqual([{ date: "2026-10-13", state: "operational", brief: "degraded" }]);
  });

  it.each([undefined, NOW + 1, TODAY - 1, NaN])("does not renew live evidence from a missing, future or old clock (%s)", (liveObservedAt) => {
    const cells = buildComponentDayCells({
      transitions: [], liveComponents: live({ yield: "outage" }), liveObservedAt,
      publicHistoryStartedAt: null, nowSec: NOW, days: 2,
    });
    expect(cells.yield.map(({ state }) => state)).toEqual(["no-data", "no-data"]);
  });
});

describe("foldPublicIncidents", () => {
  it("retains component degradation without opening a service incident for a bounded listing notice", () => {
    const notice = row(1, NOW - 3600, [
      { id: "stablecoin-data", state: "degraded", reasons: ["publication-incomplete:asset-scoped"] },
    ], {
      to: "healthy",
      headline: { state: "operational", title: "Systems operational with notices", affected: ["stablecoin-data"] },
    });
    expect(foldPublicIncidents([notice])).toEqual([]);
    const cells = buildComponentDayCells({
      transitions: [notice], liveComponents: live({ "stablecoin-data": "degraded" }),
      liveObservedAt: NOW, publicHistoryStartedAt: TODAY,
      componentHistoryStartedAt: Object.fromEntries(PUBLIC_STATUS_COMPONENT_IDS.map((id) => [id, TODAY])),
      boundary: { at: TODAY, components: [] }, nowSec: NOW, days: 1,
    });
    expect(cells["stablecoin-data"][0].state).toBe("degraded");
    expect(cells["mint-burn"][0].state).toBe("operational");
  });

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
