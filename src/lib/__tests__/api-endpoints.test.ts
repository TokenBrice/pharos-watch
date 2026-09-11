import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DYNAMIC_ENDPOINT_DESCRIPTORS,
  getEndpointDefinitionByKey,
  API_PATHS,
  getSiteDataAccess,
  getPublicApiAccess,
  getEndpointProbeDescriptors,
  getProbePaths,
  getStatusPageActions,
  ENDPOINT_DEFINITIONS,
  findDynamicEndpointDescriptor,
  getDynamicEndpointDescriptorByKey,
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
  it("publishes runnable probes in the correct security groups", () => {
    const publicPaths = getProbePaths("public");
    const adminPaths = getProbePaths("admin");
    const manualPaths = getProbePaths("manual");
    expect(publicPaths).toContain("/api/stablecoins");
    expect(publicPaths).toContain("/api/health");
    expect(publicPaths).toContain("/api/stablecoin/pyusd-paypal");
    expect(adminPaths).toEqual([
      "/api/status",
      "/api/status-history?limit=10",
      "/api/reserve-attempt-history?coin=usdc-circle&limit=10",
      "/api/debug-sync-state",
    ]);
    expect(manualPaths).toContain("/api/audit-depeg-history?dry-run=true");
    expect(manualPaths).toContain("/api/trigger-digest");
    for (const path of [...publicPaths, ...adminPaths, ...manualPaths]) {
      expect(path).not.toMatch(/:[a-z]/i);
      expect(path).toMatch(/^\/api\//);
    }
    for (const path of publicPaths) {
      expect(isAdminPath(new URL(path, "https://api.pharos.watch").pathname)).toBe(false);
      expect(adminPaths).not.toContain(path);
      expect(manualPaths).not.toContain(path);
    }
    for (const path of [...adminPaths, ...manualPaths]) {
      expect(isAdminPath(new URL(path, "https://api.pharos.watch").pathname)).toBe(true);
    }
  });

  it("excludes digest snapshot from auto-probe coverage because it requires an explicit date", () => {
    expect(getProbePaths("public")).not.toContain("/api/digest-snapshot");
    expect(getProbePaths("public")).not.toContain("/api/snapshots/:date.json");
    expect(getProbePaths("public")).not.toContain("/api/snapshot/:date/stablecoin/:id");
  });

  it("keeps dynamic endpoints out of the static route table", () => {
    expect(STATIC_ENDPOINT_ROUTE_DEFINITIONS.every((endpoint) => isStaticEndpointPath(endpoint.path))).toBe(true);
    expect(STATIC_ENDPOINT_ROUTE_DEFINITIONS.map((endpoint) => endpoint.key)).not.toContain("stablecoin-detail");
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

  it("resolves static endpoint dependency policies by key", () => {
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
    expect(DYNAMIC_ENDPOINT_DESCRIPTORS).toHaveLength(11);

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
    expect(getPublicApiAccess("/api/stablecoin/usdt-tether")).toBe("protected");
    expect(getSiteDataAccess("/api/stablecoin/usdt-tether")).toBe("allowed");
    expect(getPublicApiAccess("/api/og/stablecoin/usdt-tether")).toBe("exempt");
    expect(getSiteDataAccess("/api/og/stablecoin/usdt-tether")).toBe("denied");
    expect(getPublicApiAccess("/api/api-keys/0/update")).toBeNull();
    expect(getSiteDataAccess("/api/api-keys/0/update")).toBeNull();
  });

  it("builds the yield summary projection path", () => {
    expect(API_PATHS.yieldRankingsSummary()).toBe("/api/yield-rankings?projection=summary");
  });

  it.each([
    ["/api/yield-rankings?projection=summary", "GET"],
    ["/api/stablecoins", "GET"],
    ["/api/feedback", "POST"],
    ["/api/api-key-requests", "POST"],
    ["/api/api-key-requests/verify", "POST"],
    ["/api/telegram-mini-app/session", "POST"],
    ["/api/telegram-mini-app/mutate", "POST"],
    ["/api/api-key-requests-admin", "GET"],
    ["/api/api-keys", "GET"],
    ["/api/api-keys", "POST"],
    ["/api/request-source-stats", "GET"],
    ["/api/stablecoin/1", "GET"],
    ["/api/stablecoin-summary/1", "GET"],
    ["/api/api-keys/1/update", "POST"],
    ["/api/api-keys/1/deactivate", "POST"],
    ["/api/api-keys/1/rotate", "POST"],
    ["/api/api-key-requests-admin/akr_abc12345/reject", "POST"],
    ["/api/audit-depeg-history?dry-run=true", "GET"],
    ["/api/backfill-dews", "GET"],
    ["/api/backfill-dews?repair=refresh-current&dry-run=true", "GET"],
    ["/api/backfill-dews", "POST"],
  ])("allows %s via %s", (path, method) => {
    expect(validateEndpointMethod(new URL(path, "https://api.pharos.watch"), method)).toBeNull();
  });

  it.each([
    ["/api/og/stablecoin/usdt-tether", "HEAD", ["GET"]],
    ["/api/stablecoins", "POST", ["GET"]],
    ["/api/stablecoins", "HEAD", ["GET"]],
    ["/api/trigger-digest", "GET", ["POST"]],
    ["/api/backfill-dews?repair=refresh-current", "GET", ["POST"]],
    ["/api/audit-depeg-history", "GET", ["POST"]],
    ["/api/feedback", "GET", ["POST"]],
    ["/api/api-key-requests", "GET", ["POST"]],
    ["/api/telegram-mini-app/session", "GET", ["POST"]],
    ["/api/api-key-requests-admin", "POST", ["GET"]],
    ["/api/api-keys/1/rotate", "GET", ["POST"]],
    ["/api/unknown", "POST", ["GET"]],
    ["/api/stablecoins", "DELETE", ["GET", "POST"]],
  ] as const)("rejects %s via %s with usable allowed methods", (path, method, allowedMethods) => {
    expect(validateEndpointMethod(new URL(path, "https://api.pharos.watch"), method))
      .toMatchObject({ allowedMethods });
  });

  it("keeps public-auth and site-data policies aligned", () => {
    expect(getPublicApiAccess("/api/stablecoins")).toBe("protected");
    expect(getPublicApiAccess("/api/health")).toBe("exempt");
    expect(getPublicApiAccess("/api/safety-grades")).toBe("exempt");
    expect(getPublicApiAccess("/api/report-cards/v9")).toBe("protected");
    expect(getPublicApiAccess("/api/api-key-requests")).toBe("exempt");
    expect(getPublicApiAccess("/api/api-key-requests/verify")).toBe("exempt");
    expect(getPublicApiAccess("/api/donor-key-claims")).toBe("exempt");
    expect(getPublicApiAccess("/api/telegram-mini-app/session")).toBe("exempt");
    expect(getPublicApiAccess("/api/telegram-mini-app/mutate")).toBe("exempt");
    expect(getPublicApiAccess("/api/public-status-history")).toBe("protected");
    expect(getPublicApiAccess("/api/events")).toBe("protected");
    expect(getPublicApiAccess("/api/telegram-pulse")).toBe("protected");
    expect(getPublicApiAccess("/api/report-cards/v9-preview")).toBeNull();
    expect(getPublicApiAccess("/api/report-cards/v9-preview-412d818c031b7bc5")).toBeNull();
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

  it("provides independently specified status-action safety policies in UI order", () => {
    expect(getStatusPageActions().map(({ path, method, destructive, acceptsStablecoinFilter, group }) =>
      [path, method, destructive, acceptsStablecoinFilter, group],
    )).toEqual([
      ["/api/trigger-digest", "POST", false, false, "communications"],
      ["/api/reset-blacklist-sync", "POST", true, false, "recovery"],
      ["/api/debug-sync-state", "GET", false, false, "audit"],
      ["/api/remediate-blacklist-amount-gaps", "POST", false, true, "recovery"],
      ["/api/backfill-blacklist-current-balances", "POST", false, true, "recovery"],
      ["/api/backfill-depegs", "POST", false, true, "recovery"],
      ["/api/backfill-supply-history", "POST", false, true, "recovery"],
      ["/api/backfill-cg-prices", "POST", false, true, "recovery"],
      ["/api/backfill-yield-history", "POST", false, true, "recovery"],
      ["/api/backfill-stability-index", "POST", false, false, "recovery"],
      ["/api/backfill-mint-burn-prices", "POST", false, true, "audit"],
      ["/api/backfill-mint-burn", "POST", false, false, "recovery"],
      ["/api/backfill-tape", "POST", false, false, "recovery"],
      ["/api/reclassify-atomic-roundtrips", "POST", false, true, "audit"],
      ["/api/audit-depeg-history?dry-run=true", "GET", false, true, "audit"],
      ["/api/backfill-dews", "GET", false, false, "audit"],
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
      "docs/blacklist-tracker.md",
      "docs/data-flow-map.md",
      "docs/depeg-detection.md",
      "docs/dews.md",
      "docs/mint-burn-flows.md",
      "docs/pricing-pipeline.md",
      "docs/stability-index.md",
      "docs/supply-snapshot.md",
      "docs/yield-intelligence.md",
    ]);
    const referencedRunbooks = getStatusPageActions().flatMap((action) =>
      action.runbookPath ? [action.runbookPath] : [],
    );

    expect(referencedRunbooks.length).toBeGreaterThan(0);
    for (const runbookPath of referencedRunbooks) {
      expect(allowedRunbookPaths.has(runbookPath)).toBe(true);
      expect(existsSync(resolve(process.cwd(), runbookPath))).toBe(true);
    }
  });

  it("matches status-action dry-run metadata to independent query and method contracts", () => {
    expect(getStatusPageActions().flatMap((action) => action.dryRun.supported ? [[
      action.path, action.dryRun.queryParam, action.dryRun.liveSupported,
      action.dryRun.dryRunMethod ?? action.method, action.dryRun.liveMethod ?? action.method,
    ]] : [])).toEqual([
      ["/api/remediate-blacklist-amount-gaps", "dryRun", true, "POST", "POST"],
      ["/api/backfill-blacklist-current-balances", "dryRun", true, "POST", "POST"],
      ["/api/backfill-depegs", "dry-run", true, "POST", "POST"],
      ["/api/backfill-stability-index", "dry-run", true, "POST", "POST"],
      ["/api/backfill-mint-burn-prices", "dry-run", false, "POST", "POST"],
      ["/api/backfill-tape", "dryRun", true, "POST", "POST"],
      ["/api/audit-depeg-history?dry-run=true", "dry-run", true, "GET", "POST"],
    ]);
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
