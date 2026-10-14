import { describe, expect, it } from "vitest";
import type { StatusCause, StatusResponse, StatusTransition } from "@shared/types";
import { makeHealthyStatusResponse } from "@/test-utils/status-fixtures";
import { normalizeStatusIssues } from "@/lib/status/issue-evidence-model";
import {
  buildTriageHeadline,
  buildTriageInbox,
  describeRecoveryHold,
  describeSelfCheck,
  formatRecurrence,
  readSlowestProbePath,
} from "@/lib/status/triage-inbox";

const NOW = 1_700_000_000;
const CURRENT_EVIDENCE = { state: "current" as const, staleLabels: [], missingLabels: [] };

const cronCause: StatusCause = {
  code: "unhealthy_crons_present",
  layer: "availability",
  severity: "warning",
  message: "1 availability-impacting cron job(s) are unavailable/stale. Jobs: sync-fx-rates.",
  subjects: ["sync-fx-rates"],
};
// Admin-only warning (not in the public-impact allowlist) naming a cron job.
const adminWarning: StatusCause = {
  code: "reserve_sync_degraded",
  layer: "data-quality",
  severity: "warning",
  message: "Reserve sync is degraded. Jobs: sync-fx-rates.",
  subjects: ["sync-fx-rates"],
};
const infoCause: StatusCause = {
  code: "watch_unhealthy_crons_present",
  layer: "availability",
  severity: "info",
  message: "1 watch-tier cron job(s) are unavailable/stale.",
};

function transition(at: number, causes: StatusCause[], transitionType: StatusTransition["transitionType"] = "degrade"): StatusTransition {
  return {
    id: at,
    scope: "global",
    from: transitionType === "degrade" ? "healthy" : "degraded",
    to: transitionType === "degrade" ? "degraded" : "healthy",
    rawStatus: "degraded",
    transitionType,
    reason: "test",
    confidence: 1,
    causes,
    at,
  };
}

function withCauses(causes: StatusCause[], timeline: StatusTransition[] = []): StatusResponse {
  const base = makeHealthyStatusResponse();
  const cron = Object.values(base.crons)[0]!;
  return {
    ...base,
    causes: { availability: causes, dataQuality: [], overall: causes },
    timeline,
    crons: { ...base.crons, "sync-fx-rates": { ...cron, expectedIntervalSec: 3600 } },
  };
}

describe("buildTriageInbox", () => {
  it("collapses info watches and links named cron jobs to their Crons row", () => {
    const data = withCauses([adminWarning, infoCause]);
    const inbox = buildTriageInbox(normalizeStatusIssues(data.causes), data);

    expect(inbox.act).toHaveLength(0);
    expect(inbox.watch.map((item) => item.issue.code)).toEqual(["reserve_sync_degraded"]);
    expect(inbox.informational.map((item) => item.issue.code)).toEqual(["watch_unhealthy_crons_present"]);
    const [watch] = inbox.watch;
    expect(watch!.link).toEqual({ href: "/admin/crons/?job=sync-fx-rates", label: "Open cron", external: false });
    // The fixture cron last started inside its cadence, so it names the next run, not "Runs every".
    expect(watch!.timing).toMatch(/^Next primary opportunity in /);
    expect(buildTriageHeadline(inbox, CURRENT_EVIDENCE)).toEqual({ verdict: "watch", text: "Nothing needs action. Watching 2." });
  });

  it("names an overdue cron against its stale budget and falls back to the last successful run", () => {
    const base = withCauses([adminWarning]);
    const cron = base.crons["sync-fx-rates"]!;
    const data: StatusResponse = {
      ...base,
      crons: {
        ...base.crons,
        "sync-fx-rates": {
          ...cron,
          inFlight: null,
          expectedIntervalSec: 900,
          lastRun: { startedAt: base.timestamp - 3600, durationMs: 1, status: "error" },
          recentRuns: [
            { startedAt: base.timestamp - 3600, durationMs: 1, status: "error" },
            { startedAt: base.timestamp - 4500, durationMs: 1, status: "ok" },
          ],
        },
      },
    };
    const [item] = buildTriageInbox(normalizeStatusIssues(data.causes), data).watch;
    // Upcoming registry opportunity remains separate from the missed-run budget.
    expect(item!.timing).toBe("Next primary opportunity in 1m (budget 30m)");
    // No transition carries the cause, so the age comes from the last successful run.
    expect(item!.sinceSec).toBeNull();
    expect(item!.lastSuccessSec).toBe(base.timestamp - 4500);
  });

  it("marks a public-impacting cause as act and names the job in the top line", () => {
    const data = withCauses([cronCause]);
    const inbox = buildTriageInbox(normalizeStatusIssues(data.causes), data);
    expect(inbox.act).toHaveLength(1);
    expect(buildTriageHeadline(inbox, CURRENT_EVIDENCE).text).toBe(`Act on 1: ${inbox.act[0]!.subject}.`);
    expect(inbox.act[0]!.subject).not.toMatch(/cron job\(s\)/);
  });

  it("promotes an admin warning that degraded the state repeatedly to act, with recurrence and since", () => {
    const timeline = [
      transition(NOW - 600, [adminWarning]),
      transition(NOW - 4 * 3600, [adminWarning], "recover"),
      transition(NOW - 5 * 3600, [adminWarning]),
      transition(NOW - 9 * 3600, [adminWarning]),
      transition(NOW - 60 * 3600, [adminWarning]),
    ];
    const data = withCauses([adminWarning], timeline);
    const inbox = buildTriageInbox(normalizeStatusIssues(data.causes), data);

    expect(inbox.act).toHaveLength(1);
    expect(inbox.act[0]!.recurrence).toBe(3);
    expect(formatRecurrence(inbox.act[0]!.recurrence)).toBe("3× in 48h");
    expect(inbox.act[0]!.sinceSec).toBe(NOW - 60 * 3600);
    expect(buildTriageHeadline(inbox, CURRENT_EVIDENCE).text).toMatch(/^Act on 1: .+\.$/);
  });

  it("reports nothing to do on a clean status and refuses to answer on stale evidence", () => {
    const data = withCauses([]);
    const inbox = buildTriageInbox([], data);
    expect(buildTriageHeadline(inbox, CURRENT_EVIDENCE)).toEqual({ verdict: "ok", text: "Nothing needs action." });
    expect(buildTriageHeadline(inbox, { state: "stale", staleLabels: ["Public health"], missingLabels: [] }).verdict).toBe(
      "unavailable",
    );
  });
});

describe("describeRecoveryHold", () => {
  it("states the recovery time and the k/N confirmation progress", () => {
    const base = makeHealthyStatusResponse();
    const selfCheckRun = { startedAt: NOW - 1800, durationMs: 1, status: "ok" as const };
    const data: StatusResponse = {
      ...base,
      state: { ...base.state, currentStatus: "degraded", rawStatus: "healthy", consecutiveRaw: { healthy: 2, degraded: 0, stale: 0 } },
      crons: {
        ...base.crons,
        "status-self-check": {
          ...Object.values(base.crons)[0]!,
          recentRuns: [{ ...selfCheckRun, startedAt: NOW - 600 }, selfCheckRun],
        },
      },
    };
    expect(describeRecoveryHold(data)).toBe("Recovered 30m ago; confirming (needs 3 consecutive healthy checks, 2/3).");
    expect(describeRecoveryHold(base)).toBeNull();
  });
});

describe("describeSelfCheck", () => {
  it("names latency instead of printing degraded (n/n)", () => {
    const probe = { timestamp: NOW, status: "degraded" as const, sampleCount: 17, passCount: 17, failCount: 0, p95LatencyMs: 5182 };
    const crons = {
      "status-self-check": {
        ...Object.values(makeHealthyStatusResponse().crons)[0]!,
        lastRun: { startedAt: NOW, durationMs: 1, status: "ok" as const, metadata: { slowestProbes: [{ path: "/api/depeg-resolver", latencyMs: 5182 }] } },
      },
    };
    expect(describeSelfCheck(probe, readSlowestProbePath(crons))).toBe(
      "All 17 probes pass; slow: p95 5.2 s (budget 5 s) on /api/depeg-resolver",
    );
    expect(describeSelfCheck({ ...probe, status: "healthy", p95LatencyMs: 80 }, null)).toBe("All 17 probes pass");
    expect(describeSelfCheck({ ...probe, failCount: 2, passCount: 15 }, null)).toBe("2 of 17 probes failing");
  });
});
