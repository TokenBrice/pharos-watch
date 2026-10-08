import { beforeEach, describe, expect, it, vi } from "vitest";

const dbCacheMocks = vi.hoisted(() => ({
  setCache: vi.fn<(_db: D1Database, key: string, value: string) => Promise<void>>(async () => {}),
  getCache: vi.fn<(_db: D1Database, key: string) => Promise<{ value: string; updatedAt: number } | null>>(async () => null),
  deleteCache: vi.fn(async () => {}),
}));

vi.mock("../lib/db-cache", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/db-cache")>();
  return {
    ...original,
    setCache: dbCacheMocks.setCache,
    getCache: dbCacheMocks.getCache,
    deleteCache: dbCacheMocks.deleteCache,
  };
});

import { mockD1 } from "@shared/test-utils/mock-d1";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { makeExecutionContext } from "../test-helpers/__shared/auth";
import { handleTriggerDigest } from "../api/admin-actions";
import { DIGEST_STYLE_GATE_MODE_CACHE_KEYS } from "../lib/digest-style-gate";

function makeRequest(body?: string): Request {
  return new Request("https://ops-api.pharos.watch/api/trigger-digest", {
    method: "POST",
    headers: {
      "X-Pharos-Admin": "1",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body,
  });
}

describe("trigger-digest route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbCacheMocks.getCache.mockReset().mockResolvedValue(null);
    dbCacheMocks.setCache.mockReset().mockResolvedValue(undefined);
  });

  it("writes the force-run cache key and returns 202 without long-running waitUntil", async () => {
    const request = makeRequest();
    // Idempotency-Key is optional; absent header makes the handler run
    // directly via runIdempotentAction's no-key shortcut.

    const { ctx } = makeExecutionContext();
    const response = await handleTriggerDigest(
      {
        request,
        db: mockD1(),
        execCtx: ctx,
        trustedAdmin: true,
        anthropicApiKey: "anthropic-key",
        telegramCreds: { botToken: "bot-token", chatId: "@pharoswatch" },
      },
    );

    expect(response).not.toBeNull();
    expect(response?.status).toBe(202);
    const body = (await response?.json()) as { ok: boolean; accepted: boolean; requestId: string };
    expect(body.ok).toBe(true);
    expect(body.accepted).toBe(true);
    expect(body.requestId).toMatch(/^manual-digest-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    expect(dbCacheMocks.setCache).toHaveBeenCalledTimes(1);
    const setCacheArgs = dbCacheMocks.setCache.mock.calls[0] as unknown[];
    expect(setCacheArgs[1]).toBe("digest:force-run-request");
    const persistedValue = JSON.parse(setCacheArgs[2] as string) as {
      requestId: string;
      requestedAt: number;
      attempts: number;
      nextAttemptAt: number;
      state: string;
      lastError: string | null;
    };
    expect(persistedValue.requestId).toBe(body.requestId);
    expect(typeof persistedValue.requestedAt).toBe("number");
    expect(persistedValue.attempts).toBe(0);
    expect(persistedValue.nextAttemptAt).toBe(persistedValue.requestedAt);
    expect(persistedValue.state).toBe("pending");
    expect(persistedValue.lastError).toBeNull();

    // waitUntil is not used for digest execution anymore.
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it.each(["daily", "weekly"] as const)("updates only %s mode without queuing a force-run", async (kind) => {
    const otherKind = kind === "daily" ? "weekly" : "daily";
    dbCacheMocks.getCache.mockImplementation(async (_db, key) =>
      key === DIGEST_STYLE_GATE_MODE_CACHE_KEYS[otherKind] ? { value: "shadow", updatedAt: 1 } : null);
    const response = await handleTriggerDigest({
      request: makeRequest(JSON.stringify({ styleGateMode: { [kind]: "enforce" } })),
      db: mockD1(),
      execCtx: makeExecutionContext().ctx,
      trustedAdmin: true,
    });

    expect(response?.status).toBe(202);
    expect(await response?.json()).toMatchObject({
      styleGateMode: { [kind]: "enforce", [otherKind]: "shadow" },
    });
    expect(dbCacheMocks.setCache).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      DIGEST_STYLE_GATE_MODE_CACHE_KEYS[kind],
      "enforce",
    );
    expect(dbCacheMocks.setCache).toHaveBeenCalledTimes(1);
    expect(dbCacheMocks.setCache.mock.calls.some((call) => call[1] === "digest:force-run-request")).toBe(false);
  });

  it("retains a committed scoped mode when the subsequent effective-mode read fails", async () => {
    const stored = new Map<string, string>([[DIGEST_STYLE_GATE_MODE_CACHE_KEYS.weekly, "shadow"]]);
    dbCacheMocks.setCache.mockImplementation(async (_db, key, value) => { stored.set(key, value); });
    dbCacheMocks.getCache.mockRejectedValue(new Error("D1 unavailable after commit"));
    const response = await handleTriggerDigest({
      request: makeRequest(JSON.stringify({ styleGateMode: { daily: "enforce" } })),
      db: mockD1(),
      execCtx: makeExecutionContext().ctx,
      trustedAdmin: true,
    });

    expect(response.status).toBe(500);
    expect(stored.get(DIGEST_STYLE_GATE_MODE_CACHE_KEYS.daily)).toBe("enforce");
    expect(stored.get(DIGEST_STYLE_GATE_MODE_CACHE_KEYS.weekly)).toBe("shadow");
    expect(stored.has("digest:force-run-request")).toBe(false);
    expect(dbCacheMocks.setCache).toHaveBeenCalledTimes(1);
  });

  it("replays a successful mode-only action without another mode write or force intent", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const invoke = async () => {
        const request = makeRequest('{"styleGateMode":{"daily":"enforce"}}');
        request.headers.set("Idempotency-Key", "digest-mode-replay-123");
        return handleTriggerDigest({ request, db, execCtx: makeExecutionContext().ctx, trustedAdmin: true });
      };
      const first = await invoke();
      const replay = await invoke();
      expect(first.status).toBe(202);
      expect(replay.status).toBe(202);
      expect(replay.headers.get("X-Idempotent-Replay")).toBe("true");
      expect(await replay.json()).toEqual(await first.json());
      expect(dbCacheMocks.setCache).toHaveBeenCalledTimes(1);
      expect(dbCacheMocks.setCache.mock.calls[0]?.[1]).toBe(DIGEST_STYLE_GATE_MODE_CACHE_KEYS.daily);
    } finally {
      sqlite.close();
    }
  });

  it("requires reconciliation after an idempotent mode write commits but its response is unknown", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      dbCacheMocks.getCache.mockRejectedValueOnce(new Error("post-commit read failed"));
      const invoke = async () => {
        const request = makeRequest('{"styleGateMode":{"weekly":"enforce"}}');
        request.headers.set("Idempotency-Key", "digest-mode-unknown-123");
        return handleTriggerDigest({ request, db, execCtx: makeExecutionContext().ctx, trustedAdmin: true });
      };
      const first = await invoke();
      const replay = await invoke();
      expect(first.status).toBe(503);
      expect(replay.status).toBe(503);
      expect(await replay.json()).toMatchObject({ error: "execution_unknown" });
      expect(dbCacheMocks.setCache).toHaveBeenCalledTimes(1);
      expect(dbCacheMocks.setCache.mock.calls[0]?.[1]).toBe(DIGEST_STYLE_GATE_MODE_CACHE_KEYS.weekly);
      expect(sqlite.prepare("SELECT response_status FROM admin_idempotency_keys WHERE idempotency_key = ?")
        .get("digest-mode-unknown-123")).toMatchObject({ response_status: -2 });
    } finally {
      sqlite.close();
    }
  });

  it.each([
    { styleGateMode: "enforce" },
    { styleGateMode: { daily: "enforce", weekly: "shadow" } },
    { styleGateMode: { monthly: "enforce" } },
    { styleGateMode: { daily: "blocking" } },
    { styleGateMode: null },
  ])("rejects an unscoped or malformed style gate payload without queueing (%j)", async (body) => {
    const response = await handleTriggerDigest({
      request: makeRequest(JSON.stringify(body)),
      db: mockD1(),
      execCtx: makeExecutionContext().ctx,
      trustedAdmin: true,
    });

    expect(response?.status).toBe(400);
    expect(dbCacheMocks.setCache).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid JSON", "{", 400],
    ["non-object JSON", "[]", 400],
    ["unknown field", '{"unexpected":true}', 400],
    ["oversized body", " ".repeat(1_025), 413],
  ] as const)("rejects %s without changing settings or queueing", async (_name, body, status) => {
    const response = await handleTriggerDigest({
      request: makeRequest(body),
      db: mockD1(),
      execCtx: makeExecutionContext().ctx,
      trustedAdmin: true,
    });
    expect(response.status).toBe(status);
    expect(dbCacheMocks.setCache).not.toHaveBeenCalled();
    expect(dbCacheMocks.deleteCache).not.toHaveBeenCalled();
  });

});
