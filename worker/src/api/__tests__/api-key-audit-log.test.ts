import { describe, expect, it, vi } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { handleApiKeyAuditLog } from "../api-key-audit-log";

describe("api-key-audit-log handler", () => {
  it("requires admin auth", async () => {
    const db = mockD1([]);
    const request = new Request("https://api.pharos.watch/api/api-keys/audit-log");
    const response = await handleApiKeyAuditLog({ db, trustedAdmin: false, request });
    expect(response.status).toBe(401);
  });

  it("returns recent audit entries", async () => {
    const db = mockD1([
      {
        match: "FROM api_key_audit_log",
        rows: [
          {
            id: 1,
            api_key_id: 7,
            action: "created",
            actor: "admin",
            detail_json: '{"name":"Smoke"}',
            created_at: 1000,
          },
        ],
      },
    ]);

    const request = new Request("https://api.pharos.watch/api/api-keys/audit-log");
    const response = await handleApiKeyAuditLog({ db, trustedAdmin: true, request });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");

    const body = await response.json() as { entries: Array<{ action: string; detail: unknown }> };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]?.action).toBe("created");
    expect(body.entries[0]?.detail).toEqual({ name: "Smoke" });
  });

  it("filters by apiKeyId when provided", async () => {
    const db = mockD1([
      {
        match: "WHERE api_key_id = ?",
        matchBinds: [7, 50],
        rows: [],
      },
    ], { requireMatch: true });

    const request = new Request("https://api.pharos.watch/api/api-keys/audit-log?apiKeyId=7");
    const response = await handleApiKeyAuditLog({ db, trustedAdmin: true, request });
    expect(response.status).toBe(200);
  });

  it("rejects partially numeric limit filters", async () => {
    const db = mockD1([], { requireMatch: true });
    const request = new Request("https://api.pharos.watch/api/api-keys/audit-log?limit=25abc");

    const response = await handleApiKeyAuditLog({ db, trustedAdmin: true, request });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid limit: must be a positive integer" });
  });

  it("rejects invalid apiKeyId filters instead of broadening the query", async () => {
    const db = mockD1([], { requireMatch: true });
    const request = new Request("https://api.pharos.watch/api/api-keys/audit-log?apiKeyId=7abc");

    const response = await handleApiKeyAuditLog({ db, trustedAdmin: true, request });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid apiKeyId: must be a positive integer" });
  });

  it("keeps the handler healthy when detail_json is malformed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = mockD1([
      {
        match: "FROM api_key_audit_log",
        rows: [
          {
            id: 2,
            api_key_id: 7,
            action: "updated",
            actor: "admin",
            detail_json: "{bad-json",
            created_at: 1001,
          },
        ],
      },
    ]);

    const request = new Request("https://api.pharos.watch/api/api-keys/audit-log");
    const response = await handleApiKeyAuditLog({ db, trustedAdmin: true, request });

    expect(response.status).toBe(200);
    const body = await response.json() as { entries: Array<{ detail: unknown }> };
    expect(body.entries[0]?.detail).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "[api-key-audit-log] Failed to parse detail_json for row 2:",
      expect.any(String),
    );
  });
});
