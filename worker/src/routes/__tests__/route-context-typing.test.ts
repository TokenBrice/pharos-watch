import { describe, expect, expectTypeOf, it } from "vitest";
import type { FeedbackEnv } from "../../api/feedback";
import type { Env } from "../../lib/env";
import type { TelegramCreds } from "../../lib/telegram";
import { buildRouteContext } from "../../handlers/http/context";
import { getDynamicRouteMatch } from "../dynamic-routes";
import { defineDynamicRoute, defineStaticRoute, type RouteContextFor } from "../shared";
import { getDynamicEndpointDescriptorByKey, type EndpointDependenciesForKey } from "@shared/lib/api-endpoints";
import type { CloudflareD1StatusBindings } from "../../lib/env";

describe("route context typing", () => {
  it("narrows static route contexts to declared endpoint dependencies", () => {
    defineStaticRoute("status", async (routeCtx) => {
      expectTypeOf(routeCtx).toEqualTypeOf<RouteContextFor<EndpointDependenciesForKey<"status">>>();
      expectTypeOf(routeCtx.coingeckoApiKey).toEqualTypeOf<string | null>();
      expectTypeOf(routeCtx.cloudflareD1StatusBindings).toEqualTypeOf<CloudflareD1StatusBindings>();
      expectTypeOf(routeCtx.apiKeyHashPepper).toEqualTypeOf<string | undefined>();
      return new Response("ok");
    });

    defineStaticRoute("feedback", async (routeCtx) => {
      expectTypeOf(routeCtx.feedbackEnv).toEqualTypeOf<FeedbackEnv>();
      expectTypeOf(routeCtx.telegramCreds).toEqualTypeOf<TelegramCreds | null | undefined>();
      return new Response("ok");
    });
  });

  it("narrows dynamic route contexts to declared dependencies", () => {
    defineDynamicRoute(/^\/example$/, ["coingeckoApiKey"], async (routeCtx) => {
      expectTypeOf(routeCtx.coingeckoApiKey).toEqualTypeOf<string | null>();
      expectTypeOf(routeCtx.feedbackEnv).toEqualTypeOf<FeedbackEnv | undefined>();
      return new Response("ok");
    });

    defineDynamicRoute(/^\/admin$/, [], async (routeCtx) => {
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
      routeDependencies: ["coingeckoApiKey", "cloudflareD1StatusConfig"] as const,
    });
    expect(statusCtx.coingeckoApiKey).toBe("cg-demo");
    expect(statusCtx.cloudflareD1StatusBindings).toEqual({
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_D1_STATUS_API_TOKEN: "token",
      CLOUDFLARE_D1_DATABASE_ID: "database",
    });
    expect(statusCtx.feedbackEnv).toBeUndefined();

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
  });

  it("keeps dynamic admin dependency mapping centralized", () => {
    expect(getDynamicRouteMatch("/api/discovery-candidates/42/dismiss")?.dependencies).toEqual([]);
    expect(getDynamicRouteMatch("/api/api-keys/7/update")?.dependencies).toEqual(["apiKeyHashPepper"]);
    expect(getDynamicRouteMatch("/api/api-keys/7/deactivate")?.dependencies).toEqual([]);
    expect(getDynamicRouteMatch("/api/api-keys/7/rotate")?.dependencies).toEqual(["apiKeyHashPepper"]);
  });

  it("keeps the shared dynamic descriptor table aligned with worker dependency hydration", () => {
    expect(getDynamicEndpointDescriptorByKey("stablecoin-detail")?.routeDependencies).toEqual(["coingeckoApiKey"]);
    expect(getDynamicEndpointDescriptorByKey("stablecoin-summary")?.routeDependencies).toEqual([]);
    expect(getDynamicEndpointDescriptorByKey("stablecoin-reserves")?.routeDependencies).toEqual([]);
    expect(getDynamicEndpointDescriptorByKey("discovery-candidate-dismiss")?.routeDependencies).toEqual(
      getDynamicRouteMatch("/api/discovery-candidates/42/dismiss")?.dependencies,
    );
    expect(getDynamicEndpointDescriptorByKey("api-key-update")?.routeDependencies).toEqual(
      getDynamicRouteMatch("/api/api-keys/7/update")?.dependencies,
    );
    expect(getDynamicEndpointDescriptorByKey("api-key-deactivate")?.routeDependencies).toEqual(
      getDynamicRouteMatch("/api/api-keys/7/deactivate")?.dependencies,
    );
    expect(getDynamicEndpointDescriptorByKey("api-key-rotate")?.routeDependencies).toEqual(
      getDynamicRouteMatch("/api/api-keys/7/rotate")?.dependencies,
    );
  });
});
