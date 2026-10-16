// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { StatusPageAction } from "@shared/lib/api-endpoints";
import {
  buildActionReadiness,
  extractStructuredActionOutcome,
  getSafeActionFollowUpHref,
  reconcileActionActivity,
  type AdminActionAuditEntry,
} from "@/lib/actions-workbench-model";
import type { ActionReadinessCheck } from "@/lib/status/admin-ops-insights";

function action(overrides: Partial<StatusPageAction> = {}): StatusPageAction {
  return {
    label: "Backfill Supply",
    path: "/api/remediate-blacklist-amount-gaps",
    confirm: "Run it?",
    destructive: false,
    method: "POST",
    acceptsStablecoinFilter: true,
    group: "recovery",
    kind: "backfill",
    risk: "moderate",
    scope: {
      type: "asset-or-batch",
      assetIdentifier: "stablecoin-id",
      assetLabel: "Stablecoin ID",
      assetPlaceholder: "e.g. usdc-circle",
      batchLabel: "Bounded registry batch",
      queryParam: "stablecoin",
    },
    dryRun: { supported: false, default: false, liveSupported: true },
    expectedDuration: "Several minutes",
    preconditions: ["Inspect the missing range."],
    blockedBy: ["D1 is unavailable."],
    resultMode: "continuation",
    ...overrides,
  };
}

const auditEntry: AdminActionAuditEntry = {
  id: 7,
  at: 100,
  actor: "operator@example.com",
  action: "remediate-blacklist-amount-gaps",
  target: "usdc-circle",
  result: "ok",
  httpStatus: 200,
  details: null,
};

describe("actions workbench model", () => {
  it("preserves canonical unknown outcomes from persisted audit details", () => {
    const activities = reconcileActionActivity(
      [action()],
      [],
      [
        {
          ...auditEntry,
          result: "error",
          details: { status: "unknown", outcome: "unknown", executionCertainty: "unknown" },
        },
      ],
    );

    expect(activities[0]?.status).toBe("unknown");
  });

  it("blocks stale or unhealthy evidence only for live writes and exposes no override", () => {
    const checks: ActionReadinessCheck[] = [
      { id: "fresh-status-view", label: "Dashboard data", state: "watch", detail: "Refresh first." },
      { id: "public-health", label: "Public health", state: "blocked", detail: "Health is stale." },
      { id: "d1-writes", label: "D1 write path", state: "blocked", detail: "D1 is unhealthy." },
    ];
    const dryRunAction = action({
      dryRun: { supported: true, default: true, liveSupported: true, queryParam: "dryRun" },
    });
    expect(buildActionReadiness(dryRunAction, checks, "live")).toMatchObject({
      blocked: true,
      overrideAvailable: false,
    });
    expect(buildActionReadiness(dryRunAction, checks, "dry-run")).toMatchObject({
      blocked: false,
      overrideAvailable: false,
    });
  });

  it("extracts status, job, queue, continuation, and follow-up from structured results", () => {
    expect(
      extractStructuredActionOutcome(
        { status: "queued", jobId: "job-42", queueId: "queue-a", nextCursor: "cursor-9", followUpUrl: "/admin/crons" },
        "queued",
      ),
    ).toEqual({
      headline: "Action queued",
      fields: [
        { label: "Status", value: "queued" },
        { label: "Job", value: "job-42" },
        { label: "Queue", value: "queue-a" },
        { label: "Continuation", value: "cursor-9" },
      ],
      followUp: "/admin/crons",
    });
  });

  it.each([null, undefined, "response", 0, false])(
    "keeps certainty-based headlines for a non-record body %s",
    (body) => {
      expect(extractStructuredActionOutcome(body, "unknown")).toEqual({
        headline: "Outcome needs reconciliation", fields: [], followUp: null,
      });
      expect(extractStructuredActionOutcome(body, "failed").headline).toBe("Action failed");
      expect(extractStructuredActionOutcome(body, "succeeded").headline).toBe("Action completed");
    },
  );

  it("does not let structured response status override unknown or failed certainty", () => {
    expect(extractStructuredActionOutcome({ status: "completed" }, "unknown").headline)
      .toBe("Outcome needs reconciliation");
    expect(extractStructuredActionOutcome({ status: "completed" }, "failed").headline).toBe("Action failed");
  });

  it("allows only single-slash internal or explicit HTTP(S) follow-up links", () => {
    expect(getSafeActionFollowUpHref("/admin/crons")).toBe("/admin/crons");
    expect(getSafeActionFollowUpHref("https://ops.example.com/jobs/42")).toBe("https://ops.example.com/jobs/42");
    expect(getSafeActionFollowUpHref("//evil.example/jobs/42")).toBeNull();
    expect(getSafeActionFollowUpHref("/\\evil.example/jobs/42")).toBeNull();
    expect(getSafeActionFollowUpHref("javascript:alert(1)")).toBeNull();
  });
});
