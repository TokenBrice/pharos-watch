import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  logWorkerEvent: vi.fn(),
}));

vi.mock("../../../lib/structured-log", () => ({
  logWorkerEvent: mocks.logWorkerEvent,
}));

import {
  TELEGRAM_INGRESS_POLICIES,
  evaluateTelegramIngressAbuseGate,
  recordTelegramIngressHandlerResponse,
  type TelegramIngressAbuseEnv,
} from "../telegram-ingress-abuse";

const encoder = new TextEncoder();

function createLimiter(implementation: () => Promise<RateLimitOutcome> = async () => ({ success: true })) {
  return { limit: vi.fn(implementation) } satisfies RateLimit;
}

function createEnv(overrides: Partial<TelegramIngressAbuseEnv> = {}): TelegramIngressAbuseEnv {
  return {
    TELEGRAM_WEBHOOK_PREAUTH_RATE_LIMIT: createLimiter(),
    TELEGRAM_MINI_APP_SESSION_PREAUTH_RATE_LIMIT: createLimiter(),
    TELEGRAM_MINI_APP_MUTATION_PREAUTH_RATE_LIMIT: createLimiter(),
    SITE_API_SHARED_SECRET: "test-pepper",
    TELEGRAM_WEBHOOK_SOURCE_RATE_LIMIT: createLimiter(),
    TELEGRAM_MINI_APP_SESSION_SOURCE_RATE_LIMIT: createLimiter(),
    TELEGRAM_MINI_APP_MUTATION_SOURCE_RATE_LIMIT: createLimiter(),
    ...overrides,
  };
}

function post(path: string, body: BodyInit | null = "{}", headers: Record<string, string> = {}): Request {
  return new Request(`https://api.pharos.watch${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

function streamedPost(path: string, chunks: string[]): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Request(`https://api.pharos.watch${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

function bindingBlock(wrangler: string, binding: string): string {
  const marker = `[[ratelimits]]\nname = "${binding}"`;
  const start = wrangler.indexOf(marker);
  if (start < 0) throw new Error(`missing Wrangler rate-limit binding ${binding}`);
  const next = wrangler.indexOf("[[ratelimits]]", start + marker.length);
  return wrangler.slice(start, next < 0 ? wrangler.length : next);
}

describe("Telegram ingress abuse gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });


  it("keeps a source flood from spending another source's reserved aggregate headroom", async () => {
    const counts = new Map<string, number>();
    const source = { limit: vi.fn(async ({ key }: { key: string }) => {
      const used = (counts.get(key) ?? 0) + 1;
      counts.set(key, used);
      return { success: used <= 2 };
    }) };
    let aggregateUsed = 0;
    const aggregate = createLimiter(async () => ({ success: ++aggregateUsed <= 4 }));
    const env = createEnv({
      TELEGRAM_MINI_APP_SESSION_PREAUTH_RATE_LIMIT: aggregate,
    });
    env.TELEGRAM_MINI_APP_SESSION_SOURCE_RATE_LIMIT = source;
    const send = async (ip: string) => {
      const input = post(TELEGRAM_INGRESS_POLICIES.mini_app_session.path, null, { "CF-Connecting-IP": ip });
      return (await evaluateTelegramIngressAbuseGate(input, new URL(input.url), env)).response?.status ?? 200;
    };
    expect(await send("203.0.113.1")).toBe(200);
    expect(await send("203.0.113.1")).toBe(200);
    expect(await send("203.0.113.1")).toBe(429);
    expect(await send("203.0.113.1")).toBe(429);
    expect(await send("203.0.113.2")).toBe(200);
    expect(await send("203.0.113.2")).toBe(200);
    expect(await send("203.0.113.3")).toBe(429);
    expect(JSON.stringify([...counts.keys()])).not.toContain("203.0.113.");
  });
  it("matches only the three exact POST paths and keeps their binding counters isolated", async () => {
    for (const policy of Object.values(TELEGRAM_INGRESS_POLICIES)) {
      const env = createEnv();
      const request = post(policy.path, "{}", { "Content-Length": "2" });
      const result = await evaluateTelegramIngressAbuseGate(request, new URL(request.url), env);

      expect(result.response).toBeNull();
      expect(result.request.headers.get("content-length")).toBeNull();
      await expect(result.request.text()).resolves.toBe("{}");
    }

    const env = createEnv();
    const wrongMethod = new Request(`https://api.pharos.watch${TELEGRAM_INGRESS_POLICIES.webhook.path}`);
    const nearMatch = post(`${TELEGRAM_INGRESS_POLICIES.webhook.path}/extra`);
    await expect(evaluateTelegramIngressAbuseGate(wrongMethod, new URL(wrongMethod.url), env)).resolves.toEqual({
      request: wrongMethod,
      response: null,
    });
    await expect(evaluateTelegramIngressAbuseGate(nearMatch, new URL(nearMatch.url), env)).resolves.toEqual({
      request: nearMatch,
      response: null,
    });
    expect(Object.values(env).filter((value) => typeof value !== "string").every((limiter) => vi.mocked(limiter.limit).mock.calls.length === 0)).toBe(true);
  });

  it("isolates noncanonical hosts from the public API limiter budget", async () => {
    const env = createEnv();
    const policy = TELEGRAM_INGRESS_POLICIES.mini_app_session;
    const canonical = post(policy.path, "{}");

    await expect(evaluateTelegramIngressAbuseGate(canonical, new URL(canonical.url), env)).resolves.toMatchObject({
      response: null,
    });

    for (const hostname of ["site-api.pharos.watch", "ops-api.pharos.watch", "pharos-watch-preview.workers.dev"]) {
      const request = new Request(`https://${hostname}${policy.path}`, {
        method: "POST",
        body: "{}",
      });
      const result = await evaluateTelegramIngressAbuseGate(request, new URL(request.url), env);

      expect(result.response).toBeNull();
      await expect(result.request.text()).resolves.toBe("{}");
    }

    expect(vi.mocked(env.TELEGRAM_MINI_APP_SESSION_PREAUTH_RATE_LIMIT.limit).mock.calls).toEqual([
      [{ key: policy.rateLimitKey }],
      [{ key: `${policy.rateLimitKey}:noncanonical-host` }],
      [{ key: `${policy.rateLimitKey}:noncanonical-host` }],
      [{ key: `${policy.rateLimitKey}:noncanonical-host` }],
    ]);
  });

  it("rate limits alternate-host webhooks before downstream authentication", async () => {
    const limiter = createLimiter(async () => ({ success: false }));
    const env = createEnv({ TELEGRAM_WEBHOOK_PREAUTH_RATE_LIMIT: limiter });
    const policy = TELEGRAM_INGRESS_POLICIES.webhook;
    const request = new Request(`https://pharos-watch-preview.workers.dev${policy.path}`, {
      method: "POST",
      body: "{}",
    });

    const result = await evaluateTelegramIngressAbuseGate(request, new URL(request.url), env);

    expect(result.response?.status).toBe(429);
    expect(request.bodyUsed).toBe(false);
    expect(limiter.limit).toHaveBeenCalledWith({ key: `${policy.rateLimitKey}:noncanonical-host` });
  });

  it("rejects declared body violations before spending the rate-limit or downstream auth budget", async () => {
    const env = createEnv();
    const policy = TELEGRAM_INGRESS_POLICIES.mini_app_session;
    const oversized = post(policy.path, "{}", {
      "Content-Length": String(policy.bodyLimitBytes + 1),
    });
    const oversizedResult = await evaluateTelegramIngressAbuseGate(oversized, new URL(oversized.url), env);
    expect(oversizedResult.response?.status).toBe(413);
    expect(env.TELEGRAM_MINI_APP_SESSION_PREAUTH_RATE_LIMIT.limit).not.toHaveBeenCalled();
    expect(oversized.bodyUsed).toBe(false);

    const malformed = post(policy.path, "{}", { "Content-Length": "not-a-number" });
    const malformedResult = await evaluateTelegramIngressAbuseGate(malformed, new URL(malformed.url), env);
    expect(malformedResult.response?.status).toBe(400);
    expect(env.TELEGRAM_MINI_APP_SESSION_PREAUTH_RATE_LIMIT.limit).not.toHaveBeenCalled();
    expect(malformed.bodyUsed).toBe(false);
  });

  it("returns 429 before reading the request body when the pre-auth budget is exhausted", async () => {
    const limiter = createLimiter(async () => ({ success: false }));
    const env = createEnv({ TELEGRAM_MINI_APP_SESSION_PREAUTH_RATE_LIMIT: limiter });
    const request = streamedPost(TELEGRAM_INGRESS_POLICIES.mini_app_session.path, ['{"initData":"invalid"}']);

    const result = await evaluateTelegramIngressAbuseGate(request, new URL(request.url), env);

    expect(result.response?.status).toBe(429);
    expect(result.response?.headers.get("Retry-After")).toBe("60");
    expect(request.bodyUsed).toBe(false);
    expect(limiter.limit).toHaveBeenCalledOnce();
  });

  it("caps undeclared streamed bodies after admission and before handler auth", async () => {
    const policy = TELEGRAM_INGRESS_POLICIES.mini_app_mutation;
    const request = streamedPost(policy.path, ["x".repeat(policy.bodyLimitBytes), "x"]);
    const env = createEnv();

    const result = await evaluateTelegramIngressAbuseGate(request, new URL(request.url), env);

    expect(env.TELEGRAM_MINI_APP_MUTATION_PREAUTH_RATE_LIMIT.limit).toHaveBeenCalledOnce();
    expect(result.response?.status).toBe(413);
    expect(request.bodyUsed).toBe(true);
  });

  it("returns low-cardinality 400 telemetry when a bounded body stream fails", async () => {
    const policy = TELEGRAM_INGRESS_POLICIES.webhook;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("client stream failed"));
      },
    });
    const request = new Request(`https://api.pharos.watch${policy.path}`, {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const env = createEnv();

    const result = await evaluateTelegramIngressAbuseGate(request, new URL(request.url), env);

    expect(env.TELEGRAM_WEBHOOK_PREAUTH_RATE_LIMIT.limit).toHaveBeenCalledOnce();
    expect(result.response?.status).toBe(400);
    expect(mocks.logWorkerEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        route: "webhook",
        status: 400,
        metadata: { stage: "body_stream", reason: "body_read_failed" },
      }),
    );
  });

  it("fails closed with bounded 503 telemetry when the fleet limiter is unavailable", async () => {
    const limiter = createLimiter(async () => {
      throw new Error("binding unavailable");
    });
    const env = createEnv({ TELEGRAM_WEBHOOK_PREAUTH_RATE_LIMIT: limiter });
    const request = post(TELEGRAM_INGRESS_POLICIES.webhook.path);

    const result = await evaluateTelegramIngressAbuseGate(request, new URL(request.url), env);

    expect(result.response?.status).toBe(503);
    expect(result.response?.headers.get("Retry-After")).toBe("1");
    expect(request.bodyUsed).toBe(false);
    expect(mocks.logWorkerEvent).toHaveBeenLastCalledWith({
      scope: "http",
      level: "warn",
      event: "telegram_ingress_rejection",
      route: "webhook",
      source: "telegram-ingress",
      status: 503,
      message: "Telegram ingress request rejected",
      metadata: { stage: "rate_limit", reason: "rate_limit_unavailable" },
    });
  });

  it("admits a same-colo launch burst from all 800 current subscribers", async () => {
    const policy = TELEGRAM_INGRESS_POLICIES.mini_app_session;
    let used = 0;
    const limiter = createLimiter(async () => ({ success: ++used <= policy.rateLimit }));
    const env = createEnv({ TELEGRAM_MINI_APP_SESSION_PREAUTH_RATE_LIMIT: limiter });

    for (let subscriber = 0; subscriber < 800; subscriber += 1) {
      const request = post(policy.path, null);
      const result = await evaluateTelegramIngressAbuseGate(request, new URL(request.url), env);
      expect(result.response).toBeNull();
    }

    expect(limiter.limit).toHaveBeenCalledTimes(800);
    expect(used).toBeLessThanOrEqual(policy.rateLimit / 2);
    expect(800 * 6).toBe(TELEGRAM_INGRESS_POLICIES.mini_app_mutation.rateLimit / 2);
  });

  it.each([
    [400, "handler_bad_request"],
    [401, "handler_unauthorized"],
    [413, "handler_body_too_large"],
    [429, "handler_rate_limited"],
  ] as const)("emits only closed, low-cardinality handler fields for %i", (status, reason) => {
    const request = post(TELEGRAM_INGRESS_POLICIES.mini_app_mutation.path);
    recordTelegramIngressHandlerResponse(request, new URL(request.url), new Response(null, { status }));

    expect(mocks.logWorkerEvent).toHaveBeenCalledOnce();
    expect(mocks.logWorkerEvent).toHaveBeenCalledWith({
      scope: "http",
      level: "warn",
      event: "telegram_ingress_rejection",
      route: "mini_app_mutation",
      source: "telegram-ingress",
      status,
      message: "Telegram ingress request rejected",
      metadata: { stage: "handler", reason },
    });
    expect(JSON.stringify(mocks.logWorkerEvent.mock.calls[0])).not.toMatch(/initData|chatId|userId|cf-connecting-ip/i);
  });
});

describe("Telegram ingress checked-in bindings", () => {
  it("keeps handler policies and Wrangler bindings aligned", () => {
    const root = process.cwd();
    const wrangler = readFileSync(join(root, "worker/wrangler.toml"), "utf8");

    for (const policy of Object.values(TELEGRAM_INGRESS_POLICIES)) {
      const block = bindingBlock(wrangler, policy.binding);
      expect(block).toContain(`limit = ${policy.rateLimit}`);
      expect(block).toContain(`period = ${policy.periodSec}`);
    }
  });
});
