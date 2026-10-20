// @vitest-environment node

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { StatusPageAction } from "@shared/lib/api-endpoints";
import {
  buildActionReadiness,
  extractStructuredActionOutcome,
  getSafeActionFollowUpHref,
  reconcileActionActivity,
  type AdminActionAuditEntry,
  type SessionActionExecutionLike,
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

function sessionExecution(overrides: Partial<SessionActionExecutionLike> = {}): SessionActionExecutionLike {
  const intentId = overrides.intentId ?? "intent-1";
  return {
    action: action(),
    intentId,
    idempotencyKeyHash: createHash("sha256").update(intentId).digest("hex"),
    scopeLabel: "USD Coin (usdc-circle)",
    status: "succeeded",
    requestInFlight: false,
    ok: true,
    createdAt: 99_000,
    startedAt: 100_000,
    completedAt: 100_000,
    httpStatus: 200,
    ...overrides,
  };
}

function canonicalAudit(intentId = "intent-1", overrides: Partial<AdminActionAuditEntry> = {}): AdminActionAuditEntry {
  return {
    ...auditEntry,
    details: {
      path: "/api/remediate-blacklist-amount-gaps",
      idempotencyKeyHash: createHash("sha256").update(intentId).digest("hex"),
      mode: "live",
    },
    ...overrides,
  };
}

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

  it("reconciles exact shared identity despite different labels, mode text and clocks", () => {
    const session = sessionExecution({ scopeLabel: "USD Coin (usdc-circle) (dry run)", completedAt: 120_000 });
    const persisted = canonicalAudit("intent-1", {
      details: { path: action().path, idempotencyKeyHash: session.idempotencyKeyHash, mode: "dry-run", outcome: "queued" },
      httpStatus: 202,
    });
    const activities = reconcileActionActivity([action()], [session], [persisted]);

    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      id: "persisted:7", actor: "operator@example.com", target: "usdc-circle",
      at: 100_000, status: "queued", httpStatus: 202, source: "persisted",
      session: { scopeLabel: session.scopeLabel, completedAt: 120_000 },
    });
  });

  it.each(["succeeded", "failed"] as const)(
    "retains authoritative persisted %s and local unknown/in-flight context for one identity",
    (outcome) => {
      const session = sessionExecution({ status: "unknown", requestInFlight: true });
      const persisted = canonicalAudit("intent-1", {
        result: outcome === "failed" ? "error" : "ok",
        details: { path: action().path, idempotencyKeyHash: session.idempotencyKeyHash, outcome },
      });
      const activities = reconcileActionActivity([action()], [session], [persisted]);
      expect(activities).toHaveLength(1);
      expect(activities[0]).toMatchObject({
        status: outcome === "failed" ? "error" : "succeeded", actor: "operator@example.com",
        source: "persisted", session: { status: "unknown", requestInFlight: true },
      });
    },
  );

  it("keeps same-second distinct intents and actors separate regardless of dry-run/live labels", () => {
    const session = sessionExecution({ intentId: "dry-run-intent", scopeLabel: "usdc-circle" });
    const persisted = canonicalAudit("live-intent", { actor: "another@example.com" });
    const activities = reconcileActionActivity([action()], [session], [persisted]);
    expect(activities).toHaveLength(2);
    expect(activities.map(({ source, actor }) => [source, actor])).toEqual([
      ["session", null], ["persisted", "another@example.com"],
    ]);
  });

  it("does not match the same hash across different exact action paths", () => {
    const otherAction = action({ path: "/api/another-action" });
    const activities = reconcileActionActivity(
      [action(), otherAction], [sessionExecution({ action: otherAction })], [canonicalAudit()],
    );
    expect(activities).toHaveLength(2);
    expect(activities.map(({ actionPath }) => actionPath)).toEqual([otherAction.path, action().path]);
  });

  it("retains historical identity-absent provenance even at the same target and time", () => {
    const activities = reconcileActionActivity(
      [action()], [sessionExecution({ scopeLabel: "usdc-circle" })], [auditEntry],
    );
    expect(activities).toHaveLength(2);
    expect(activities.map(({ source, session }) => [source, session?.status ?? null])).toEqual([
      ["session", "succeeded"], ["persisted", null],
    ]);
  });

  it("counts repeated canonical evidence once without admitting ready session intents", () => {
    const persisted = canonicalAudit();
    expect(reconcileActionActivity(
      [action()], [sessionExecution({ status: "ready" })], [persisted, persisted],
    )).toMatchObject([{ id: "persisted:7", source: "persisted", session: null }]);
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
