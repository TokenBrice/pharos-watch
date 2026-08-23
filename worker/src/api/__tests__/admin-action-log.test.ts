import { readJsonResponse } from "./api-request-response.test-support";
import { describe, expect, it } from "vitest";
import { handleAdminActionLog } from "../admin-action-log";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";

function makeDbWith(rows: Array<Record<string, unknown>>) {
  return mockD1([
    {
      match: "FROM admin_action_audit",
      rows,
    },
  ]);
}

interface BodyEntry {
  id: number;
  at: number;
  actor: string;
  action: string;
  target: string | null;
  result: "ok" | "error";
  httpStatus: number | null;
  details: unknown;
}

function buildRequest(query = ""): { request: Request; url: URL } {
  const url = new URL(`https://ops-api.pharos.watch/api/admin-action-log${query}`);
  const request = new Request(url.toString(), { method: "GET" });
  return { request, url };
}

describe("handleAdminActionLog", () => {
  it("returns entries newest-first and exposes all fields", async () => {
    const db = makeDbWith([
      {
        id: 2,
        created_at: 2000,
        actor: "alice@pharos.watch",
        action: "reset-blacklist-sync",
        target: null,
        result: "ok",
        http_status: 200,
        details_json: JSON.stringify({ note: "manual" }),
      },
      {
        id: 1,
        created_at: 1000,
        actor: "internal",
        action: "trigger-digest",
        target: null,
        result: "error",
        http_status: 500,
        details_json: null,
      },
    ]);

    const { request, url } = buildRequest();
    const res = await handleAdminActionLog({ db, url, request, trustedAdmin: true });
    const body = await readJsonResponse(res, 200) as { entries: BodyEntry[] };
    expect(body.entries).toHaveLength(2);
    expect(body.entries[0]).toMatchObject({
      id: 2,
      at: 2000,
      actor: "alice@pharos.watch",
      action: "reset-blacklist-sync",
      result: "ok",
      httpStatus: 200,
      details: { note: "manual" },
    });
    expect(body.entries[1]).toMatchObject({
      id: 1,
      at: 1000,
      actor: "internal",
      action: "trigger-digest",
      result: "error",
      httpStatus: 500,
      details: null,
    });
    // Newest-first: index 0's at > index 1's at
    expect(body.entries[0].at).toBeGreaterThan(body.entries[1].at);
  });

  it("defaults limit to 50 when unspecified", async () => {
    const db = makeDbWith([]);
    const { request, url } = buildRequest();
    await handleAdminActionLog({ db, url, request, trustedAdmin: true });

    const history = db.getHistory();
    const select = history.find((row) => row.sql.includes("FROM admin_action_audit"));
    expect(select).toBeDefined();
    expect(select?.binds[0]).toBe(50);
  });

  it("clamps limit above 200 down to 200", async () => {
    const db = makeDbWith([]);
    const { request, url } = buildRequest("?limit=9999");
    await handleAdminActionLog({ db, url, request, trustedAdmin: true });

    const history = db.getHistory();
    const select = history.find((row) => row.sql.includes("FROM admin_action_audit"));
    expect(select?.binds[0]).toBe(200);
  });

  it("clamps limit below 1 up to 1", async () => {
    const db = makeDbWith([]);
    const { request, url } = buildRequest("?limit=0");
    await handleAdminActionLog({ db, url, request, trustedAdmin: true });

    const history = db.getHistory();
    const select = history.find((row) => row.sql.includes("FROM admin_action_audit"));
    expect(select?.binds[0]).toBe(1);
  });

  it("tolerates malformed details_json by returning null", async () => {
    const db = makeDbWith([
      {
        id: 3,
        created_at: 3000,
        actor: "alice@pharos.watch",
        action: "reset-blacklist-sync",
        target: null,
        result: "ok",
        http_status: 200,
        details_json: "{not-json",
      },
    ]);

    const { request, url } = buildRequest();
    const res = await handleAdminActionLog({ db, url, request, trustedAdmin: true });
    const body = await res.json() as { entries: BodyEntry[] };
    expect(body.entries[0]?.details).toBeNull();
  });
});
