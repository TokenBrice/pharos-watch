import { afterEach, describe, expect, it } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { makeHealthyHealthResponse } from "@shared/test-utils/health-fixtures";
import type { HealthResponse } from "@shared/types/status";
import { listRecentStatusTransitions } from "../../status-reliability";
import { listPublicStatusTransitions, reconcilePublicStatusState } from "../public-status-state";

const NOW = 1_800_000_000;
const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

function lateCharts(): HealthResponse {
  const health = makeHealthyHealthResponse();
  health.caches = { "stablecoin-charts": { ageSeconds: 600 * 9, maxAge: 600, healthy: true } };
  health.status = "degraded";
  return health;
}

describe("reconcilePublicStatusState", () => {
  it("records a new Safety Scores component without backdating its history", async () => {
    const { db } = fixtures.open();
    await reconcilePublicStatusState(db, NOW, makeHealthyHealthResponse());
    const row = await db.prepare("SELECT causes_json FROM status_state WHERE scope = 'public'").first<{ causes_json: string }>();
    const stored = JSON.parse(row!.causes_json) as {
      components: { id: string }[];
      componentHistoryStartedAt?: Record<string, number>;
    };
    stored.components = stored.components.filter((component) => component.id !== "safety-scores");
    delete stored.componentHistoryStartedAt;
    await db.prepare("UPDATE status_state SET causes_json = ? WHERE scope = 'public'").bind(JSON.stringify(stored)).run();

    await reconcilePublicStatusState(db, NOW + 900, makeHealthyHealthResponse());
    const history = await listPublicStatusTransitions(db, 50, NOW - 1);
    expect(history.startedAt).toBe(NOW);
    expect(history.componentHistoryStartedAt["safety-scores"]).toBe(NOW + 900);
    expect(history.componentHistoryStartedAt["risk-signals"]).toBe(NOW);
    expect(history.transitions).toHaveLength(2);
    expect(history.transitions[0].components).toEqual([]);
  });

  it("persists held and recovered Safety Scores in the public transition stream", async () => {
    const { db } = fixtures.open();
    const health = makeHealthyHealthResponse();
    await reconcilePublicStatusState(db, NOW, health);
    health.safetyScorePublication = {
      ...health.safetyScorePublication!, status: "held",
      attemptedAtSec: health.timestamp, heldSinceSec: health.timestamp - 10,
      reasons: [{ code: "redemption-stale" }],
    };
    await reconcilePublicStatusState(db, NOW + 900, health);
    await reconcilePublicStatusState(db, NOW + 1800, makeHealthyHealthResponse());
    const history = await listPublicStatusTransitions(db, 50, NOW - 1);
    expect(history.transitions[1]).toMatchObject({
      source: "public", transitionType: "degrade", headline: { state: "degraded" },
      components: [{ id: "safety-scores", state: "degraded", reasons: ["safety-score-publication-held", "safety-score-publication-held:redemption-stale"] }],
    });
    expect(history.transitions[0]).toMatchObject({ transitionType: "recover", components: [] });
  });

  it("persists an init row, then one row per component change, with since carried forward", async () => {
    const { db } = fixtures.open();

    const first = await reconcilePublicStatusState(db, NOW, makeHealthyHealthResponse());
    expect(first.persistenceSucceeded).toBe(true);
    expect(first.projection.components.every((component) => component.since == null)).toBe(true);

    // Unchanged projection: no new row, and an init-time state keeps an unknown start.
    const unchanged = await reconcilePublicStatusState(db, NOW + 900, makeHealthyHealthResponse());
    expect(unchanged.projection.components.every((component) => component.since == null)).toBe(true);

    const degraded = await reconcilePublicStatusState(db, NOW + 1800, lateCharts());
    expect(degraded.projection.headline.state).toBe("delayed");
    expect(degraded.projection.components.find((component) => component.id === "charts")!.since).toBe(NOW + 1800);

    const held = await reconcilePublicStatusState(db, NOW + 2700, lateCharts());
    expect(held.projection.components.find((component) => component.id === "charts")!.since).toBe(NOW + 1800);

    await reconcilePublicStatusState(db, NOW + 3600, makeHealthyHealthResponse());

    const history = await listPublicStatusTransitions(db, 50, NOW - 1);
    expect(history.startedAt).toBe(NOW);
    expect(history.hasMore).toBe(false);
    expect(history.transitions.map(({ transitionType, to, at }) => ({ transitionType, to, at }))).toEqual([
      { transitionType: "recover", to: "healthy", at: NOW + 3600 },
      { transitionType: "degrade", to: "degraded", at: NOW + 1800 },
      { transitionType: "init", to: "healthy", at: NOW },
    ]);
    expect(history.transitions[1]).toMatchObject({
      source: "public",
      headline: { state: "delayed" },
      components: [{ id: "charts", state: "delayed" }],
    });

    // Operator history never sees public rows.
    expect(await listRecentStatusTransitions(db, 50, { from: NOW - 1 })).toEqual([]);
  });

  it("ignores a persisted component this release does not know instead of resetting every since", async () => {
    const { db } = fixtures.open();
    await reconcilePublicStatusState(db, NOW, makeHealthyHealthResponse());
    await reconcilePublicStatusState(db, NOW + 900, lateCharts());
    const row = await db.prepare("SELECT causes_json FROM status_state WHERE scope = 'public'").first<{ causes_json: string }>();
    const stored = JSON.parse(row!.causes_json) as { components: unknown[] };
    stored.components.push({ id: "future-component", state: "operational", since: null, reasons: [] });
    await db.prepare("UPDATE status_state SET causes_json = ? WHERE scope = 'public'").bind(JSON.stringify(stored)).run();

    const next = await reconcilePublicStatusState(db, NOW + 1800, lateCharts());
    expect(next.projection.components.find((component) => component.id === "charts")!.since).toBe(NOW + 900);
    const history = await listPublicStatusTransitions(db, 50, NOW - 1);
    expect(history.transitions.filter((transition) => transition.transitionType === "init")).toHaveLength(1);
  });

  it("bounds the history page and reports more rows (R7)", async () => {
    const { db } = fixtures.open();
    await reconcilePublicStatusState(db, NOW, makeHealthyHealthResponse());
    await reconcilePublicStatusState(db, NOW + 900, lateCharts());
    await reconcilePublicStatusState(db, NOW + 1800, makeHealthyHealthResponse());
    const page = await listPublicStatusTransitions(db, 2, NOW - 1);
    expect(page.transitions).toHaveLength(2);
    expect(page.hasMore).toBe(true);
  });
});
