import { describe, expect, it } from "vitest";
import type { StatusTransition } from "@shared/types";
import {
  DEFAULT_INCIDENT_HISTORY_QUERY,
  buildIncidentHistoryView,
  foldIncidentEpisodes,
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
  it("cannot assess flapping from an unavailable transition count", () => {
    expect(buildIncidentHistoryView(transitions(), NOW_SECONDS, null, DEFAULT_INCIDENT_HISTORY_QUERY))
      .toMatchObject({ transitionsLast24h: null, isFlapping: null });
  });
});

function flap(id: number, at: number, to: StatusTransition["to"], subjects?: string[]): StatusTransition {
  const from: StatusTransition["from"] = to === "healthy" ? "degraded" : "healthy";
  return {
    id,
    scope: "global",
    from,
    to,
    rawStatus: to,
    transitionType: to === "healthy" ? "recover" : "degrade",
    reason: "fixture",
    confidence: 1,
    causes:
      to === "healthy"
        ? []
        : [
            {
              code: "unhealthy_crons_present",
              layer: "availability",
              severity: "warning",
              message: subjects ? "1 availability-impacting cron job(s) are unavailable/stale." : "1 cron job is stale. Jobs: sync-mint-burn.",
              ...(subjects ? { subjects } : {}),
            },
          ],
    at,
  };
}

describe("incident folding and recurrence", () => {
  it("keeps an incident that began before the loaded window with an unknown duration and unknown causes", () => {
    const [episode] = foldIncidentEpisodes([flap(9, 500, "healthy")], 4_000);
    expect(episode).toMatchObject({
      startedAt: null, durationSec: null, endedAt: 500, ongoing: false, causeCodes: null,
    });
  });

  it("derives a window-start recovery's worst state from the state it recovered from", () => {
    const [episode] = foldIncidentEpisodes([{
      ...flap(9, 500, "healthy"),
      from: "stale",
      causes: [{
        code: "onchain_monitor_low_sample",
        layer: "data-quality",
        severity: "info",
        message: "Recovery-time observation.",
      }],
    }], 4_000);
    expect(episode).toMatchObject({ startedAt: null, worstState: "stale", causeCodes: null });
  });

  it("treats an escalation as the oldest loaded row as an incident that began earlier", () => {
    const [episode] = foldIncidentEpisodes([{ ...flap(1, 3_000, "stale"), from: "degraded" }], 4_000);
    expect(episode).toMatchObject({ startedAt: null, durationSec: null, ongoing: true });
  });
});
