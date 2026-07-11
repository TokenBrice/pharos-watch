import { describe, expect, it } from "vitest";
import type { StatusResponse, StatusTransition } from "@shared/types";
import {
  DEFAULT_INCIDENT_HISTORY_QUERY,
  buildIncidentHistoryUrl,
  buildIncidentHistoryView,
  deriveWorkerVersionEvidence,
  findFirstDegradationAfter,
  parseIncidentHistoryQuery,
} from "@/lib/incident-history-view-model";

const NOW_SECONDS = 4_000;

function transitions(): StatusTransition[] {
  return [
    {
      id: 1,
      scope: "global",
      from: "healthy",
      to: "degraded",
      rawStatus: "degraded",
      transitionType: "degrade",
      reason: "Public cache degraded",
      confidence: 0.8,
      causes: [
        {
          code: "cache_ratio_degraded",
          layer: "availability",
          severity: "warning",
          message: "Cache coverage fell below target.",
        },
      ],
      at: 1_000,
    },
    {
      id: 4,
      scope: "global",
      from: "healthy",
      to: "degraded",
      rawStatus: "degraded",
      transitionType: "degrade",
      reason: "Persisted causes missing",
      confidence: 0.4,
      causes: [],
      at: 3_000,
    },
    {
      id: 2,
      scope: "global",
      from: "degraded",
      to: "stale",
      rawStatus: "stale",
      transitionType: "degrade",
      reason: "Database unavailable",
      confidence: 0.95,
      causes: [
        {
          code: "db_unhealthy",
          layer: "system",
          severity: "critical",
          message: "D1 health check failed.",
        },
      ],
      at: 1_600,
    },
    {
      id: 3,
      scope: "global",
      from: "stale",
      to: "healthy",
      rawStatus: "healthy",
      transitionType: "recover",
      reason: "Checks recovered",
      confidence: 0.99,
      causes: [
        {
          code: "reserve_sync_history_write_gap",
          layer: "data-quality",
          severity: "info",
          message: "Historical write debt remains informational.",
        },
      ],
      at: 2_200,
    },
  ];
}

describe("incident history view model", () => {
  it("sorts transitions before deriving state duration and resolution context", () => {
    const view = buildIncidentHistoryView(transitions(), NOW_SECONDS, 4, DEFAULT_INCIDENT_HISTORY_QUERY);

    expect(view.rows.map((row) => row.transition.id)).toEqual([4, 3, 2, 1]);
    expect(view.rows[0]).toMatchObject({
      durationSec: 1_000,
      ongoing: true,
      resolvedAt: null,
      resolution: "unresolved",
    });
    expect(view.rows[1]).toMatchObject({
      durationSec: 800,
      durationEndsAt: 3_000,
      ongoing: false,
      resolvedAt: 2_200,
      resolution: "resolved",
    });
    expect(view.rows[2]).toMatchObject({ durationSec: 600, resolvedAt: 2_200, resolution: "resolved" });
    expect(view.rows[3]).toMatchObject({ durationSec: 600, resolvedAt: 2_200, resolution: "resolved" });
    expect(view.transitionsLast24h).toBe(4);
    expect(view.isFlapping).toBe(true);
  });

  it("classifies severity, surfaces, and public impact without inventing missing causes", () => {
    const view = buildIncidentHistoryView(transitions(), NOW_SECONDS, 2, DEFAULT_INCIDENT_HISTORY_QUERY);

    expect(view.rows.map(({ severity, surfaces, publicImpact }) => ({ severity, surfaces, publicImpact }))).toEqual([
      { severity: "unknown", surfaces: [], publicImpact: "unknown" },
      { severity: "info", surfaces: ["data-quality"], publicImpact: "not-impacting" },
      { severity: "critical", surfaces: ["system"], publicImpact: "impacting" },
      { severity: "warning", surfaces: ["availability"], publicImpact: "impacting" },
    ]);
    expect(view.isFlapping).toBe(false);
  });

  it("combines severity, surface, cause-code, and public-impact filters", () => {
    const all = transitions();
    expect(
      buildIncidentHistoryView(all, NOW_SECONDS, 0, {
        severity: "critical",
        surface: "system",
        causeCode: "db_unhealthy",
        publicImpact: "impacting",
      }).rows.map((row) => row.transition.id),
    ).toEqual([2]);
    expect(
      buildIncidentHistoryView(all, NOW_SECONDS, 0, {
        severity: "unknown",
        surface: "unknown",
        causeCode: null,
        publicImpact: "unknown",
      }).rows.map((row) => row.transition.id),
    ).toEqual([4]);
    expect(buildIncidentHistoryView(all, NOW_SECONDS, 0, DEFAULT_INCIDENT_HISTORY_QUERY).causeCodeOptions).toEqual([
      "cache_ratio_degraded",
      "db_unhealthy",
      "reserve_sync_history_write_gap",
    ]);
  });

  it("parses and serializes URL filters while preserving unrelated query state and hashes", () => {
    expect(
      parseIncidentHistoryQuery(
        "?window=7d&severity=warning&surface=availability&cause=cache_ratio_degraded&impact=impacting",
      ),
    ).toEqual({
      window: "7d",
      severity: "warning",
      surface: "availability",
      causeCode: "cache_ratio_degraded",
      publicImpact: "impacting",
    });
    expect(parseIncidentHistoryQuery("?window=forever&severity=loud&surface=edge&impact=maybe")).toEqual(
      DEFAULT_INCIDENT_HISTORY_QUERY,
    );
    expect(
      buildIncidentHistoryUrl({ pathname: "/admin/history/", search: "?keep=1", hash: "#history" } as Location, {
        window: "30d",
        severity: "critical",
        surface: "system",
        causeCode: "db_unhealthy",
        publicImpact: "impacting",
      }),
    ).toBe(
      "/admin/history/?keep=1&window=30d&severity=critical&surface=system&impact=impacting&cause=db_unhealthy#history",
    );
  });

  it("finds only the first degradation at or after a real release marker", () => {
    expect(findFirstDegradationAfter(transitions(), 1_500)?.id).toBe(2);
    expect(findFirstDegradationAfter(transitions(), 3_100)).toBeNull();
    expect(findFirstDegradationAfter(transitions(), null)).toBeNull();
  });

  it("uses observed Worker version fields but does not synthesize deployment time", () => {
    const input = {
      producerHeads: [
        {
          scheduleKey: "hourly",
          job: "prices",
          producerPath: "prices",
          producerKind: "cron",
          observed: true,
          lastInvocationId: "inv-1",
          lastWorkerVersion: "worker-v2",
          lastInvokedAt: 3_500,
          lastCompletedAt: 3_510,
          lastOutcome: "ok",
          lastError: null,
          lastProductiveInvocationId: "inv-1",
          lastProductiveAt: 3_510,
          lastProductiveItemCount: 10,
          lastPublicationAt: 3_520,
          invocationCount: 2,
          productiveCount: 2,
        },
      ],
      crons: {
        digest: {
          lastRun: null,
          recentRuns: [],
          expectedIntervalSec: 60,
          healthy: true,
          latestAttempt: {
            attemptId: "attempt-1",
            idempotencyKey: "idem-1",
            scheduleKey: "daily",
            job: "digest",
            slotStartedAt: 3_000,
            producerPath: "digest",
            producerKind: "cron",
            invocationId: "inv-2",
            workerVersion: "worker-v1",
            state: "completed",
            statusClass: "ok",
            attemptNo: 1,
            owner: null,
            leaseUntil: null,
            queuedAt: 3_000,
            claimedAt: 3_001,
            startedAt: 3_002,
            lastHeartbeatAt: 3_099,
            finishedAt: 3_100,
            updatedAt: 3_100,
            durationMs: 98_000,
            itemCount: 1,
            stale: false,
            error: null,
          },
        },
      },
    } satisfies Pick<StatusResponse, "producerHeads" | "crons">;

    expect(deriveWorkerVersionEvidence(input)).toEqual({
      status: "observed",
      version: "worker-v2",
      observedAt: 3_500,
      sourceCount: 1,
      sources: ["producer:prices"],
    });
    expect(deriveWorkerVersionEvidence({ producerHeads: [], crons: {} })).toEqual({
      status: "unavailable",
      version: null,
      observedAt: null,
      sourceCount: 0,
      sources: [],
    });
  });
});
