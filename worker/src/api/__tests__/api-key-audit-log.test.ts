import { describe, expect, it } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { handleApiKeyAuditLog } from "../api-key-audit-log";

describe("api-key-audit-log handler", () => {
  it("requires admin auth", async () => {
    const db = mockD1([]);
    const request = new Request("https://api.pharos.watch/api/api-keys/audit-log");
    const response = await handleApiKeyAuditLog(db, false, request);
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
    const response = await handleApiKeyAuditLog(db, true, request);
    expect(response.status).toBe(200);

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
    const response = await handleApiKeyAuditLog(db, true, request);
    expect(response.status).toBe(200);
  });
});
