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

import { mockD1 } from "../test-helpers/__shared/mock-d1";
import { handleTriggerDigest } from "../api/admin-actions";

function makeCtx() {
  const waits: Promise<unknown>[] = [];
  return {
    waits,
    ctx: {
      waitUntil: vi.fn((promise: Promise<unknown>) => {
        waits.push(Promise.resolve(promise));
      }),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext,
  };
}

function makeRequest(): Request {
  return new Request("https://ops-api.pharos.watch/api/trigger-digest", {
    method: "POST",
    headers: { "X-Pharos-Admin": "1" },
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

    const { ctx } = makeCtx();
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
    const persistedValue = JSON.parse(setCacheArgs[2] as string) as { requestId: string; requestedAt: number };
    expect(persistedValue.requestId).toBe(body.requestId);
    expect(typeof persistedValue.requestedAt).toBe("number");

    // waitUntil is not used for digest execution anymore.
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

});
