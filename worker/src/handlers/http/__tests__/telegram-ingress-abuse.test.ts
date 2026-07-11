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

type PolicyArtifact = {
  deploymentState: string;
  protectedHostname: string;
  workerBindings: Array<{
    route: string;
    method: string;
    path: string;
    binding: string;
    namespaceId: string;
    requestsPerPeriod: number;
    periodSec: number;
    bodyLimitBytes: number;
  }>;
  waf: {
    deploymentState: string;
    broadApiRule: {
      requiredExcludedExactPaths: string[];
      requiredExpression: string;
    };
    exactPathRules: Array<{
      expression: string;
      requestsPerPeriod: number;
      periodSec: number;
    }>;
  };
};

const encoder = new TextEncoder();

function createLimiter(implementation: () => Promise<RateLimitOutcome> = async () => ({ success: true })) {
  return { limit: vi.fn(implementation) } satisfies RateLimit;
}

function createEnv(overrides: Partial<TelegramIngressAbuseEnv> = {}): TelegramIngressAbuseEnv {
  return {
    TELEGRAM_WEBHOOK_PREAUTH_RATE_LIMIT: createLimiter(),
    TELEGRAM_MINI_APP_SESSION_PREAUTH_RATE_LIMIT: createLimiter(),
    TELEGRAM_MINI_APP_MUTATION_PREAUTH_RATE_LIMIT: createLimiter(),
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

  it("matches only the three exact POST paths and keeps their binding counters isolated", async () => {
    for (const policy of Object.values(TELEGRAM_INGRESS_POLICIES)) {
      const env = createEnv();
      const request = post(policy.path, "{}", { "Content-Length": "2" });
      const result = await evaluateTelegramIngressAbuseGate(request, new URL(request.url), env);

      expect(result.response).toBeNull();
      expect(result.request.headers.get("content-length")).toBeNull();
      await expect(result.request.text()).resolves.toBe("{}");
      expect(env[policy.binding].limit).toHaveBeenCalledOnce();
      expect(env[policy.binding].limit).toHaveBeenCalledWith({ key: policy.rateLimitKey });
      const calls = Object.values(env).reduce(
        (total, limiter) => total + vi.mocked(limiter.limit).mock.calls.length,
        0,
      );
      expect(calls).toBe(1);
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
    expect(Object.values(env).every((limiter) => vi.mocked(limiter.limit).mock.calls.length === 0)).toBe(true);
  });

  it("only charges the pre-auth limiter on the public API hostname", async () => {
    const env = createEnv();
    const policy = TELEGRAM_INGRESS_POLICIES.mini_app_session;

    for (const hostname of ["site-api.pharos.watch", "ops-api.pharos.watch", "pharos-watch-preview.workers.dev"]) {
      const request = new Request(`https://${hostname}${policy.path}`, {
        method: "POST",
        body: "{}",
      });
      const result = await evaluateTelegramIngressAbuseGate(request, new URL(request.url), env);

      expect(result).toEqual({ request, response: null });
      expect(request.bodyUsed).toBe(false);
    }

    expect(env.TELEGRAM_MINI_APP_SESSION_PREAUTH_RATE_LIMIT.limit).not.toHaveBeenCalled();
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

describe("Telegram ingress checked-in policy", () => {
  it("keeps runtime, Wrangler bindings, and required operator policy budgets aligned", () => {
    const root = process.cwd();
    const artifact = JSON.parse(
      readFileSync(join(root, "worker/config/telegram-ingress-abuse-policy.json"), "utf8"),
    ) as PolicyArtifact;
    const wrangler = readFileSync(join(root, "worker/wrangler.toml"), "utf8");

    expect(artifact.deploymentState).toBe("required-operator-configuration-not-deployed-by-repo");
    expect(artifact.protectedHostname).toBe("api.pharos.watch");
    expect(artifact.waf.deploymentState).toBe("required-operator-configuration-not-deployed-by-repo");
    for (const policy of Object.values(TELEGRAM_INGRESS_POLICIES)) {
      const configured = artifact.workerBindings.find((entry) => entry.route === policy.route);
      expect(configured).toMatchObject({
        method: policy.method,
        path: policy.path,
        binding: policy.binding,
        requestsPerPeriod: policy.rateLimit,
        periodSec: policy.periodSec,
        bodyLimitBytes: policy.bodyLimitBytes,
      });
      if (!configured) throw new Error(`missing policy artifact route ${policy.route}`);
      const block = bindingBlock(wrangler, policy.binding);
      expect(block).toContain(`namespace_id = "${configured.namespaceId}"`);
      expect(block).toContain(`limit = ${policy.rateLimit}`);
      expect(block).toContain(`period = ${policy.periodSec}`);
    }
  });

  it("requires exact-path WAF rules and excludes them from the broad API rule", () => {
    const artifact = JSON.parse(
      readFileSync(join(process.cwd(), "worker/config/telegram-ingress-abuse-policy.json"), "utf8"),
    ) as PolicyArtifact;
    const paths = Object.values(TELEGRAM_INGRESS_POLICIES).map((policy) => policy.path);
    const expectedWafBudgets = new Map([
      [TELEGRAM_INGRESS_POLICIES.webhook.path, 2_400],
      [TELEGRAM_INGRESS_POLICIES.mini_app_session.path, 120],
      [TELEGRAM_INGRESS_POLICIES.mini_app_mutation.path, 360],
    ]);

    expect(artifact.waf.broadApiRule.requiredExpression).toContain("and not (http.request.uri.path in {");
    expect(artifact.waf.broadApiRule.requiredExpression).toContain(`http.host eq "${artifact.protectedHostname}"`);
    for (const path of paths) {
      expect(artifact.waf.broadApiRule.requiredExcludedExactPaths).toContain(path);
      expect(artifact.waf.broadApiRule.requiredExpression).toContain(`"${path}"`);
      const exactRule = artifact.waf.exactPathRules.find(
        (rule) =>
          rule.expression.includes(`http.request.uri.path eq "${path}"`) &&
          rule.expression.includes('http.request.method eq "POST"'),
      );
      expect(exactRule).toMatchObject({
        requestsPerPeriod: expectedWafBudgets.get(path),
        periodSec: 60,
      });
      expect(exactRule?.expression).toContain(`http.host eq "${artifact.protectedHostname}"`);
    }
  });
});
