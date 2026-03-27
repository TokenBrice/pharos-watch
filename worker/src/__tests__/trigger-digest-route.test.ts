import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  generateDailyDigest: vi.fn(async () => ({ status: "ok", itemCount: 1, metadata: "{}" })),
  logCronRun: vi.fn(async (
    _db: D1Database,
    _job: string,
    fn: (signal: AbortSignal) => Promise<unknown>,
  ) => fn(new AbortController().signal)),
  runCronWithLease: vi.fn(async (
    _db: D1Database,
    _job: string,
    fn: (ctx: { leaseOwner: string; signal: AbortSignal }) => Promise<unknown>,
  ) => ({
    status: "ok",
    leaseOwner: "manual-lease",
    renewFailures: 0,
    result: await fn({ leaseOwner: "manual-lease", signal: new AbortController().signal }),
  })),
}));

vi.mock("../cron/daily-digest", () => ({
  generateDailyDigest: routeMocks.generateDailyDigest,
}));

vi.mock("../lib/cron-logger", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/cron-logger")>();
  return {
    ...original,
    logCronRun: routeMocks.logCronRun,
  };
});

vi.mock("../lib/cron-lease", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/cron-lease")>();
  return {
    ...original,
    createLeaseOwner: vi.fn(() => "manual-lease"),
    runCronWithLease: routeMocks.runCronWithLease,
  };
});

import { mockD1 } from "../api/__tests__/helpers/mock-d1";
import { buildRouteContext } from "../handlers/http/context";
import { getRouteDependencies, route } from "../router";

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

describe("trigger-digest route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 202 and runs the digest in waitUntil under the daily-digest lease", async () => {
    let resolveDigest!: (value: { status: "ok"; itemCount: number; metadata: string }) => void;
    routeMocks.generateDailyDigest.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDigest = resolve as typeof resolveDigest;
        }),
    );

    const request = new Request("https://ops-api.pharos.watch/api/trigger-digest", { method: "POST" });
    const url = new URL(request.url);
    const routeDependencies = getRouteDependencies(url);
    expect(routeDependencies).not.toBeNull();

    const { ctx, waits } = makeCtx();
    const response = await route(
      buildRouteContext({
        request,
        url,
        env: {
          DB: mockD1(),
          CORS_ORIGIN: "https://pharos.watch",
          ANTHROPIC_API_KEY: "anthropic-key",
          TELEGRAM_BOT_TOKEN: "bot-token",
          TELEGRAM_CHAT_ID: "@pharoswatch",
        } as never,
        execCtx: ctx,
        trustedAdmin: true,
        routeDependencies: routeDependencies ?? [],
      }),
    );

    expect(response).not.toBeNull();
    expect(response?.status).toBe(202);
    expect(await response?.json()).toEqual(
      expect.objectContaining({
        ok: true,
        accepted: true,
        requestId: expect.any(String),
      }),
    );
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    expect(routeMocks.logCronRun).toHaveBeenCalledWith(
      expect.anything(),
      "daily-digest",
      expect.any(Function),
    );
    expect(routeMocks.runCronWithLease).toHaveBeenCalledWith(
      expect.anything(),
      "daily-digest",
      expect.any(Function),
      expect.objectContaining({
        owner: "manual-lease",
        abortSignal: expect.any(AbortSignal),
      }),
    );

    resolveDigest({ status: "ok", itemCount: 1, metadata: "{}" });
    await Promise.all(waits);
    expect(routeMocks.generateDailyDigest).toHaveBeenCalledWith(
      expect.anything(),
      "anthropic-key",
      null,
      true,
      { botToken: "bot-token", chatId: "@pharoswatch" },
      expect.any(AbortSignal),
    );
  });
});
