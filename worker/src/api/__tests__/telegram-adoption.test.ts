import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeJsonRequest } from "./api-request-response.test-support";
import { handleTelegramAdoption } from "../telegram-adoption";
import { mockD1, type MockD1Database } from "../../test-helpers/__shared/mock-d1";
import type { FullRouteContext } from "../../routes/shared";
import { getRouteMatch } from "../../routes/registry";

function request(body: unknown, headers: HeadersInit = {}): Request {
  return makeJsonRequest("https://site-api.pharos.watch/api/telegram-adoption", body, {
    headers: {
      Origin: "https://pharos.watch",
      "X-Pharos-Telegram-Adoption-Client-Hash": "0123456789abcdef0123456789abcdef",
      ...headers,
    },
  });
}

function context(db: MockD1Database, req: Request): FullRouteContext {
  return {
    db,
    request: req,
    url: new URL(req.url),
    execCtx: {} as ExecutionContext,
    trustedAdmin: false,
  };
}

function quotaDb(): MockD1Database {
  return mockD1([
    { match: "telegram_adoption_client_quota", rows: [], first: { request_count: 1 } },
    { match: "telegram_adoption_ingress_quota", rows: [], first: { request_count: 1 } },
    { match: "INSERT INTO telegram_adoption_daily", rows: [] },
  ]);
}

describe("Telegram adoption Worker endpoint", () => {
  beforeEach(() => vi.useFakeTimers().setSystemTime(new Date("2026-07-10T12:34:56Z")));
  afterEach(() => vi.useRealTimers());

  it("registers the additive site-api route as POST-only", () => {
    const route = getRouteMatch("/api/telegram-adoption");

    expect(route?.methods).toEqual(["POST"]);
    expect(route?.endpoint).toBeUndefined();
  });

  it("admits a catalog click through per-client and global quotas", async () => {
    const db = quotaDb();
    const result = await handleTelegramAdoption(
      context(db, request({ campaign: "landing", placement: "hero" })),
    );

    expect(result.status).toBe(204);
    const history = db.getHistory();
    expect(history[0].binds).toEqual([
      expect.any(Number),
      "0123456789abcdef0123456789abcdef",
      expect.any(Number),
      10,
    ]);
    expect(history[1].binds).toEqual([expect.any(Number), expect.any(Number), 3_000]);
    expect(history[2].binds).toEqual([
      "2026-07-10",
      "landing",
      "hero",
      "cta_click",
      "",
      "",
      "success",
      expect.any(Number),
      expect.any(Number),
    ]);
  });

  it("rejects foreign origins and arbitrary placements before D1", async () => {
    const db = quotaDb();
    expect(
      (
        await handleTelegramAdoption(
          context(db, request({ campaign: "landing", placement: "hero" }, { Origin: "https://evil.example" })),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await handleTelegramAdoption(
          context(db, request({ campaign: "landing", placement: "custom" })),
        )
      ).status,
    ).toBe(400);
    expect(db.getHistory()).toHaveLength(0);
  });

  it("rejects an exhausted per-client quota before consuming the global quota", async () => {
    const db = mockD1([
      { match: "telegram_adoption_client_quota", rows: [], first: null },
    ]);

    const result = await handleTelegramAdoption(
      context(db, request({ campaign: "landing", placement: "hero" })),
    );

    expect(result.status).toBe(429);
    expect(result.headers.get("Retry-After")).toBe("60");
    expect(db.getHistory()).toHaveLength(1);
  });

  it("passes an exhausted global quota after the client reservation", async () => {
    const db = mockD1([
      { match: "telegram_adoption_client_quota", rows: [], first: { request_count: 1 } },
      { match: "telegram_adoption_ingress_quota", rows: [], first: null },
    ]);

    const result = await handleTelegramAdoption(
      context(db, request({ campaign: "landing", placement: "hero" })),
    );

    expect(result.status).toBe(429);
    expect(db.getHistory()).toHaveLength(2);
  });

  it("fails closed when the forwarded client-IP hash is missing", async () => {
    const db = quotaDb();
    const result = await handleTelegramAdoption(
      context(db, request({ campaign: "landing", placement: "hero" }, {
        "X-Pharos-Telegram-Adoption-Client-Hash": "",
      })),
    );

    expect(result.status).toBe(503);
    expect(db.getHistory()).toHaveLength(0);
  });

  it("returns 500 when the aggregate write fails", async () => {
    const db = mockD1([
      { match: "telegram_adoption_client_quota", rows: [], first: { request_count: 1 } },
      { match: "telegram_adoption_ingress_quota", rows: [], first: { request_count: 1 } },
      { match: "INSERT INTO telegram_adoption_daily", rows: [], throwError: new Error("D1 unavailable") },
    ]);

    const result = await handleTelegramAdoption(
      context(db, request({ campaign: "landing", placement: "hero" })),
    );

    expect(result.status).toBe(500);
  });
});
