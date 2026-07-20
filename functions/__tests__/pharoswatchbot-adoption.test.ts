import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onRequest } from "../pharoswatchbot-adoption";
import { createMockD1 } from "./helpers/mock-d1";

function request(body: unknown, headers: HeadersInit = {}): Request {
  return new Request("https://pharos.watch/pharoswatchbot-adoption", {
    method: "POST",
    headers: {
      Origin: "https://pharos.watch",
      "Content-Type": "application/json",
      "CF-Connecting-IP": "203.0.113.10",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("PharosWatchBot adoption Pages Function", () => {
  beforeEach(() => vi.useFakeTimers().setSystemTime(new Date("2026-07-10T12:34:56Z")));
  afterEach(() => vi.useRealTimers());

  it("admits a catalog click through per-client and global quotas", async () => {
    const db = createMockD1([
      { match: "telegram_adoption_client_quota", first: { request_count: 1 } },
      { match: "telegram_adoption_ingress_quota", first: { request_count: 1 } },
      { match: "INSERT INTO telegram_adoption_daily", run: { success: true } },
    ]);
    const result = await onRequest({
      request: request({ campaign: "landing", placement: "hero" }),
      env: { DB: db, TELEGRAM_ADOPTION_IP_HASH_SECRET: "test-secret" },
    });

    expect(result.status).toBe(204);
    const history = db.getHistory();
    expect(history[0].binds).toEqual([
      expect.any(Number),
      expect.stringMatching(/^[0-9a-f]{32}$/),
      expect.any(Number),
      10,
    ]);
    expect(history[1].binds).toEqual([expect.any(Number), expect.any(Number), 3_000]);
    expect(history[2].binds).toEqual(["2026-07-10", "landing", "hero", expect.any(Number), expect.any(Number)]);
    expect(history.flatMap((entry) => entry.binds)).not.toContain(expect.stringMatching(/user|chat|referer/i));
  });

  it("rejects foreign origins, arbitrary placements, and exhausted global quota", async () => {
    const db = createMockD1([
      { match: "telegram_adoption_client_quota", first: { request_count: 1 } },
      { match: "telegram_adoption_ingress_quota", first: null },
    ]);
    const foreign = request({ campaign: "landing", placement: "hero" }, { Origin: "https://evil.example" });
    expect(
      (await onRequest({ request: foreign, env: { DB: db, TELEGRAM_ADOPTION_IP_HASH_SECRET: "test-secret" } })).status,
    ).toBe(404);
    expect(
      (
        await onRequest({
          request: request({ campaign: "landing", placement: "custom" }),
          env: { DB: db, TELEGRAM_ADOPTION_IP_HASH_SECRET: "test-secret" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await onRequest({
          request: request({ campaign: "landing", placement: "hero" }),
          env: { DB: db, TELEGRAM_ADOPTION_IP_HASH_SECRET: "test-secret" },
        })
      ).status,
    ).toBe(429);
  });

  it("rejects an exhausted per-client quota before consuming the global quota", async () => {
    const db = createMockD1([{ match: "telegram_adoption_client_quota", first: null }]);

    const result = await onRequest({
      request: request({ campaign: "landing", placement: "hero" }),
      env: { DB: db, TELEGRAM_ADOPTION_IP_HASH_SECRET: "test-secret" },
    });

    expect(result.status).toBe(429);
    expect(db.getHistory()).toHaveLength(1);
  });

  it("fails closed when the primary Pages D1 binding or IP hash secret is missing", async () => {
    expect((await onRequest({ request: request({ campaign: "landing", placement: "hero" }), env: {} })).status).toBe(
      503,
    );
    expect(
      (
        await onRequest({
          request: request({ campaign: "landing", placement: "hero" }, { "CF-Connecting-IP": "" }),
          env: { DB: createMockD1([]), TELEGRAM_ADOPTION_IP_HASH_SECRET: "test-secret" },
        })
      ).status,
    ).toBe(503);
  });
});
