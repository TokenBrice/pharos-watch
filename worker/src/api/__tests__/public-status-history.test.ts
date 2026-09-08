import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import type { StatusCause } from "@shared/types/status";
import { makePublicHealth } from "../../lib/__tests__/public-health.test-support";
import { makeDb, readHistory, transition } from "./public-status-history.test-support";

// Mock `assessPublicHealth` at the module level so tests can control the
// publicHealth outcome without wiring up the full mint-burn / circuit /
// cache fixture stack. vitest hoists vi.mock above the dynamic import below.
const { assessPublicHealthMock } = vi.hoisted(() => ({ assessPublicHealthMock: vi.fn() }));
vi.mock("../../lib/public-health-assessment", () => ({
  assessPublicHealth: assessPublicHealthMock,
}));

const { handlePublicStatusHistory } = await import("../public-status-history");


describe("handlePublicStatusHistory", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-13T12:00:00Z"));
    assessPublicHealthMock.mockReset();
    // Default to healthy so existing tests that don't care about the public
    // health outcome continue to work once the handler reads it.
    assessPublicHealthMock.mockResolvedValue(makePublicHealth("healthy"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("filters transitions to the requested time window", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "FROM status_state",
        rows: [],
        first: null,
      },
      {
        match: "FROM status_transitions",
        rows: [{
          id: 1,
          scope: "global",
          previous_status: "healthy",
          next_status: "degraded",
          raw_status: "degraded",
          transition_type: "degrade",
          reason: "raw-degraded-consecutive-threshold",
          confidence: 0.92,
          causes_json: JSON.stringify([{
            code: "cache_ratio_degraded",
            layer: "availability",
            severity: "warning",
            message: "Cache freshness exceeded degraded threshold.",
          }]),
          created_at: now - 600,
        }],
      },
    ]);

    const request = new Request("https://pharos.watch/api/public-status-history?window=24h&limit=20");
    const res = await handlePublicStatusHistory(db, request);

    expect(res.status).toBe(200);
    expect(db.getHistory()).toContainEqual(expect.objectContaining({
      sql: expect.stringContaining("FROM status_transitions"),
      binds: ["global", now - (24 * 60 * 60), 20],
    }));
  });

  it("rejects unknown windows", async () => {
    const db = mockD1([]);
    const request = new Request("https://pharos.watch/api/public-status-history?window=90d");
    const res = await handlePublicStatusHistory(db, request);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid window parameter" });
  });

  it("rejects oversized limits instead of silently clamping them", async () => {
    const db = mockD1([]);
    const request = new Request("https://pharos.watch/api/public-status-history?limit=999");
    const res = await handlePublicStatusHistory(db, request);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid limit: must be between 1 and 200" });
  });

  // -------------------------------------------------------------------------
  // 2026-04-13 status-stability hardening: public-impact filtering.
  // -------------------------------------------------------------------------
  //
  // The public transition history should only surface transitions whose
  // causes include at least one public-facing impact (cache ratio, FX source,
  // mint/burn, circuit breakers, critical cron errors, db_unhealthy). Admin-
  // only data-quality causes (missing prices, blacklist ratio drift, reserve
  // sync, onchain monitor) are filtered out. Additionally, the public
  // currentStatus is sourced from assessPublicHealth — not the hysteresis-
  // smoothed status_state.current_status — so the hero and uptime bar agree.
  describe("public-impact filter + currentStatus alignment", () => {
    it.each([
      { name: "admin-only", status: "healthy", next: "degraded", codes: ["missing_prices_degraded"], severity: "warning", retained: false },
      { name: "public stale", status: "stale", next: "stale", codes: ["cache_ratio_stale"], severity: "critical", retained: true },
      { name: "mixed public and admin", status: "degraded", next: "degraded", codes: ["missing_prices_degraded", "cache_ratio_degraded"], severity: "warning", retained: true },
      { name: "info-only", status: "healthy", next: "degraded", codes: ["watch_unhealthy_crons_present", "onchain_monitor_low_sample"], severity: "info", retained: false },
    ] as const)("filters $name causes", async ({ status, next, codes, severity, retained }) => {
      const now = Math.floor(Date.now() / 1000);
      const causes: StatusCause[] = codes.map((code) => ({
        code, layer: code.startsWith("missing") || code.startsWith("onchain") ? "data-quality" : "availability",
        severity, message: code,
      }));
      const db = makeDb({ transitions: [transition({
        id: 1, next_status: next, causes, created_at: now - 3600,
      })] });
      assessPublicHealthMock.mockResolvedValue(makePublicHealth(status));
      const body = await readHistory(db);
      expect(body.currentStatus).toBe(status);
      expect(body.transitions.map(({ id, to }) => ({ id, to }))).toEqual(retained ? [{ id: 1, to: next }] : []);
      expect(body.lastChangedAt).toBe(retained ? now - 3600 : null);
    });

    it("does not reuse the admin state timestamp when public history has no matching transition", async () => {
      // Admin state says 'degraded' (hysteresis-smoothed global, likely
      // driven by missing_prices_degraded), but the public health assessment
      // says 'healthy' because /api/health does not include data-quality
      // signals. The public history endpoint must report the public view so
      // the hero badge and uptime bar agree.
      const now = Math.floor(Date.now() / 1000);
      const db = makeDb({
        transitions: [],
        stateStatus: "degraded",
        stateLastChangedAt: now - 3600,
      });

      assessPublicHealthMock.mockResolvedValue(makePublicHealth("healthy"));

      const body = await readHistory(db);
      expect(body.currentStatus).toBe("healthy");
      expect(body.lastChangedAt).toBeNull();
    });

    it("omits lastChangedAt when the latest public transition does not match live health", async () => {
      const now = Math.floor(Date.now() / 1000);
      const db = makeDb({
        transitions: [
          {
            id: 1,
            previous_status: "healthy",
            next_status: "stale",
            raw_status: "stale",
            transition_type: "degrade",
            reason: "raw-stale-immediate-escalation",
            causes: [
              {
                code: "cache_ratio_stale",
                layer: "availability",
                severity: "critical",
                message: "Cache freshness exceeded stale threshold.",
              },
            ],
            created_at: now - 3600,
          },
        ],
      });
      assessPublicHealthMock.mockResolvedValue(makePublicHealth("degraded"));

      const body = await readHistory(db);

      expect(body.currentStatus).toBe("degraded");
      expect(body.lastChangedAt).toBeNull();
    });

    it("keeps info-only recovery rows that close a public-impact incident", async () => {
      const now = Math.floor(Date.now() / 1000);
      const db = makeDb({
        transitions: [
          {
            id: 3,
            previous_status: "degraded",
            next_status: "healthy",
            raw_status: "healthy",
            transition_type: "recover",
            reason: "raw-healthy-recovery-threshold",
            causes: [{
              code: "onchain_monitor_low_sample",
              layer: "data-quality",
              severity: "info",
              message: "On-chain monitor has a structurally low sample.",
            }],
            created_at: now - 1800,
          },
          {
            id: 2,
            previous_status: "stale",
            next_status: "degraded",
            raw_status: "degraded",
            transition_type: "recover",
            reason: "raw-degraded-recovery-from-stale",
            causes: [{
              code: "watch_unhealthy_crons_present",
              layer: "availability",
              severity: "info",
              message: "One watch-tier cron is unavailable.",
            }],
            created_at: now - 2700,
          },
          {
            id: 1,
            previous_status: "healthy",
            next_status: "stale",
            raw_status: "stale",
            transition_type: "degrade",
            reason: "raw-stale-immediate-escalation",
            causes: [{
              code: "cron_error_runs",
              layer: "availability",
              severity: "critical",
              message: "One availability-impacting cron job errored.",
            }],
            created_at: now - 3600,
          },
        ],
      });

      assessPublicHealthMock.mockResolvedValue(makePublicHealth("healthy"));

      const body = await readHistory(db);

      expect(body.currentStatus).toBe("healthy");
      expect(body.transitions.map((transition) => transition.id)).toEqual([3, 2, 1]);
      expect(body.transitions.map((transition) => `${transition.from}->${transition.to}`)).toEqual([
        "degraded->healthy",
        "stale->degraded",
        "healthy->stale",
      ]);
    });

    it("omits admin-only degradation and recovery pairs", async () => {
      const now = Math.floor(Date.now() / 1000);
      const db = makeDb({
        transitions: [
          {
            id: 2,
            previous_status: "degraded",
            next_status: "healthy",
            raw_status: "healthy",
            transition_type: "recover",
            reason: "raw-healthy-recovery-threshold",
            causes: [{
              code: "onchain_monitor_low_sample",
              layer: "data-quality",
              severity: "info",
              message: "On-chain monitor has a structurally low sample.",
            }],
            created_at: now - 1800,
          },
          {
            id: 1,
            previous_status: "healthy",
            next_status: "degraded",
            raw_status: "degraded",
            transition_type: "degrade",
            reason: "raw-degraded-consecutive-threshold",
            causes: [{
              code: "missing_prices_degraded",
              layer: "data-quality",
              severity: "warning",
              message: "Missing price ratio is degraded.",
            }],
            created_at: now - 3600,
          },
        ],
      });

      assessPublicHealthMock.mockResolvedValue(makePublicHealth("healthy"));

      const body = await readHistory(db);

      expect(body.currentStatus).toBe("healthy");
      expect(body.transitions).toHaveLength(0);
    });
  });
});
