import { describe, expect, it } from "vitest";
import type { StatusPageAction } from "@shared/lib/api-endpoints";
import {
  auditEntryMatchesAction,
  buildActionReadiness,
  extractStructuredActionOutcome,
  filterActionCatalog,
  getSafeActionFollowUpHref,
  getActionIntentCategory,
  reconcileActionActivity,
  type AdminActionAuditEntry,
  type SessionActionExecutionLike,
} from "@/lib/actions-workbench-model";
import type { ActionReadinessCheck } from "@/lib/status/admin-ops-insights";

function action(overrides: Partial<StatusPageAction> = {}): StatusPageAction {
  return {
    label: "Backfill Supply",
    path: "/api/backfill-supply-history",
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
  action: "backfill-supply-history",
  target: "usdc-circle",
  result: "ok",
  httpStatus: 200,
  details: null,
};

describe("actions workbench model", () => {
  it("classifies all five operator intent groups", () => {
    expect(getActionIntentCategory(action({ kind: "inspect", risk: "read-only" }))).toBe("inspect");
    expect(
      getActionIntentCategory(
        action({ dryRun: { supported: true, default: true, liveSupported: true, queryParam: "dryRun" } }),
      ),
    ).toBe("dry-run");
    expect(getActionIntentCategory(action())).toBe("recovery");
    expect(getActionIntentCategory(action({ kind: "communication" }))).toBe("communications");
    expect(getActionIntentCategory(action({ kind: "reset", destructive: true }))).toBe("destructive");
  });

  it("searches metadata and composes intent and risk filters", () => {
    const inspect = action({
      label: "Validate DEWS",
      path: "/api/backfill-dews",
      kind: "inspect",
      risk: "read-only",
      preconditions: ["Completed depeg events must exist."],
    });
    expect(
      filterActionCatalog([action(), inspect], { query: "completed events", intent: "inspect", risk: "read-only" }),
    ).toEqual([inspect]);
    expect(filterActionCatalog([action(), inspect], { query: "", intent: "all", risk: "moderate" })).toEqual([
      action(),
    ]);
  });

  it("matches persisted action names to catalog paths without fuzzy collisions", () => {
    expect(auditEntryMatchesAction(auditEntry, action())).toBe(true);
    expect(auditEntryMatchesAction({ ...auditEntry, action: "backfill-supply" }, action())).toBe(false);
    expect(
      auditEntryMatchesAction(
        { ...auditEntry, action: "wrapper", details: { actionPath: "/api/backfill-supply-history" } },
        action(),
      ),
    ).toBe(true);
  });

  it("reconciles persisted and session activity with the session result winning a duplicate", () => {
    const session: SessionActionExecutionLike = {
      action: { path: action().path, label: action().label },
      intentId: "intent-1",
      scopeLabel: "usdc-circle",
      status: "succeeded",
      ok: true,
      createdAt: 99_000,
      startedAt: 99_500,
      completedAt: 100_000,
      httpStatus: 200,
    };
    const activities = reconcileActionActivity([action()], [session], [auditEntry]);
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ source: "session", actionPath: action().path });
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

  it("allows only single-slash internal or explicit HTTP(S) follow-up links", () => {
    expect(getSafeActionFollowUpHref("/admin/crons")).toBe("/admin/crons");
    expect(getSafeActionFollowUpHref("https://ops.example.com/jobs/42")).toBe("https://ops.example.com/jobs/42");
    expect(getSafeActionFollowUpHref("//evil.example/jobs/42")).toBeNull();
    expect(getSafeActionFollowUpHref("/\\evil.example/jobs/42")).toBeNull();
    expect(getSafeActionFollowUpHref("javascript:alert(1)")).toBeNull();
  });
});
