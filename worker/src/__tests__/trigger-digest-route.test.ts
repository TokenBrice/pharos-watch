import { beforeEach, describe, expect, it, vi } from "vitest";

const dbCacheMocks = vi.hoisted(() => ({
  setCache: vi.fn(async () => {}),
  getCache: vi.fn(async () => null),
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
  });

  it("writes the force-run cache key and returns 202 without long-running waitUntil", async () => {
    const request = makeRequest();
    // Idempotency-Key is optional; absent header makes the handler run
    // directly via runIdempotentAdminAction's no-key shortcut.

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

  it("validates and persists the runtime style gate mode with the queued trigger", async () => {
    const response = await handleTriggerDigest({
      request: makeRequest(JSON.stringify({ styleGateMode: { weekly: "enforce" } })),
      db: mockD1(),
      execCtx: makeExecutionContext().ctx,
      trustedAdmin: true,
    });

    expect(response?.status).toBe(202);
    expect(await response?.json()).toMatchObject({
      styleGateMode: { daily: "shadow", weekly: "enforce" },
    });
    expect(dbCacheMocks.setCache).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      DIGEST_STYLE_GATE_MODE_CACHE_KEYS.weekly,
      "enforce",
    );
    expect(dbCacheMocks.setCache).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      "digest:force-run-request",
      expect.any(String),
    );
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

});
