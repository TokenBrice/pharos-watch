import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
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

  it("keeps an in-budget Safety Score hold out of the transition stream, then records its age outage", async () => {
    const { db } = fixtures.open();
    const health = makeHealthyHealthResponse();
    await reconcilePublicStatusState(db, NOW, health);
    health.safetyScorePublication = {
      ...health.safetyScorePublication!, status: "held",
      attemptedAtSec: health.timestamp, heldSinceSec: health.timestamp - 10,
      reasons: [{ code: "redemption-stale" }],
    };
    const held = await reconcilePublicStatusState(db, NOW + 900, health);
    expect(held.projection.headline).toMatchObject({ state: "operational", affected: ["safety-scores"] });
    expect((await listPublicStatusTransitions(db, 50, NOW - 1)).transitions).toHaveLength(1);
    health.safetyScorePublication.acceptedAtSec = health.timestamp - 12 * CRON_INTERVALS["compute-safety-score-v9"] - 1;
    // An age outage bypasses hysteresis on entry; clearing still needs two evaluations.
    await reconcilePublicStatusState(db, NOW + 1800, health);
    await reconcilePublicStatusState(db, NOW + 2700, makeHealthyHealthResponse());
    await reconcilePublicStatusState(db, NOW + 3600, makeHealthyHealthResponse());
    const history = await listPublicStatusTransitions(db, 50, NOW - 1);
    expect(history.transitions.map(({ at }) => at)).toEqual([NOW + 3600, NOW + 1800, NOW]);
    expect(history.transitions[1]).toMatchObject({
      source: "public", transitionType: "degrade", headline: { state: "partial-outage" },
      components: [{ id: "safety-scores", state: "outage", reasons: expect.arrayContaining(["safety-score-publication:outage", "safety-score-publication-held"]) }],
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

    // First late evaluation is held (hysteresis); the second confirms it with the first-seen `since`.
    const pending = await reconcilePublicStatusState(db, NOW + 1800, lateCharts());
    expect(pending.projection.headline.state).toBe("operational");
    expect(pending.projection.components.find((component) => component.id === "charts")!.state).toBe("operational");
    const counters = await db.prepare("SELECT consecutive_healthy, consecutive_degraded FROM status_state WHERE scope = 'public'")
      .first<{ consecutive_healthy: number; consecutive_degraded: number }>();
    expect(counters).toEqual({ consecutive_healthy: 0, consecutive_degraded: 1 });

    const degraded = await reconcilePublicStatusState(db, NOW + 2700, lateCharts());
    expect(degraded.projection.headline.state).toBe("delayed");
    expect(degraded.projection.components.find((component) => component.id === "charts")!.since).toBe(NOW + 1800);

    const held = await reconcilePublicStatusState(db, NOW + 3600, lateCharts());
    expect(held.projection.components.find((component) => component.id === "charts")!.since).toBe(NOW + 1800);

    // Clearing also needs two evaluations.
    const clearing = await reconcilePublicStatusState(db, NOW + 4500, makeHealthyHealthResponse());
    expect(clearing.projection.components.find((component) => component.id === "charts")!.state).toBe("delayed");
    await reconcilePublicStatusState(db, NOW + 5400, makeHealthyHealthResponse());

    const history = await listPublicStatusTransitions(db, 50, NOW - 1);
    expect(history.startedAt).toBe(NOW);
    expect(history.hasMore).toBe(false);
    expect(history.transitions.map(({ transitionType, to, at }) => ({ transitionType, to, at }))).toEqual([
      { transitionType: "recover", to: "healthy", at: NOW + 5400 },
      { transitionType: "degrade", to: "degraded", at: NOW + 2700 },
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

  it("drops one-evaluation flaps and lets a database outage bypass hysteresis", async () => {
    const { db } = fixtures.open();
    await reconcilePublicStatusState(db, NOW, makeHealthyHealthResponse());
    // A single late evaluation between healthy ones never reaches the transition log.
    await reconcilePublicStatusState(db, NOW + 900, lateCharts());
    await reconcilePublicStatusState(db, NOW + 1800, makeHealthyHealthResponse());
    expect((await listPublicStatusTransitions(db, 50, NOW - 1)).transitions).toHaveLength(1);
    // A direction change restarts the streak: degraded-then-clear is not two degraded evaluations.
    await reconcilePublicStatusState(db, NOW + 2700, lateCharts());
    await reconcilePublicStatusState(db, NOW + 3600, makeHealthyHealthResponse());
    await reconcilePublicStatusState(db, NOW + 4500, lateCharts());
    expect((await listPublicStatusTransitions(db, 50, NOW - 1)).transitions).toHaveLength(1);

    const down = { ...makeHealthyHealthResponse(), status: "stale" as const, warnings: ["db-unhealthy"] };
    const outage = await reconcilePublicStatusState(db, NOW + 5400, down);
    expect(outage.projection.headline.state).toBe("major-outage");
    expect(outage.projection.components.every((component) => component.state === "outage" && component.since === NOW + 5400)).toBe(true);
  });

  it("publishes at once when a legacy record cannot be held faithfully", async () => {
    const { db } = fixtures.open();
    await reconcilePublicStatusState(db, NOW, makeHealthyHealthResponse());
    const row = await db.prepare("SELECT causes_json FROM status_state WHERE scope = 'public'").first<{ causes_json: string }>();
    const stored = JSON.parse(row!.causes_json) as { components: Record<string, unknown>[] };
    for (const component of stored.components) delete component.summary;
    await db.prepare("UPDATE status_state SET causes_json = ? WHERE scope = 'public'").bind(JSON.stringify(stored)).run();
    const next = await reconcilePublicStatusState(db, NOW + 900, lateCharts());
    expect(next.projection.components.find((component) => component.id === "charts")).toMatchObject({ state: "delayed", since: NOW + 900 });
  });

  it("records changed breaker identities once without heartbeat or ordering noise", async () => {
    const { db } = fixtures.open();
    const health = makeHealthyHealthResponse();
    const open = { state: "open" as const, consecutiveFailures: 3, lastFailureAt: NOW,
      lastSuccessAt: null, openedAt: NOW };
    health.circuits = { "source-c": open, "source-a": open, "source-b": open };
    await reconcilePublicStatusState(db, NOW, health);
    health.circuits = { "source-b": { ...open, lastFailureAt: NOW + 1 }, "source-c": open, "source-a": open };
    await reconcilePublicStatusState(db, NOW + 1, health);
    health.circuits = { "source-a": open, "source-b": open, "source-d": open };
    const changed = await reconcilePublicStatusState(db, NOW + 2, health);
    expect(changed.projection.components.find((component) => component.id === "data-refresh")?.since).toBeNull();
    const history = await listPublicStatusTransitions(db, 50, NOW - 1);
    expect(history.transitions).toHaveLength(2);
    expect(history.transitions[0]).toMatchObject({ reason: "public-projection-causes-changed",
      components: [expect.objectContaining({ reasons: ["upstream-circuits-open:3:source-a,source-b,source-d"] })] });
  });

  it("records a changed scheduler unavailable subreason without repeated poll events", async () => {
    const { db } = fixtures.open();
    const health = makeHealthyHealthResponse();
    health.schedulerLiveness = { ...health.schedulerLiveness!, status: "unavailable", ageSeconds: null,
      unavailableReason: "clock-invalid" };
    await reconcilePublicStatusState(db, NOW, health);
    health.schedulerLiveness.unavailableReason = "slot-start-query-failed";
    await reconcilePublicStatusState(db, NOW + 1, health);
    await reconcilePublicStatusState(db, NOW + 2, health);
    expect((await listPublicStatusTransitions(db, 50, NOW - 1)).transitions).toHaveLength(2);
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
    await reconcilePublicStatusState(db, NOW + 1800, lateCharts());
    await reconcilePublicStatusState(db, NOW + 2700, makeHealthyHealthResponse());
    await reconcilePublicStatusState(db, NOW + 3600, makeHealthyHealthResponse());
    const page = await listPublicStatusTransitions(db, 2, NOW - 1);
    expect(page.transitions).toHaveLength(2);
    expect(page.hasMore).toBe(true);
  });
});
