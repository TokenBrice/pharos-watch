import { describe, expect, it } from "vitest";
import type { ApiKeyAuditEntry } from "@pharos/contracts/api-keys";
import type { AdminActionAuditEntry } from "@/lib/actions-workbench-model";
import {
  buildOperationalActivityView,
  sanitizeOperationalDetail,
} from "@/lib/operational-history-model";

const adminLifecycle: AdminActionAuditEntry = {
  id: 1,
  at: 1_000,
  actor: "operator@example.invalid",
  action: "api_key_rotate",
  target: "API key 7",
  result: "ok",
  httpStatus: 200,
  details: { apiKeyId: 7, path: "/api/api-keys/7/rotate", token: "ph_live_secret_value" },
};

const credentialLifecycle: ApiKeyAuditEntry = {
  id: 11,
  apiKeyId: 7,
  action: "rotated",
  actor: "admin",
  detail: { name: "Partner reader", secret: "never-render" },
  createdAt: 1_003,
};

describe("operational history model", () => {
  it("orders both source records newest-first without inferring a shared credential event", () => {
    const laterAction: AdminActionAuditEntry = {
      ...adminLifecycle,
      id: 2,
      at: 2_000,
      action: "trigger_digest",
      target: "all recipients",
      details: { status: "queued" },
    };
    const view = buildOperationalActivityView([adminLifecycle, laterAction], [credentialLifecycle]);

    expect(view.rawEntryCount).toBe(3);
    expect(view.entries).toHaveLength(3);
    expect(view.entries.map((entry) => entry.id)).toEqual([
      "admin-action:2",
      "credential-audit:11",
      "admin-action:1",
    ]);
    expect(view.entries[1]).toMatchObject({
      sources: ["credential-audit"],
      target: "Partner reader (API key 7)",
      outcome: "recorded",
      detail: { name: "Partner reader", secret: "[redacted]" },
    });
    expect(view.entries[2]).toMatchObject({
      sources: ["admin-action"],
      outcome: "ok",
      detail: { apiKeyId: 7, path: "/api/api-keys/7/rotate", token: "[redacted]" },
    });
  });

  it.each([false, true])("keeps a failed retry apart from the successful receipt (reversed=%s)", (reversed) => {
    const failed: AdminActionAuditEntry = {
      ...adminLifecycle, id: 2, at: 1_004, result: "error", httpStatus: 400,
      details: { apiKeyId: 7, status: "failed" },
    };
    const attempts = [adminLifecycle, failed];
    const view = buildOperationalActivityView(reversed ? attempts.reverse() : attempts, [
      { ...credentialLifecycle, createdAt: 1_000 },
    ]);
    expect(view.entries.map(({ id, outcome, sources }) => ({ id, outcome, sources }))).toEqual([
      { id: "admin-action:2", outcome: "error", sources: ["admin-action"] },
      { id: "admin-action:1", outcome: "ok", sources: ["admin-action"] },
      { id: "credential-audit:11", outcome: "recorded", sources: ["credential-audit"] },
    ]);
  });

  it.each([false, true])("retains ambiguous nearby successes regardless of enumeration (reversed=%s)", (reversed) => {
    const attempts = [adminLifecycle, { ...adminLifecycle, id: 2, at: 1_001 }];
    const receipts = [credentialLifecycle, { ...credentialLifecycle, id: 12, createdAt: 1_004 }];
    const view = buildOperationalActivityView(
      reversed ? attempts.reverse() : attempts,
      reversed ? receipts.reverse() : receipts,
    );
    expect(view.entries.map((entry) => entry.id)).toEqual([
      "credential-audit:12", "credential-audit:11", "admin-action:2", "admin-action:1",
    ]);
    expect(view.entries.map((entry) => entry.outcome)).toEqual(["recorded", "recorded", "ok", "ok"]);
  });

  it.each([
    { status: "unknown", executionCertainty: "unknown" },
    { status: "failed", reason: "post_write_readback_failed" },
  ])("does not correlate unknown or post-write errors with durable mutation evidence: %j", (details) => {
    const view = buildOperationalActivityView(
      [{ ...adminLifecycle, result: "error", httpStatus: 503, details }],
      [{ ...credentialLifecycle, createdAt: adminLifecycle.at }],
    );
    expect(view.entries).toHaveLength(2);
    expect(view.entries[0]).toMatchObject({
      id: "admin-action:1", outcome: details.status === "unknown" ? "unknown" : "error", httpStatus: 503,
    });
    expect(view.entries[1]).toMatchObject({
      id: "credential-audit:11", outcome: "recorded", httpStatus: null,
    });
  });

  it("keeps even an exact-time single pair separate without shared durable identity", () => {
    const view = buildOperationalActivityView([adminLifecycle], [
      { ...credentialLifecycle, actor: adminLifecycle.actor, createdAt: adminLifecycle.at },
    ]);
    expect(view.entries.map((entry) => entry.sources)).toEqual([["admin-action"], ["credential-audit"]]);
  });

  it("redacts normalized keys and array strings through both public adapters", () => {
    const detail = { "Access_Token": "plain-secret", "api_key_id": 7, values: ["ph_live_hidden", "/api/status"] };
    const view = buildOperationalActivityView(
      [{ ...adminLifecycle, details: detail }],
      [{ ...credentialLifecycle, detail }],
    );
    const safe = { "Access_Token": "[redacted]", "api_key_id": 7, values: ["[redacted]", "/api/status"] };
    expect(view.entries.map((entry) => entry.detail)).toEqual([safe, safe]);
  });

  it("preserves canonical unknown outcomes instead of flattening them to errors", () => {
    const view = buildOperationalActivityView(
      [
        {
          ...adminLifecycle,
          result: "error",
          details: { status: "unknown", executionCertainty: "unknown" },
        },
      ],
      [],
    );

    expect(view.entries[0]?.outcome).toBe("unknown");
  });

  it("redacts credential-bearing keys and token-like strings while preserving safe structure", () => {
    expect(
      sanitizeOperationalDetail({
        apiKeyId: 7,
        token: "plain-secret",
        nested: { authorization: "Bearer abcdefghijklmnop", route: "/api/status" },
        message: "ph_live_abcdefghijklmnop_secret",
        embedded: "token=plain-value",
        header: "Authorization:Bearer embedded-value",
        note: "prefix ph_test_abcdefghijklmnop suffix",
      }),
    ).toEqual({
      apiKeyId: 7,
      token: "[redacted]",
      nested: { authorization: "[redacted]", route: "/api/status" },
      message: "[redacted]",
      embedded: "[redacted]",
      header: "[redacted]",
      note: "[redacted]",
    });
  });
});
