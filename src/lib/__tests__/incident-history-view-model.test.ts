import { describe, expect, it } from "vitest";
import type { StatusTransition } from "@shared/types";
import {
  DEFAULT_INCIDENT_HISTORY_QUERY,
  buildIncidentHistoryUrl,
  buildIncidentHistoryView,
  buildIncidentRecurrence,
  findFirstDegradationAfter,
  foldIncidentEpisodes,
  getCauseSubjects,
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
  it("cannot assess flapping from an unavailable transition count", () => {
    expect(buildIncidentHistoryView(transitions(), NOW_SECONDS, null, DEFAULT_INCIDENT_HISTORY_QUERY))
      .toMatchObject({ transitionsLast24h: null, isFlapping: null });
  });
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

  it("requires each filter independently while the other three match", () => {
    const matching = {
      severity: "critical", surface: "system", causeCode: "db_unhealthy", publicImpact: "impacting",
    } as const;
    const mismatches = [
      { severity: "warning" },
      { surface: "availability" },
      { causeCode: "cache_ratio_degraded" },
      { publicImpact: "not-impacting" },
    ] as const;
    for (const mismatch of mismatches) {
      expect(buildIncidentHistoryView(transitions(), NOW_SECONDS, 0, {
        ...matching, ...mismatch,
      }).rows, JSON.stringify(mismatch)).toEqual([]);
    }
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
  it("reads subjects from the structured field, falling back to the message suffix", () => {
    expect(getCauseSubjects({ subjects: ["a"], message: "x. Jobs: b." })).toEqual(["a"]);
    expect(getCauseSubjects({ message: "2 stale. Jobs: sync-a, sync-b." })).toEqual(["sync-a", "sync-b"]);
    expect(getCauseSubjects({ message: "No jobs named." })).toEqual([]);
  });

  it("folds degrade/recover pairs into incidents with duration and an ongoing tail", () => {
    const episodes = foldIncidentEpisodes(
      [flap(1, 1_000, "degraded"), flap(2, 1_600, "healthy"), flap(3, 3_000, "degraded"), flap(4, 3_100, "stale")],
      4_000,
    );
    expect(episodes).toHaveLength(2);
    expect(episodes[0]).toMatchObject({ ongoing: true, startedAt: 3_000, durationSec: 1_000, worstState: "stale", transitionCount: 2 });
    expect(episodes[1]).toMatchObject({ ongoing: false, startedAt: 1_000, endedAt: 1_600, durationSec: 600 });
  });

  it("derives the episode verdict from its causes with the triage rule", () => {
    // Public-impacting warning cause: act.
    expect(foldIncidentEpisodes([flap(1, 1_000, "degraded")], 4_000)[0]?.verdict).toBe("act");
    // Info-only causes never open an act-now episode, even while ongoing.
    const infoOnly = { ...flap(2, 1_000, "degraded"), causes: [
      { code: "watch_unhealthy_crons_present", layer: "availability" as const, severity: "info" as const, message: "watch tier" },
    ] };
    expect(foldIncidentEpisodes([infoOnly], 4_000)[0]?.verdict).toBe("watch");
    // Admin-only warning (not in the public-impact allowlist): watch.
    const adminWarning = { ...flap(3, 1_000, "degraded"), causes: [
      { code: "reserve_sync_degraded", layer: "data-quality" as const, severity: "warning" as const, message: "reserve" },
    ] };
    expect(foldIncidentEpisodes([adminWarning], 4_000)[0]?.verdict).toBe("watch");
  });

  it("keeps an incident that began before the loaded window with an unknown duration", () => {
    const [episode] = foldIncidentEpisodes([flap(9, 500, "healthy")], 4_000);
    expect(episode).toMatchObject({ startedAt: null, durationSec: null, endedAt: 500, ongoing: false });
  });

  it("treats an escalation as the oldest loaded row as an incident that began earlier", () => {
    const [episode] = foldIncidentEpisodes([{ ...flap(1, 3_000, "stale"), from: "degraded" }], 4_000);
    expect(episode).toMatchObject({ startedAt: null, durationSec: null, ongoing: true });
  });

  it("drops the overflow count from parsed subjects", () => {
    expect(getCauseSubjects({ message: "9 stale. Jobs: a, b, c, d, e, f and 3 more." })).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("groups repeated incident starts by cause code and named subjects", () => {
    const groups = buildIncidentRecurrence([
      flap(1, 0, "degraded"),
      flap(2, 2_700, "healthy"),
      flap(3, 14_400, "degraded", ["sync-mint-burn"]),
      flap(4, 17_100, "healthy"),
      flap(5, 28_800, "degraded", ["sync-mint-burn"]),
      flap(6, 30_000, "degraded", ["other-job"]),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      causeCode: "unhealthy_crons_present",
      subjects: ["sync-mint-burn"],
      count: 3,
      meanIntervalSec: 14_400,
    });
  });

  it("ignores info causes that ride along on every incident", () => {
    const withInfo = (id: number, at: number) => ({
      ...flap(id, at, "degraded", ["sync-mint-burn"]),
      causes: [
        ...flap(id, at, "degraded", ["sync-mint-burn"]).causes,
        { code: "degraded_cron_warning", layer: "availability" as const, severity: "info" as const, message: "2 cron job(s) report warnings." },
      ],
    });
    const groups = buildIncidentRecurrence([withInfo(1, 0), flap(2, 100, "healthy"), withInfo(3, 200)]);
    expect(groups.map((group) => group.causeCode)).toEqual(["unhealthy_crons_present"]);
  });
});
