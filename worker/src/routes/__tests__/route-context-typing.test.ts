import { describe, expect, expectTypeOf, it } from "vitest";
import type { ApiKeySelfServeEnv } from "../../api/api-key-requests/types";
import type { FeedbackEnv } from "../../api/feedback";
import type { Env } from "../../lib/env";
import type { TelegramCreds } from "../../lib/telegram";
import { buildRouteContext } from "../../handlers/http/context";
import { DYNAMIC_ADMIN_ROUTE_HANDLER_KEYS, getDynamicRouteMatch } from "../dynamic-routes";
import { getRouteDependencies } from "../registry";
import { defineDynamicRoute, defineStaticRoute, type RouteContextFor } from "../shared";
import {
  DYNAMIC_ENDPOINT_DESCRIPTORS,
  STATIC_ENDPOINT_DEPENDENCY_HYDRATION_POLICIES,
  getDynamicEndpointDescriptorByKey,
  type EndpointDependenciesForKey,
} from "@shared/lib/api-endpoints";
import type { CloudflareD1StatusBindings } from "../../lib/env";

describe("route context typing", () => {
  it("narrows static route contexts to declared endpoint dependencies", () => {
    defineStaticRoute("status", async (routeCtx) => {
      expectTypeOf(routeCtx).toEqualTypeOf<RouteContextFor<EndpointDependenciesForKey<"status">>>();
      expectTypeOf(routeCtx.coingeckoApiKey).toEqualTypeOf<string | null>();
      expectTypeOf(routeCtx.cloudflareD1StatusBindings).toEqualTypeOf<CloudflareD1StatusBindings>();
      expectTypeOf(routeCtx.workerCanaryMode).toEqualTypeOf<"off" | "shadow" | "status" | "alert">();
      expectTypeOf(routeCtx.apiKeyHashPepper).toEqualTypeOf<string | undefined>();
      return new Response("ok");
    });

    defineStaticRoute("backfill-depegs", async (routeCtx) => {
      expectTypeOf(routeCtx).toEqualTypeOf<RouteContextFor<EndpointDependenciesForKey<"backfill-depegs">>>();
      expectTypeOf(routeCtx.coingeckoApiKey).toEqualTypeOf<string | null>();
      return new Response("ok");
    });

    defineStaticRoute("feedback", async (routeCtx) => {
      expectTypeOf(routeCtx.feedbackEnv).toEqualTypeOf<FeedbackEnv>();
      expectTypeOf(routeCtx.telegramCreds).toEqualTypeOf<TelegramCreds | null | undefined>();
      return new Response("ok");
    });

    defineStaticRoute("api-key-requests", async (routeCtx) => {
      expectTypeOf(routeCtx.apiKeySelfServeEnv).toEqualTypeOf<ApiKeySelfServeEnv>();
      expectTypeOf(routeCtx.apiKeyHashPepper).toEqualTypeOf<string | undefined>();
      return new Response("ok");
    });

    defineStaticRoute("api-key-request-verify", async (routeCtx) => {
      expectTypeOf(routeCtx.apiKeySelfServeEnv).toEqualTypeOf<ApiKeySelfServeEnv>();
      expectTypeOf(routeCtx.apiKeyHashPepper).toEqualTypeOf<string | undefined>();
      return new Response("ok");
    });
  });

  it("narrows dynamic route contexts to declared dependencies", () => {
    defineDynamicRoute(/^\/example$/, ["coingeckoApiKey"], ["GET"], async (routeCtx) => {
      expectTypeOf(routeCtx.coingeckoApiKey).toEqualTypeOf<string | null>();
      expectTypeOf(routeCtx.feedbackEnv).toEqualTypeOf<FeedbackEnv | undefined>();
      return new Response("ok");
    });

    defineDynamicRoute(/^\/admin$/, [], ["GET"], async (routeCtx) => {
      expectTypeOf(routeCtx.coingeckoApiKey).toEqualTypeOf<string | null | undefined>();
      return new Response("ok");
    });
  });

  it("hydrates only the requested dependency fields at runtime", () => {
    const request = new Request("https://api.pharos.watch/api/status");
    const url = new URL(request.url);
    const env = {
      DB: {} as D1Database,
      COINGECKO_API_KEY: "cg-demo",
      GITHUB_PAT: "ghp_demo",
      FEEDBACK_IP_SALT: "salt",
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_D1_STATUS_API_TOKEN: "token",
      CLOUDFLARE_D1_DATABASE_ID: "database",
      WORKER_CANARY_MODE: "shadow",
      CF_VERSION_METADATA: {
        id: "preview-id",
        tag: "preview-v1",
        timestamp: "2026-07-12T00:00:00Z",
      },
      API_KEY_SELF_SERVE_IP_SALT: "self-serve-ip",
      API_KEY_SELF_SERVE_EMAIL_HASH_PEPPER: "self-serve-email",
      API_KEY_SELF_SERVE_REQUEST_PEPPER: "self-serve-request",
      API_KEY_SELF_SERVE_EMAIL_FROM: "Pharos API <api@mail.pharos.watch>",
      API_KEY_SELF_SERVE_EMAIL_REPLY_TO: "api@mail.pharos.watch",
      API_KEY_SELF_SERVE_PUBLIC_BASE_URL: "https://pharos.watch/api",
      RESEND_API_KEY: "re_demo",
    } as unknown as Env;
    const execCtx = {
      waitUntil: (_promise: Promise<unknown>) => {},
      passThroughOnException: () => {},
    } as ExecutionContext;

    const statusCtx = buildRouteContext({
      request,
      url,
      env,
      execCtx,
      trustedAdmin: true,
      routeDependencies: ["coingeckoApiKey", "cloudflareD1StatusConfig", "workerStatusConfig"] as const,
    });
    expect(statusCtx.coingeckoApiKey).toBe("cg-demo");
    expect(statusCtx.cloudflareD1StatusBindings).toEqual({
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_D1_STATUS_API_TOKEN: "token",
      CLOUDFLARE_D1_DATABASE_ID: "database",
    });
    expect(statusCtx.workerCanaryMode).toBe("shadow");
    expect(statusCtx.feedbackEnv).toBeUndefined();

    const workerVersionCtx = buildRouteContext({
      request,
      url,
      env,
      execCtx,
      trustedAdmin: true,
      routeDependencies: ["workerVersion"] as const,
    });
    expect(workerVersionCtx.workerVersion).toBe("preview-v1");

    const feedbackCtx = buildRouteContext({
      request,
      url,
      env,
      execCtx,
      trustedAdmin: false,
      routeDependencies: ["feedbackEnv"] as const,
    });
    expect(feedbackCtx.feedbackEnv).toEqual({
      GITHUB_PAT: "ghp_demo",
      FEEDBACK_IP_SALT: "salt",
    });
    expect(feedbackCtx.coingeckoApiKey).toBeUndefined();

    const selfServeCtx = buildRouteContext({
      request,
      url,
      env,
      execCtx,
      trustedAdmin: false,
      routeDependencies: ["apiKeySelfServeEnv"] as const,
    });
    expect(selfServeCtx.apiKeySelfServeEnv).toEqual({
      API_KEY_SELF_SERVE_IP_SALT: "self-serve-ip",
      API_KEY_SELF_SERVE_EMAIL_HASH_PEPPER: "self-serve-email",
      API_KEY_SELF_SERVE_REQUEST_PEPPER: "self-serve-request",
      API_KEY_SELF_SERVE_EMAIL_FROM: "Pharos API <api@mail.pharos.watch>",
      API_KEY_SELF_SERVE_EMAIL_REPLY_TO: "api@mail.pharos.watch",
      API_KEY_SELF_SERVE_PUBLIC_BASE_URL: "https://pharos.watch/api",
      RESEND_API_KEY: "re_demo",
    });
    expect(selfServeCtx.feedbackEnv).toBeUndefined();
  });

  it("keeps dynamic admin dependency mapping centralized", () => {
    expect(getDynamicRouteMatch("/api/api-keys/7/update")?.dependencies).toEqual(["apiKeyHashPepper"]);
    expect(getDynamicRouteMatch("/api/api-keys/7/deactivate")?.dependencies).toEqual([]);
    expect(getDynamicRouteMatch("/api/api-keys/7/rotate")?.dependencies).toEqual(["apiKeyHashPepper"]);
    expect(getDynamicRouteMatch("/api/api-key-requests-admin/akr_abc12345/reject")?.dependencies).toEqual([]);
    expect(getDynamicRouteMatch("/api/api-key-requests-admin/akr_abc12345/release-claim")?.dependencies).toEqual([]);
    expect(getDynamicRouteMatch("/api/admin-telegram-chat/-12345")?.dependencies).toEqual([]);
  });

  it("keeps static route dependency mapping centralized", () => {
    for (const policy of STATIC_ENDPOINT_DEPENDENCY_HYDRATION_POLICIES) {
      expect(getRouteDependencies(policy.path), policy.key).toEqual(policy.dependencies);
    }
  });

  it("keeps dynamic admin handler bindings exhaustive against shared descriptors", () => {
    const adminDescriptorKeys = DYNAMIC_ENDPOINT_DESCRIPTORS.filter((descriptor) => descriptor.adminRequired)
      .map((descriptor) => descriptor.key)
      .sort();

    expect([...DYNAMIC_ADMIN_ROUTE_HANDLER_KEYS].sort()).toEqual(adminDescriptorKeys);
  });

  it("keeps the shared dynamic descriptor table aligned with worker dependency hydration", () => {
    expect(getDynamicEndpointDescriptorByKey("stablecoin-detail")?.routeDependencies).toEqual(["coingeckoApiKey"]);
    expect(getDynamicEndpointDescriptorByKey("stablecoin-summary")?.routeDependencies).toEqual([]);
    expect(getDynamicEndpointDescriptorByKey("stablecoin-reserves")?.routeDependencies).toEqual([]);
    expect(getDynamicEndpointDescriptorByKey("api-key-update")?.routeDependencies).toEqual(
      getDynamicRouteMatch("/api/api-keys/7/update")?.dependencies,
    );
    expect(getDynamicEndpointDescriptorByKey("api-key-deactivate")?.routeDependencies).toEqual(
      getDynamicRouteMatch("/api/api-keys/7/deactivate")?.dependencies,
    );
    expect(getDynamicEndpointDescriptorByKey("api-key-rotate")?.routeDependencies).toEqual(
      getDynamicRouteMatch("/api/api-keys/7/rotate")?.dependencies,
    );
    expect(getDynamicEndpointDescriptorByKey("api-key-request-reject")?.routeDependencies).toEqual(
      getDynamicRouteMatch("/api/api-key-requests-admin/akr_abc12345/reject")?.dependencies,
    );
    expect(getDynamicEndpointDescriptorByKey("api-key-request-release-claim")?.routeDependencies).toEqual(
      getDynamicRouteMatch("/api/api-key-requests-admin/akr_abc12345/release-claim")?.dependencies,
    );
    expect(getDynamicEndpointDescriptorByKey("admin-telegram-chat")?.routeDependencies).toEqual(
      getDynamicRouteMatch("/api/admin-telegram-chat/-12345")?.dependencies,
    );
  });
});
