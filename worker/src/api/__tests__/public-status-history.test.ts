import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import type { StatusCause } from "@shared/types/status";
import { makePublicHealth } from "../../lib/__tests__/public-health.test-support";

// Mock `assessPublicHealth` at the module level so tests can control the
// publicHealth outcome without wiring up the full mint-burn / circuit /
// cache fixture stack. vitest hoists vi.mock above the dynamic import below.
const assessPublicHealthMock = vi.fn();
vi.mock("../../lib/public-health-assessment", () => ({
  assessPublicHealth: assessPublicHealthMock,
}));

const { handlePublicStatusHistory } = await import("../public-status-history");

type TransitionSeed = {
  id: number;
  previous_status: "healthy" | "degraded" | "stale" | null;
  next_status: "healthy" | "degraded" | "stale";
  raw_status: "healthy" | "degraded" | "stale";
  transition_type: "degrade" | "recover" | "init";
  reason: string;
  causes: StatusCause[];
  created_at: number;
};

function makeDb(params: {
  transitions: TransitionSeed[];
  stateStatus?: "healthy" | "degraded" | "stale";
  stateLastChangedAt?: number | null;
}) {
  const stateRow = params.stateStatus
    ? {
        scope: "global",
        current_status: params.stateStatus,
        raw_status: params.stateStatus,
        last_evaluated_at: Math.floor(Date.now() / 1000),
        last_changed_at: params.stateLastChangedAt ?? Math.floor(Date.now() / 1000) - 3600,
        consecutive_healthy: 0,
        consecutive_degraded: 0,
        consecutive_stale: 0,
        confidence: 0.9,
        causes_json: "[]",
      }
    : null;
  return mockD1([
    {
      match: "FROM status_state",
      rows: stateRow ? [stateRow] : [],
      first: stateRow,
    },
    {
      match: "FROM status_transitions",
      rows: params.transitions.map((t) => ({
        id: t.id,
        scope: "global",
        previous_status: t.previous_status,
        next_status: t.next_status,
        raw_status: t.raw_status,
        transition_type: t.transition_type,
        reason: t.reason,
        confidence: 0.9,
        causes_json: JSON.stringify(t.causes),
        created_at: t.created_at,
      })),
    },
  ]);
}

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
    it("omits transitions whose only cause is missing_prices_degraded", async () => {
      const now = Math.floor(Date.now() / 1000);
      const db = makeDb({
        transitions: [{
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
            message: "Missing price ratio is degraded (18.56% > 18.00%).",
          }],
          created_at: now - 3600,
        }],
      });

      assessPublicHealthMock.mockResolvedValue(makePublicHealth("healthy"));

      const request = new Request("https://pharos.watch/api/public-status-history?window=24h");
      const res = await handlePublicStatusHistory(db, request);
      const body = (await res.json()) as {
        currentStatus: string;
        transitions: unknown[];
      };
      expect(body.transitions).toHaveLength(0);
      expect(body.currentStatus).toBe("healthy");
    });

    it("retains transitions caused by cache_ratio_stale", async () => {
      const now = Math.floor(Date.now() / 1000);
      const db = makeDb({
        transitions: [{
          id: 1,
          previous_status: "healthy",
          next_status: "stale",
          raw_status: "stale",
          transition_type: "degrade",
          reason: "raw-stale-immediate-escalation",
          causes: [{
            code: "cache_ratio_stale",
            layer: "availability",
            severity: "critical",
            message: "Cache freshness exceeded stale threshold.",
          }],
          created_at: now - 3600,
        }],
      });

      assessPublicHealthMock.mockResolvedValue(makePublicHealth("stale"));

      const request = new Request("https://pharos.watch/api/public-status-history?window=24h");
      const res = await handlePublicStatusHistory(db, request);
      const body = (await res.json()) as {
        currentStatus: string;
        transitions: Array<{ to: string }>;
        lastChangedAt: number | null;
      };
      expect(body.transitions).toHaveLength(1);
      expect(body.transitions[0].to).toBe("stale");
      expect(body.currentStatus).toBe("stale");
      expect(body.lastChangedAt).toBe(now - 3600);
    });

    it("retains transitions whose causes mix public and admin codes", async () => {
      const now = Math.floor(Date.now() / 1000);
      const db = makeDb({
        transitions: [{
          id: 1,
          previous_status: "healthy",
          next_status: "degraded",
          raw_status: "degraded",
          transition_type: "degrade",
          reason: "raw-degraded-consecutive-threshold",
          causes: [
            {
              code: "missing_prices_degraded",
              layer: "data-quality",
              severity: "warning",
              message: "Missing price ratio is degraded (18.5% > 18%).",
            },
            {
              code: "cache_ratio_degraded",
              layer: "availability",
              severity: "warning",
              message: "Cache freshness exceeded degraded threshold.",
            },
          ],
          created_at: now - 3600,
        }],
      });

      assessPublicHealthMock.mockResolvedValue(makePublicHealth("degraded"));

      const request = new Request("https://pharos.watch/api/public-status-history?window=24h");
      const res = await handlePublicStatusHistory(db, request);
      const body = (await res.json()) as {
        currentStatus: string;
        transitions: unknown[];
      };
      expect(body.transitions).toHaveLength(1);
      expect(body.currentStatus).toBe("degraded");
    });

    it("omits transitions whose only cause is an info-severity watch item", async () => {
      // info-severity causes never count as public-impacting, regardless of
      // the code. This guards against a new data-quality info cause leaking
      // into the public filter later.
      const now = Math.floor(Date.now() / 1000);
      const db = makeDb({
        transitions: [{
          id: 1,
          previous_status: "healthy",
          next_status: "degraded",
          raw_status: "degraded",
          transition_type: "degrade",
          reason: "raw-degraded-consecutive-threshold",
          causes: [
            {
              code: "watch_unhealthy_crons_present",
              layer: "availability",
              severity: "info",
              message: "1 watch-tier cron job(s) are unavailable/stale.",
            },
            {
              code: "onchain_monitor_low_sample",
              layer: "data-quality",
              severity: "info",
              message: "On-chain monitor has only 2 recently refreshed coin(s).",
            },
          ],
          created_at: now - 3600,
        }],
      });

      assessPublicHealthMock.mockResolvedValue(makePublicHealth("healthy"));

      const request = new Request("https://pharos.watch/api/public-status-history?window=24h");
      const res = await handlePublicStatusHistory(db, request);
      const body = (await res.json()) as { transitions: unknown[]; currentStatus: string };
      expect(body.transitions).toHaveLength(0);
      expect(body.currentStatus).toBe("healthy");
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

      const request = new Request("https://pharos.watch/api/public-status-history?window=24h");
      const res = await handlePublicStatusHistory(db, request);
      const body = (await res.json()) as {
        currentStatus: string;
        lastChangedAt: number | null;
      };
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

      const res = await handlePublicStatusHistory(
        db,
        new Request("https://pharos.watch/api/public-status-history?window=24h"),
      );
      const body = (await res.json()) as { currentStatus: string; lastChangedAt: number | null };

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

      const request = new Request("https://pharos.watch/api/public-status-history?window=24h");
      const res = await handlePublicStatusHistory(db, request);
      const body = (await res.json()) as {
        transitions: Array<{ id: number; from: string | null; to: string }>;
        currentStatus: string;
      };

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

      const request = new Request("https://pharos.watch/api/public-status-history?window=24h");
      const res = await handlePublicStatusHistory(db, request);
      const body = (await res.json()) as { transitions: unknown[]; currentStatus: string };

      expect(body.currentStatus).toBe("healthy");
      expect(body.transitions).toHaveLength(0);
    });
  });
});
