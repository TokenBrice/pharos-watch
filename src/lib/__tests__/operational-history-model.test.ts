import { describe, expect, it } from "vitest";
import type { ApiKeyAuditEntry } from "@shared/types";
import type { AdminActionAuditEntry } from "@/lib/actions-workbench-model";
import { buildOperationalActivityView, sanitizeOperationalDetail } from "@/lib/operational-history-model";

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
  it("merges newest-first and deduplicates the same cross-source credential lifecycle event", () => {
    const laterAction: AdminActionAuditEntry = {
      ...adminLifecycle,
      id: 2,
      at: 2_000,
      action: "trigger_digest",
      target: "all recipients",
      details: { status: "queued" },
    };
    const view = buildOperationalActivityView([adminLifecycle, laterAction], [credentialLifecycle]);

    expect(view).toMatchObject({ rawEntryCount: 3, deduplicatedCount: 1 });
    expect(view.entries).toHaveLength(2);
    expect(view.entries.map((entry) => entry.id)).toEqual([
      "admin-action:2",
      "combined:admin-action:1:credential-audit:11",
    ]);
    expect(view.entries[1]).toMatchObject({
      sources: ["admin-action", "credential-audit"],
      target: "Partner reader (API key 7)",
      outcome: "ok",
    });
  });

  it("does not fuzzy-deduplicate different keys, lifecycle verbs, or distant timestamps", () => {
    const view = buildOperationalActivityView(
      [adminLifecycle],
      [
        { ...credentialLifecycle, id: 12, apiKeyId: 8 },
        { ...credentialLifecycle, id: 13, action: "deactivated" },
        { ...credentialLifecycle, id: 14, createdAt: 1_100 },
      ],
    );

    expect(view.entries).toHaveLength(4);
    expect(view.deduplicatedCount).toBe(0);
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

  it("bounds deeply nested, oversized detail payloads", () => {
    const detail = { level1: { level2: { level3: { level4: { level5: { value: "hidden" } } } } } };
    expect(JSON.stringify(sanitizeOperationalDetail(detail))).toContain("[truncated]");
    expect(sanitizeOperationalDetail({ values: Array.from({ length: 25 }, (_, index) => index) })).toMatchObject({
      values: expect.arrayContaining(["[5 more items]"]),
    });
  });
});
