import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DYNAMIC_ENDPOINT_DESCRIPTORS,
  DYNAMIC_ENDPOINT_ACCESS_POLICIES,
  DYNAMIC_ENDPOINT_DEPENDENCY_HYDRATION_POLICIES,
  DYNAMIC_ENDPOINT_ROUTE_DEFINITIONS,
  getEndpointDefinitionByKey,
  API_PATHS,
  getSiteDataAccess,
  getPublicApiAccess,
  getEndpointProbeDescriptors,
  getEndpointProbePaths,
  getProbePaths,
  getStatusPageActions,
  ENDPOINT_DEFINITIONS,
  ENDPOINT_DEFINITION_PROBES,
  ENDPOINT_DEPENDENCY_HYDRATION_POLICIES,
  findDynamicEndpointDescriptor,
  getDynamicEndpointDescriptorByKey,
  PUBLIC_API_ENDPOINT_DEFINITIONS,
  STATIC_ENDPOINT_ACCESS_POLICIES,
  STATIC_ENDPOINT_CACHE_POLICIES,
  STATIC_ENDPOINT_DEPENDENCY_HYDRATION_POLICIES,
  STATIC_ENDPOINT_ROUTE_DEFINITIONS,
  getStaticEndpointDependenciesByKey,
  isAdminLikePath,
  isAdminPath,
  isCacheBypassPath,
  isStaticEndpointPath,
  isMutatingAdminPath,
  isProtectedPublicApiPath,
  isSiteDataAllowedPath,
  matchDynamicAdminEndpoint,
  validateEndpointMethod,
} from "@shared/lib/api-endpoints";
import { STRICT_CONTRACT_PATHS_LIST } from "@shared/lib/api-endpoints";
import { ENDPOINT_ASSERTIONS, assertPathCoverage } from "../../../scripts/maintenance/smoke-api.mjs";

describe("api endpoint registry", () => {
  it("keeps every endpoint path, probe path, and status action path explicitly covered", () => {
    const expectedPaths = [
      "/api/admin-action-log",
      "/api/admin-safety-score-v9",
      "/api/admin-safety-score-v9/history-boundary",
      "/api/admin-safety-score-v9/reviews",
      "/api/admin-telegram-adoption-report",
      "/api/admin-telegram-broadcast",
      "/api/admin-telegram-delivery-control",
      "/api/admin-telegram-resend",
      "/api/admin/reserve-recovery-fault-injection",
      "/api/api-key-requests",
      "/api/api-key-requests-admin",
      "/api/api-key-requests/verify",
      "/api/api-keys",
      "/api/api-keys/audit-log",
      "/api/api-keys/lifecycle-summary",
      "/api/audit-depeg-history",
      "/api/audit-depeg-history?dry-run=true",
      "/api/backfill-blacklist-current-balances",
      "/api/backfill-cg-prices",
      "/api/backfill-depegs",
      "/api/backfill-dews",
      "/api/backfill-mint-burn",
      "/api/backfill-mint-burn-prices",
      "/api/backfill-stability-index",
      "/api/backfill-supply-history",
      "/api/backfill-tape",
      "/api/backfill-yield-history",
      "/api/blacklist",
      "/api/blacklist-summary",
      "/api/bluechip-ratings",
      "/api/chains",
      "/api/daily-digest",
      "/api/debug-sync-state",
      "/api/depeg-events",
      "/api/depeg-resolver",
      "/api/depeg-resolver-review",
      "/api/dex-liquidity",
      "/api/dex-liquidity-history",
      "/api/dex-liquidity-history?stablecoin=usdt-tether",
      "/api/digest-archive",
      "/api/digest-snapshot",
      "/api/events",
      "/api/feedback",
      "/api/health",
      "/api/kill-cron-in-flight",
      "/api/mint-burn-events",
      "/api/mint-burn-events?stablecoin=usdt-tether",
      "/api/mint-burn-flows",
      "/api/non-usd-share",
      "/api/non-usd-share?days=90",
      "/api/peg-summary",
      "/api/public-status-history",
      "/api/reclassify-atomic-roundtrips",
      "/api/redemption-backstops",
      "/api/remediate-blacklist-amount-gaps",
      "/api/report-cards",
      "/api/report-cards/v9",
      "/api/report-cards/v9-preview",
      "/api/report-cards/v9-preview-412d818c031b7bc5",
      "/api/request-source-stats",
      "/api/reset-blacklist-sync",
      "/api/reset-circuit-breaker",
      "/api/reset-cron-lease",
      "/api/safety-score-history",
      "/api/safety-score-history-v2",
      "/api/safety-score-history-v2?stablecoin=usdt-tether&days=3650",
      "/api/safety-score-history?stablecoin=usdt-tether",
      "/api/snapshot/:date/stablecoin/:id",
      "/api/snapshots/:date.json",
      "/api/snapshots/index",
      "/api/stability-index",
      "/api/stablecoin-charts",
      "/api/stablecoin-reserves/:id",
      "/api/stablecoin-reserves/iusd-infinifi",
      "/api/stablecoin-summary/:id",
      "/api/stablecoin-summary/usdt-tether",
      "/api/stablecoin/:id",
      "/api/stablecoin/pyusd-paypal",
      "/api/stablecoins",
      "/api/status",
      "/api/status-history",
      "/api/status-history?limit=10",
      "/api/status-probe-history",
      "/api/status-probe-history?path=%2Fapi%2Fhealth",
      "/api/stress-signals",
      "/api/supply-history",
      "/api/supply-history?stablecoin=usdt-tether",
      "/api/telegram-mini-app/mutate",
      "/api/telegram-mini-app/session",
      "/api/telegram-pending",
      "/api/telegram-pulse",
      "/api/telegram-webhook",
      "/api/trigger-digest",
      "/api/usds-status",
      "/api/yield-adapter-manifest",
      "/api/yield-history",
      "/api/yield-history?stablecoin=usdt-tether",
      "/api/yield-rankings",
      "/api/yield-source-decisions",
    ];

    const actualPaths = [
      ...new Set(
        ENDPOINT_DEFINITIONS.flatMap((endpoint) =>
          [endpoint.path, endpoint.probePath, endpoint.statusPageAction?.path].filter(
            (path): path is string => typeof path === "string",
          ),
        ),
      ),
    ].sort();

    expect(actualPaths).toEqual(expectedPaths);
  });

  it("keeps probe path groups stable", () => {
    expect(getProbePaths("public")).toEqual([
      "/api/stablecoins",
      "/api/stablecoin/pyusd-paypal",
      "/api/stablecoin-summary/usdt-tether",
      "/api/stablecoin-reserves/iusd-infinifi",
      "/api/stablecoin-charts",
      "/api/peg-summary",
      "/api/health",
      "/api/public-status-history",
      "/api/blacklist",
      "/api/blacklist-summary",
      "/api/depeg-events",
      "/api/events",
      "/api/usds-status",
      "/api/bluechip-ratings",
      "/api/dex-liquidity",
      "/api/dex-liquidity-history?stablecoin=usdt-tether",
      "/api/supply-history?stablecoin=usdt-tether",
      "/api/daily-digest",
      "/api/digest-archive",
      "/api/snapshots/index",
      "/api/yield-rankings",
      "/api/yield-adapter-manifest",
      "/api/yield-history?stablecoin=usdt-tether",
      "/api/safety-score-history?stablecoin=usdt-tether",
      "/api/safety-score-history-v2?stablecoin=usdt-tether&days=3650",
      "/api/stability-index",
      "/api/report-cards",
      "/api/depeg-resolver",
      "/api/depeg-resolver-review",
      "/api/redemption-backstops",
      "/api/mint-burn-flows",
      "/api/mint-burn-events?stablecoin=usdt-tether",
      "/api/stress-signals",
      "/api/chains",
      "/api/non-usd-share?days=90",
      "/api/telegram-pulse",
    ]);

    expect(getProbePaths("admin")).toEqual([
      "/api/status",
      "/api/status-history?limit=10",
      "/api/debug-sync-state",
      "/api/admin-telegram-adoption-report",
      "/api/status-probe-history?path=%2Fapi%2Fhealth",
    ]);

    expect(getProbePaths("manual")).toEqual([
      "/api/report-cards/v9",
      "/api/report-cards/v9-preview",
      "/api/report-cards/v9-preview-412d818c031b7bc5",
      "/api/trigger-digest",
      "/api/reset-blacklist-sync",
      "/api/remediate-blacklist-amount-gaps",
      "/api/backfill-blacklist-current-balances",
      "/api/backfill-depegs",
      "/api/backfill-supply-history",
      "/api/backfill-cg-prices",
      "/api/backfill-yield-history",
      "/api/backfill-stability-index",
      "/api/backfill-mint-burn-prices",
      "/api/backfill-mint-burn",
      "/api/backfill-tape",
      "/api/reclassify-atomic-roundtrips",
      "/api/audit-depeg-history?dry-run=true",
      "/api/backfill-dews",
      "/api/reset-cron-lease",
      "/api/reset-circuit-breaker",
      "/api/kill-cron-in-flight",
      "/api/admin/reserve-recovery-fault-injection",
      "/api/telegram-pending",
      "/api/admin-telegram-resend",
      "/api/admin-telegram-broadcast",
      "/api/admin-telegram-delivery-control",
      "/api/admin-safety-score-v9/reviews",
      "/api/admin-safety-score-v9/history-boundary",
    ]);
  });

  it("excludes digest snapshot from auto-probe coverage because it requires an explicit date", () => {
    expect(getProbePaths("public")).not.toContain("/api/digest-snapshot");
    expect(getProbePaths("public")).not.toContain("/api/snapshots/:date.json");
    expect(getProbePaths("public")).not.toContain("/api/snapshot/:date/stablecoin/:id");
  });

  it("derives static route definitions from literal endpoint paths", () => {
    const expectedStaticKeys = ENDPOINT_DEFINITIONS.filter((endpoint) => isStaticEndpointPath(endpoint.path)).map(
      (endpoint) => endpoint.key,
    );

    expect(STATIC_ENDPOINT_ROUTE_DEFINITIONS.map((endpoint) => endpoint.key)).toEqual(expectedStaticKeys);
    expect(STATIC_ENDPOINT_ROUTE_DEFINITIONS.every((endpoint) => isStaticEndpointPath(endpoint.path))).toBe(true);
    expect(STATIC_ENDPOINT_ROUTE_DEFINITIONS.map((endpoint) => endpoint.key)).not.toContain("stablecoin-detail");

    expect(DYNAMIC_ENDPOINT_ROUTE_DEFINITIONS).toEqual(
      DYNAMIC_ENDPOINT_DESCRIPTORS.map((descriptor) => ({
        scope: "dynamic",
        key: descriptor.key,
        pattern: descriptor.pattern,
        methods: descriptor.methods,
        dependencies: descriptor.routeDependencies,
      })),
    );
  });

  it("derives static and dynamic access policies without changing metadata", () => {
    expect(STATIC_ENDPOINT_ACCESS_POLICIES).toEqual(
      STATIC_ENDPOINT_ROUTE_DEFINITIONS.map((endpoint) => ({
        scope: "static",
        key: endpoint.key,
        path: endpoint.path,
        methods: endpoint.methods,
        adminRequired: endpoint.adminRequired,
        publicApiAccess: endpoint.publicApiAccess,
        siteDataAccess: endpoint.siteDataAccess,
      })),
    );

    expect(DYNAMIC_ENDPOINT_ACCESS_POLICIES).toEqual(
      DYNAMIC_ENDPOINT_DESCRIPTORS.map((descriptor) => ({
        scope: "dynamic",
        key: descriptor.key,
        pattern: descriptor.pattern,
        routePath: descriptor.requestAttribution?.routePath ?? null,
        methods: descriptor.methods,
        adminRequired: descriptor.adminRequired,
        publicApiAccess: descriptor.publicApiAccess,
        siteDataAccess: descriptor.siteDataAccess,
      })),
    );
  });

  it("derives static cache policies without adding dynamic cache behavior", () => {
    expect(STATIC_ENDPOINT_CACHE_POLICIES).toEqual(
      STATIC_ENDPOINT_ROUTE_DEFINITIONS.map((endpoint) => ({
        scope: "static",
        key: endpoint.key,
        path: endpoint.path,
        cacheBypass: endpoint.cacheBypass,
      })),
    );
    expect(STATIC_ENDPOINT_CACHE_POLICIES.some((policy) => policy.key === "stablecoin-detail")).toBe(false);
  });

  it("derives public API endpoint definitions for static and dynamic public routes", () => {
    const staticPublicKeys = STATIC_ENDPOINT_ROUTE_DEFINITIONS.filter(
      (endpoint) => !endpoint.adminRequired && endpoint.path.startsWith("/api/"),
    ).map((endpoint) => endpoint.key);
    const dynamicPublicKeys = DYNAMIC_ENDPOINT_DESCRIPTORS.filter((descriptor) => !descriptor.adminRequired).map(
      (descriptor) => descriptor.key,
    );

    expect(
      PUBLIC_API_ENDPOINT_DEFINITIONS.filter((definition) => definition.scope === "static").map(
        (definition) => definition.key,
      ),
    ).toEqual(staticPublicKeys);
    expect(
      PUBLIC_API_ENDPOINT_DEFINITIONS.filter((definition) => definition.scope === "dynamic").map(
        (definition) => definition.key,
      ),
    ).toEqual(dynamicPublicKeys);
    expect(PUBLIC_API_ENDPOINT_DEFINITIONS).toContainEqual(
      expect.objectContaining({ scope: "dynamic", key: "og-image", publicApiAccess: "exempt" }),
    );
    expect(PUBLIC_API_ENDPOINT_DEFINITIONS.some((definition) => definition.key === "status")).toBe(false);
    expect(PUBLIC_API_ENDPOINT_DEFINITIONS.some((definition) => definition.key === "api-key-update")).toBe(false);
  });

  it("derives probe definitions from endpoint metadata", () => {
    expect(ENDPOINT_DEFINITION_PROBES).toEqual(
      ENDPOINT_DEFINITIONS.flatMap((endpoint) => {
        if (!endpoint.probeGroup) return [];
        return [
          {
            source: "endpoint-definition",
            key: endpoint.key,
            definitionPath: endpoint.path,
            path: endpoint.probePath ?? endpoint.path,
            group: endpoint.probeGroup,
            ...(endpoint.probeSemanticKind ? { probeSemanticKind: endpoint.probeSemanticKind } : {}),
          },
        ];
      }),
    );
    expect(getEndpointProbeDescriptors("public")).toEqual(
      ENDPOINT_DEFINITION_PROBES.filter((probe) => probe.group === "public").map((probe) => ({
        path: probe.path,
        probeSemanticKind: probe.probeSemanticKind,
      })),
    );
    expect(getEndpointProbeDescriptors("admin")).toEqual(
      ENDPOINT_DEFINITION_PROBES.filter((probe) => probe.group === "admin").map((probe) => ({
        path: probe.path,
        probeSemanticKind: probe.probeSemanticKind,
      })),
    );
    expect(getEndpointProbeDescriptors("manual")).toEqual(
      ENDPOINT_DEFINITION_PROBES.filter((probe) => probe.group === "manual").map((probe) => ({
        path: probe.path,
        probeSemanticKind: probe.probeSemanticKind,
      })),
    );
    expect(getEndpointProbePaths("public")).toEqual(getProbePaths("public"));
    expect(getEndpointProbePaths("admin")).toEqual(getProbePaths("admin"));
    expect(getEndpointProbePaths("manual")).toEqual(getProbePaths("manual"));
  });

  it("declares semantic probe metadata only for health and status", () => {
    expect(
      ENDPOINT_DEFINITIONS.filter((endpoint) => endpoint.probeSemanticKind).map((endpoint) => ({
        key: endpoint.key,
        path: endpoint.path,
        probeSemanticKind: endpoint.probeSemanticKind,
      })),
    ).toEqual([
      { key: "health", path: "/api/health", probeSemanticKind: "health" },
      { key: "status", path: "/api/status", probeSemanticKind: "status" },
    ]);

    expect(getEndpointProbeDescriptors("public").filter((probe) => probe.probeSemanticKind)).toEqual([
      { path: "/api/health", probeSemanticKind: "health" },
    ]);
    expect(getEndpointProbeDescriptors("admin").filter((probe) => probe.probeSemanticKind)).toEqual([
      { path: "/api/status", probeSemanticKind: "status" },
    ]);
    expect(getEndpointProbeDescriptors("manual").filter((probe) => probe.probeSemanticKind)).toEqual([]);
  });

  it("derives static and dynamic dependency hydration policies", () => {
    expect(STATIC_ENDPOINT_DEPENDENCY_HYDRATION_POLICIES).toEqual(
      STATIC_ENDPOINT_ROUTE_DEFINITIONS.map((endpoint) => ({
        scope: "static",
        key: endpoint.key,
        path: endpoint.path,
        dependencies: endpoint.routeDependencies ?? [],
      })),
    );
    expect(DYNAMIC_ENDPOINT_DEPENDENCY_HYDRATION_POLICIES).toEqual(
      DYNAMIC_ENDPOINT_DESCRIPTORS.map((descriptor) => ({
        scope: "dynamic",
        key: descriptor.key,
        pattern: descriptor.pattern,
        routePath: descriptor.requestAttribution?.routePath ?? null,
        dependencies: descriptor.routeDependencies,
      })),
    );
    expect(ENDPOINT_DEPENDENCY_HYDRATION_POLICIES).toHaveLength(
      STATIC_ENDPOINT_DEPENDENCY_HYDRATION_POLICIES.length + DYNAMIC_ENDPOINT_DEPENDENCY_HYDRATION_POLICIES.length,
    );
    expect(getStaticEndpointDependenciesByKey("status")).toEqual([
      "coingeckoApiKey",
      "cloudflareD1StatusConfig",
      "workerStatusConfig",
    ]);
    expect(getStaticEndpointDependenciesByKey("stablecoin-detail")).toBeUndefined();
  });

  it("flags mutating admin paths for method guards", () => {
    expect(isMutatingAdminPath("/api/backfill-depegs")).toBe(true);
    expect(isMutatingAdminPath("/api/backfill-mint-burn")).toBe(true);
    expect(isMutatingAdminPath("/api/trigger-digest")).toBe(true);
    expect(isMutatingAdminPath("/api/backfill-dews")).toBe(true);
    expect(isMutatingAdminPath("/api/stablecoins")).toBe(false);
  });

  it("flags cache-bypass paths for edge cache skip rules", () => {
    expect(isCacheBypassPath("/api/health")).toBe(false);
    expect(isCacheBypassPath("/api/status")).toBe(true);
    expect(isCacheBypassPath("/api/backfill-dews")).toBe(true);
    expect(isCacheBypassPath("/api/feedback")).toBe(true);
    expect(isCacheBypassPath("/api/api-key-requests")).toBe(true);
    expect(isCacheBypassPath("/api/api-key-requests/verify")).toBe(true);
    expect(isCacheBypassPath("/api/telegram-mini-app/session")).toBe(true);
    expect(isCacheBypassPath("/api/telegram-mini-app/mutate")).toBe(true);
    expect(isCacheBypassPath("/api/stablecoins")).toBe(false);
    expect(getPublicApiAccess("/api/health")).toBe("exempt");
  });

  it("matches dynamic admin routes from the shared registry", () => {
    expect(matchDynamicAdminEndpoint("/api/api-keys/7/update")).toEqual({
      key: "api-key-update",
      path: "/api/api-keys/7/update",
      apiKeyId: 7,
      methods: ["POST"],
    });
    expect(matchDynamicAdminEndpoint("/api/api-key-requests-admin/akr_abc12345/reject")).toEqual({
      key: "api-key-request-reject",
      path: "/api/api-key-requests-admin/akr_abc12345/reject",
      requestId: "akr_abc12345",
      methods: ["POST"],
    });
    expect(matchDynamicAdminEndpoint("/api/api-key-requests-admin/akr_abc12345/release-claim")).toEqual({
      key: "api-key-request-release-claim",
      path: "/api/api-key-requests-admin/akr_abc12345/release-claim",
      requestId: "akr_abc12345",
      methods: ["POST"],
    });
    expect(matchDynamicAdminEndpoint("/api/api-keys/0/update")).toBeNull();
    expect(matchDynamicAdminEndpoint("/api/api-keys/9007199254740992/update")).toBeNull();
    expect(isAdminPath("/api/status")).toBe(true);
    expect(isAdminPath("/api/api-keys")).toBe(true);
    expect(isAdminPath("/api/request-source-stats")).toBe(true);
    expect(isAdminPath("/api/api-key-requests-admin")).toBe(true);
    expect(isAdminPath("/api/api-key-requests-admin/akr_abc12345/reject")).toBe(true);
    expect(isAdminPath("/api/api-keys/0/update")).toBe(false);
    expect(isAdminPath("/api/stablecoins")).toBe(false);
  });

  it("flags malformed admin-family paths before descriptor matching", () => {
    expect(isAdminLikePath("/api/status")).toBe(true);
    expect(isAdminLikePath("/api/status/extra")).toBe(true);
    expect(isAdminLikePath("/api/api-keys")).toBe(true);
    expect(isAdminLikePath("/api/api-keys/0/update")).toBe(true);
    expect(isAdminLikePath("/api/api-keys/not-a-number/rotate")).toBe(true);
    expect(isAdminLikePath("/api/api-key-requests-admin")).toBe(true);
    expect(isAdminLikePath("/api/api-key-requests-admin/bad!/reject")).toBe(true);
    expect(isAdminLikePath("/api/api-key-requests")).toBe(false);
    expect(isAdminLikePath("/api/api-key-requests/verify")).toBe(false);
    expect(isAdminLikePath("/api/stablecoins")).toBe(false);
    expect(isAdminLikePath("/api/api-key-requests-administer")).toBe(false);
  });

  it("keeps the shared dynamic descriptor table aligned with current access and dependency policies", () => {
    expect(DYNAMIC_ENDPOINT_DESCRIPTORS).toHaveLength(12);

    expect(findDynamicEndpointDescriptor("/api/stablecoin/usdt-tether")).toMatchObject({
      key: "stablecoin-detail",
      publicApiAccess: "protected",
      siteDataAccess: "allowed",
      adminRequired: false,
      routeDependencies: ["coingeckoApiKey"],
      requestAttribution: {
        routeKey: "stablecoin-detail",
        routePath: "/api/stablecoin/:id",
      },
    });
    expect(findDynamicEndpointDescriptor("/api/stablecoin-summary/usdc-circle")).toMatchObject({
      key: "stablecoin-summary",
      publicApiAccess: "protected",
      siteDataAccess: "allowed",
      adminRequired: false,
      routeDependencies: [],
    });
    expect(findDynamicEndpointDescriptor("/api/stablecoin-reserves/iusd-infinifi")).toMatchObject({
      key: "stablecoin-reserves",
      publicApiAccess: "protected",
      siteDataAccess: "allowed",
      adminRequired: false,
      routeDependencies: [],
    });
    expect(findDynamicEndpointDescriptor("/api/og/stablecoin/usdt-tether")).toMatchObject({
      key: "og-image",
      methods: ["GET"],
      publicApiAccess: "exempt",
      siteDataAccess: "denied",
      adminRequired: false,
      routeDependencies: [],
    });
    expect(getDynamicEndpointDescriptorByKey("api-key-rotate")).toMatchObject({
      methods: ["POST"],
      adminRequired: true,
      routeDependencies: ["apiKeyHashPepper"],
    });
    expect(getDynamicEndpointDescriptorByKey("api-key-request-reject")).toMatchObject({
      methods: ["POST"],
      adminRequired: true,
      routeDependencies: [],
      siteDataAccess: "denied",
    });
    expect(getDynamicEndpointDescriptorByKey("admin-telegram-chat")).toMatchObject({
      methods: ["GET"],
      adminRequired: true,
      routeDependencies: [],
      publicApiAccess: "exempt",
      siteDataAccess: "denied",
    });

    expect(getPublicApiAccess("/api/stablecoin/usdt-tether")).toBe("protected");
    expect(getSiteDataAccess("/api/stablecoin/usdt-tether")).toBe("allowed");
    expect(getPublicApiAccess("/api/og/stablecoin/usdt-tether")).toBe("exempt");
    expect(getSiteDataAccess("/api/og/stablecoin/usdt-tether")).toBe("denied");
    expect(getPublicApiAccess("/api/api-keys/0/update")).toBeNull();
    expect(getSiteDataAccess("/api/api-keys/0/update")).toBeNull();
  });

  it("validates endpoint methods from shared definitions", () => {
    expect(API_PATHS.yieldRankingsSummary()).toBe("/api/yield-rankings?projection=summary");
    expect(
      validateEndpointMethod(new URL(`https://api.pharos.watch${API_PATHS.yieldRankingsSummary()}`), "GET"),
    ).toBeNull();
    expect(validateEndpointMethod(new URL("https://api.pharos.watch/api/stablecoins"), "GET")).toBeNull();
    expect(validateEndpointMethod(new URL("https://api.pharos.watch/api/feedback"), "POST")).toBeNull();
    expect(validateEndpointMethod(new URL("https://api.pharos.watch/api/api-key-requests"), "POST")).toBeNull();
    expect(validateEndpointMethod(new URL("https://api.pharos.watch/api/api-key-requests/verify"), "POST")).toBeNull();
    expect(
      validateEndpointMethod(new URL("https://api.pharos.watch/api/telegram-mini-app/session"), "POST"),
    ).toBeNull();
    expect(validateEndpointMethod(new URL("https://api.pharos.watch/api/telegram-mini-app/mutate"), "POST")).toBeNull();
    expect(validateEndpointMethod(new URL("https://api.pharos.watch/api/api-key-requests-admin"), "GET")).toBeNull();
    expect(validateEndpointMethod(new URL("https://api.pharos.watch/api/api-keys"), "GET")).toBeNull();
    expect(validateEndpointMethod(new URL("https://api.pharos.watch/api/api-keys"), "POST")).toBeNull();
    expect(validateEndpointMethod(new URL("https://api.pharos.watch/api/request-source-stats"), "GET")).toBeNull();
    expect(validateEndpointMethod(new URL("https://api.pharos.watch/api/stablecoin/1"), "GET")).toBeNull();
    expect(validateEndpointMethod(new URL("https://api.pharos.watch/api/og/stablecoin/usdt-tether"), "HEAD")).toEqual({
      message: "Method not allowed",
      allowedMethods: ["GET"],
    });
    expect(validateEndpointMethod(new URL("https://api.pharos.watch/api/stablecoin-summary/1"), "GET")).toBeNull();
    expect(validateEndpointMethod(new URL("https://api.pharos.watch/api/api-keys/1/update"), "POST")).toBeNull();
    expect(validateEndpointMethod(new URL("https://api.pharos.watch/api/api-keys/1/deactivate"), "POST")).toBeNull();
    expect(validateEndpointMethod(new URL("https://api.pharos.watch/api/api-keys/1/rotate"), "POST")).toBeNull();
    expect(
      validateEndpointMethod(
        new URL("https://api.pharos.watch/api/api-key-requests-admin/akr_abc12345/reject"),
        "POST",
      ),
    ).toBeNull();
    expect(
      validateEndpointMethod(new URL("https://api.pharos.watch/api/audit-depeg-history?dry-run=true"), "GET"),
    ).toBeNull();
    expect(validateEndpointMethod(new URL("https://api.pharos.watch/api/backfill-dews"), "GET")).toBeNull();
    expect(
      validateEndpointMethod(
        new URL("https://api.pharos.watch/api/backfill-dews?repair=refresh-current&dry-run=true"),
        "GET",
      ),
    ).toBeNull();
    expect(validateEndpointMethod(new URL("https://api.pharos.watch/api/backfill-dews"), "POST")).toBeNull();

    expect(validateEndpointMethod(new URL("https://api.pharos.watch/api/stablecoins"), "POST")).toEqual({
      message: "Method not allowed",
      allowedMethods: ["GET"],
    });
    expect(validateEndpointMethod(new URL("https://api.pharos.watch/api/stablecoins"), "HEAD")).toEqual({
      message: "Method not allowed",
      allowedMethods: ["GET"],
    });
    expect(validateEndpointMethod(new URL("https://api.pharos.watch/api/trigger-digest"), "GET")).toEqual({
      message: "Method not allowed. Use POST for this endpoint.",
      allowedMethods: ["POST"],
    });
    expect(
      validateEndpointMethod(new URL("https://api.pharos.watch/api/backfill-dews?repair=refresh-current"), "GET"),
    ).toEqual({
      message: "Method not allowed. Use POST for this endpoint.",
      allowedMethods: ["POST"],
    });
    expect(validateEndpointMethod(new URL("https://api.pharos.watch/api/audit-depeg-history"), "GET")).toEqual({
      message: "Method not allowed. Use POST for this endpoint.",
      allowedMethods: ["POST"],
    });
    expect(validateEndpointMethod(new URL("https://api.pharos.watch/api/feedback"), "GET")).toEqual({
      message: "Method not allowed. Use POST for this endpoint.",
      allowedMethods: ["POST"],
    });
    expect(validateEndpointMethod(new URL("https://api.pharos.watch/api/api-key-requests"), "GET")).toEqual({
      message: "Method not allowed. Use POST for this endpoint.",
      allowedMethods: ["POST"],
    });
    expect(validateEndpointMethod(new URL("https://api.pharos.watch/api/telegram-mini-app/session"), "GET")).toEqual({
      message: "Method not allowed. Use POST for this endpoint.",
      allowedMethods: ["POST"],
    });
    expect(validateEndpointMethod(new URL("https://api.pharos.watch/api/api-key-requests-admin"), "POST")).toEqual({
      message: "Method not allowed",
      allowedMethods: ["GET"],
    });
    expect(validateEndpointMethod(new URL("https://api.pharos.watch/api/api-keys/1/rotate"), "GET")).toEqual({
      message: "Method not allowed. Use POST for this endpoint.",
      allowedMethods: ["POST"],
    });
    expect(validateEndpointMethod(new URL("https://api.pharos.watch/api/unknown"), "POST")).toEqual({
      message: "Method not allowed",
      allowedMethods: ["GET"],
    });
    expect(validateEndpointMethod(new URL("https://api.pharos.watch/api/stablecoins"), "DELETE")).toEqual({
      message: "Method not allowed",
      allowedMethods: ["GET", "POST"],
    });
  });

  it("keeps public-auth and site-data policies aligned", () => {
    expect(getPublicApiAccess("/api/stablecoins")).toBe("protected");
    expect(getPublicApiAccess("/api/health")).toBe("exempt");
    expect(getPublicApiAccess("/api/api-key-requests")).toBe("exempt");
    expect(getPublicApiAccess("/api/api-key-requests/verify")).toBe("exempt");
    expect(getPublicApiAccess("/api/telegram-mini-app/session")).toBe("exempt");
    expect(getPublicApiAccess("/api/telegram-mini-app/mutate")).toBe("exempt");
    expect(getPublicApiAccess("/api/public-status-history")).toBe("protected");
    expect(getPublicApiAccess("/api/events")).toBe("protected");
    expect(getPublicApiAccess("/api/telegram-pulse")).toBe("protected");
    expect(getPublicApiAccess("/api/og/stablecoin/usdt-tether")).toBe("exempt");
    expect(isProtectedPublicApiPath("/api/stablecoins")).toBe(true);
    expect(isProtectedPublicApiPath("/api/health")).toBe(false);
    expect(isProtectedPublicApiPath("/api/public-status-history")).toBe(true);
    expect(isProtectedPublicApiPath("/api/telegram-pulse")).toBe(true);
    expect(getSiteDataAccess("/api/stablecoins")).toBe("allowed");
    expect(getSiteDataAccess("/api/public-status-history")).toBe("allowed");
    expect(getSiteDataAccess("/api/events")).toBe("allowed");
    expect(getSiteDataAccess("/api/telegram-pulse")).toBe("allowed");
    expect(getSiteDataAccess("/api/api-key-requests")).toBe("denied");
    expect(getSiteDataAccess("/api/api-key-requests/verify")).toBe("denied");
    expect(getSiteDataAccess("/api/telegram-mini-app/session")).toBe("denied");
    expect(getSiteDataAccess("/api/telegram-mini-app/mutate")).toBe("denied");
    expect(getSiteDataAccess("/api/api-key-requests-admin")).toBe("denied");
    expect(getSiteDataAccess("/api/stablecoin-summary/usdt-tether")).toBe("allowed");
    expect(isSiteDataAllowedPath("/api/stablecoins")).toBe(true);
    expect(isSiteDataAllowedPath("/api/stablecoin/usdt-tether")).toBe(true);
    expect(isSiteDataAllowedPath("/api/stablecoin-summary/usdt-tether")).toBe(true);
    expect(isSiteDataAllowedPath("/api/public-status-history")).toBe(true);
    expect(isSiteDataAllowedPath("/api/events")).toBe(true);
    expect(isSiteDataAllowedPath("/api/telegram-pulse")).toBe(true);
    expect(isSiteDataAllowedPath("/api/status")).toBe(false);
  });

  it("provides status-page actions in UI order", () => {
    expect(getStatusPageActions()).toMatchObject([
      {
        label: "Trigger Digest",
        path: "/api/trigger-digest",
        confirm: "Trigger daily digest? Bypasses 1h dedup window.",
        destructive: false,
        method: "POST",
        acceptsStablecoinFilter: false,
        group: "communications",
      },
      {
        label: "Reset Blacklist Sync",
        path: "/api/reset-blacklist-sync",
        confirm: "Reset blacklist sync? Rolls back EVM 50k blocks, Tron 7 days.",
        destructive: true,
        method: "POST",
        acceptsStablecoinFilter: false,
        group: "recovery",
      },
      {
        label: "Debug Sync State",
        path: "/api/debug-sync-state",
        confirm: "Fetch sync state debug dump?",
        destructive: false,
        method: "GET",
        acceptsStablecoinFilter: false,
        group: "audit",
      },
      {
        label: "Remediate Blacklist Gaps",
        path: "/api/remediate-blacklist-amount-gaps",
        confirm: "Run targeted blacklist amount-gap remediation? Prefer dry-run first.",
        destructive: false,
        method: "POST",
        acceptsStablecoinFilter: true,
        group: "recovery",
      },
      {
        label: "Backfill Blacklist Balances",
        path: "/api/backfill-blacklist-current-balances",
        confirm: "Backfill current-balance cache for coins missing balance rows?",
        destructive: false,
        method: "POST",
        acceptsStablecoinFilter: true,
        group: "recovery",
      },
      {
        label: "Backfill Depegs",
        path: "/api/backfill-depegs",
        confirm: "Run depeg backfill? This may take several minutes.",
        destructive: false,
        method: "POST",
        acceptsStablecoinFilter: true,
        group: "recovery",
      },
      {
        label: "Backfill Supply",
        path: "/api/backfill-supply-history",
        confirm: "Backfill supply history snapshots?",
        destructive: false,
        method: "POST",
        acceptsStablecoinFilter: true,
        group: "recovery",
      },
      {
        label: "Backfill CG Prices",
        path: "/api/backfill-cg-prices",
        confirm: "Backfill CoinGecko prices?",
        destructive: false,
        method: "POST",
        acceptsStablecoinFilter: true,
        group: "recovery",
      },
      {
        label: "Backfill Yield History",
        path: "/api/backfill-yield-history",
        confirm: "Backfill protocol yield history?",
        destructive: false,
        method: "POST",
        acceptsStablecoinFilter: true,
        group: "recovery",
      },
      {
        label: "Backfill PSI",
        path: "/api/backfill-stability-index",
        confirm: "Backfill stability index history?",
        destructive: false,
        method: "POST",
        acceptsStablecoinFilter: false,
        group: "recovery",
      },
      {
        label: "Preview Mint/Burn Price Repair",
        path: "/api/backfill-mint-burn-prices",
        confirm: "Preview historical mint/burn USD price repairs for NULL events?",
        destructive: false,
        method: "POST",
        acceptsStablecoinFilter: true,
        group: "audit",
      },
      {
        label: "Backfill Mint/Burn",
        path: "/api/backfill-mint-burn",
        confirm: "Run mint/burn backfill job?",
        destructive: false,
        method: "POST",
        acceptsStablecoinFilter: false,
        group: "recovery",
      },
      {
        label: "Backfill Tape",
        path: "/api/backfill-tape",
        confirm: "Re-run tape projectors for selected classes?",
        destructive: false,
        method: "POST",
        acceptsStablecoinFilter: false,
        group: "recovery",
      },
      {
        label: "Reclassify Roundtrips",
        path: "/api/reclassify-atomic-roundtrips",
        confirm: "Reclassify atomic roundtrips in mint/burn data?",
        destructive: false,
        method: "POST",
        acceptsStablecoinFilter: true,
        group: "audit",
      },
      {
        label: "Audit Depegs",
        path: "/api/audit-depeg-history?dry-run=true",
        confirm: "Audit depeg history and review possible provenance repairs?",
        destructive: false,
        method: "GET",
        acceptsStablecoinFilter: true,
        group: "audit",
      },
      {
        label: "Validate DEWS History",
        path: "/api/backfill-dews",
        confirm: "Run the read-only DEWS historical backtest?",
        destructive: false,
        method: "GET",
        acceptsStablecoinFilter: false,
        group: "audit",
      },
    ]);
  });

  it("requires structured operator metadata for every status-page action", () => {
    const actions = getStatusPageActions();
    expect(actions).toHaveLength(16);

    for (const action of actions) {
      expect(action.kind).toMatch(/^(inspect|backfill|repair|reset|communication)$/);
      expect(action.risk).toMatch(/^(read-only|low|moderate|high)$/);
      expect(action.expectedDuration.length).toBeGreaterThan(0);
      expect(action.preconditions).toBeInstanceOf(Array);
      expect(action.blockedBy).toBeInstanceOf(Array);
      expect(action.resultMode).toMatch(/^(immediate|queued|continuation)$/);
      expect(action.acceptsStablecoinFilter).toBe(action.scope.type === "asset-or-batch");
      if (action.dryRun.supported) {
        expect(action.dryRun.default).toBe(true);
        expect(action.dryRun.queryParam).toMatch(/^(dry-run|dryRun)$/);
      } else {
        expect(action.dryRun.default).toBe(false);
      }
    }
  });

  it("limits status-action runbooks to known repository documents", () => {
    const allowedRunbookPaths = new Set([
      "docs/data-pipeline.md",
      "docs/depeg-detection.md",
      "docs/dews.md",
      "docs/mint-burn-flows.md",
      "docs/pricing-pipeline.md",
      "docs/stability-index.md",
      "docs/yield-intelligence.md",
    ]);
    const referencedRunbooks = getStatusPageActions().flatMap((action) =>
      action.runbookPath ? [action.runbookPath] : [],
    );

    expect(referencedRunbooks.length).toBeGreaterThan(0);
    for (const runbookPath of referencedRunbooks) {
      expect(allowedRunbookPaths.has(runbookPath)).toBe(true);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is constrained by the allowlist above.
      expect(existsSync(resolve(process.cwd(), runbookPath))).toBe(true);
    }
  });

  it("matches status-action dry-run metadata to implemented query and method contracts", () => {
    const dryRunContracts = Object.fromEntries(
      getStatusPageActions().flatMap((action) => {
        if (!action.dryRun.supported) return [];
        const dryRun = action.dryRun;
        return [
          [
            action.path,
            {
              queryParam: dryRun.queryParam,
              liveSupported: dryRun.liveSupported,
              dryRunMethod: dryRun.dryRunMethod ?? action.method,
              liveMethod: dryRun.liveMethod ?? action.method,
            },
          ],
        ];
      }),
    );

    expect(dryRunContracts).toEqual({
      "/api/remediate-blacklist-amount-gaps": {
        queryParam: "dryRun",
        liveSupported: true,
        dryRunMethod: "POST",
        liveMethod: "POST",
      },
      "/api/backfill-blacklist-current-balances": {
        queryParam: "dryRun",
        liveSupported: true,
        dryRunMethod: "POST",
        liveMethod: "POST",
      },
      "/api/backfill-depegs": {
        queryParam: "dry-run",
        liveSupported: true,
        dryRunMethod: "POST",
        liveMethod: "POST",
      },
      "/api/backfill-stability-index": {
        queryParam: "dry-run",
        liveSupported: true,
        dryRunMethod: "POST",
        liveMethod: "POST",
      },
      "/api/backfill-mint-burn-prices": {
        queryParam: "dry-run",
        liveSupported: false,
        dryRunMethod: "POST",
        liveMethod: "POST",
      },
      "/api/backfill-tape": {
        queryParam: "dryRun",
        liveSupported: true,
        dryRunMethod: "POST",
        liveMethod: "POST",
      },
      "/api/audit-depeg-history?dry-run=true": {
        queryParam: "dry-run",
        liveSupported: true,
        dryRunMethod: "GET",
        liveMethod: "POST",
      },
    });
  });

  it("does not infer status-page action paths from probe paths", () => {
    const actionPaths = new Set(getStatusPageActions().map((action) => action.path));

    for (const endpoint of ENDPOINT_DEFINITIONS) {
      if (!endpoint.statusPageAction || !endpoint.probePath || endpoint.statusPageAction.path) continue;
      expect(actionPaths.has(endpoint.probePath), endpoint.key).toBe(false);
      expect(actionPaths.has(endpoint.path), endpoint.key).toBe(true);
    }
  });

  it("keeps strict contract path list unique", () => {
    expect(new Set(STRICT_CONTRACT_PATHS_LIST).size).toBe(STRICT_CONTRACT_PATHS_LIST.length);
  });

  it("keeps smoke endpoint assertions aligned with strict contract paths", () => {
    expect(() => assertPathCoverage(STRICT_CONTRACT_PATHS_LIST, ENDPOINT_ASSERTIONS)).not.toThrow();
  });

  it("keeps dynamic descriptor access and dependency fields aligned with static definitions", () => {
    // These 5 endpoints appear in both DYNAMIC_ENDPOINT_DESCRIPTORS and ENDPOINT_DEFINITIONS.
    // Assert that access and dependency fields are kept in sync so a silent drift cannot occur.
    const overlappingKeys = [
      "stablecoin-detail",
      "stablecoin-summary",
      "stablecoin-reserves",
      "snapshot-day",
      "snapshot-coin",
    ] as const;

    for (const key of overlappingKeys) {
      const dynamic = DYNAMIC_ENDPOINT_DESCRIPTORS.find((d) => d.key === key);
      const staticDef = getEndpointDefinitionByKey(key);
      expect(dynamic, `dynamic descriptor missing for ${key}`).toBeDefined();
      expect(staticDef, `static definition missing for ${key}`).toBeDefined();
      if (!dynamic || !staticDef) continue;

      expect(dynamic.publicApiAccess, `publicApiAccess mismatch for ${key}`).toBe(staticDef.publicApiAccess);
      expect(dynamic.siteDataAccess, `siteDataAccess mismatch for ${key}`).toBe(staticDef.siteDataAccess);
      expect(dynamic.adminRequired, `adminRequired mismatch for ${key}`).toBe(staticDef.adminRequired);
      expect([...dynamic.routeDependencies].sort(), `routeDependencies mismatch for ${key}`).toEqual(
        [...(staticDef.routeDependencies ?? [])].sort(),
      );
    }
  });
});
