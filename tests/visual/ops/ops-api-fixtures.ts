import type { Page, Route } from "@playwright/test";
import type {
  ApiKeyAuditLogResponse,
  ApiKeySelfServeRequestAdminListResponse,
  ApiRequestAttributionResponse,
  StatusHistoryResponse,
} from "../../../shared/types";
import { makeLargeApiKeyInventory } from "../../../src/test-utils/api-key-fixtures";
import { makeSafetyScoreV9AdminAvailableResponse } from "../../../src/test-utils/safety-score-v9-admin-fixture";
import {
  STATUS_FIXTURE_NOW_MS,
  STATUS_FIXTURE_NOW_SECONDS,
  makeHealthyHealthResponse,
  makeLongCommsStatusResponse,
  makeMaintenanceDebtStatusResponse,
} from "../../../src/test-utils/status-fixtures";

export const OPS_FIXTURE_NOW_MS = STATUS_FIXTURE_NOW_MS;
export const OPS_FIXTURE_API_KEY_COUNT = 75;

const statusResponse = makeLongCommsStatusResponse(makeMaintenanceDebtStatusResponse());
const healthResponse = makeHealthyHealthResponse();
const apiKeyInventory = makeLargeApiKeyInventory(OPS_FIXTURE_API_KEY_COUNT);

const statusHistoryResponse: StatusHistoryResponse = {
  timestamp: statusResponse.timestamp,
  state: statusResponse.state,
  staleness: statusResponse.staleness,
  probe: statusResponse.probe,
  discrepancy: statusResponse.discrepancy,
  transitions: statusResponse.timeline,
  hasMore: false,
  reserveComposition: statusResponse.reserveComposition,
};

const requestSourceResponse: ApiRequestAttributionResponse = {
  generatedAt: STATUS_FIXTURE_NOW_SECONDS,
  window: {
    from: STATUS_FIXTURE_NOW_SECONDS - 86_400,
    to: STATUS_FIXTURE_NOW_SECONDS,
    durationSec: 86_400,
    bucketSizeSec: 3_600,
    routeLimit: 5,
    apiKeyLimit: 25,
    retentionDays: 35,
  },
  totals: {
    siteRequests: 700,
    externalRequests: 300,
    totalRequests: 1_000,
    siteSharePct: 70,
    externalSharePct: 30,
  },
  siteDelivery: {
    totalSiteRequests: 700,
    pagesCacheHits: 500,
    pagesUpstreamFetches: 150,
    pagesUpstreamTimeouts: 10,
    pagesUpstreamErrors: 5,
    publicApiSiteRequests: 60,
  },
  lanes: [],
  routes: [],
  buckets: [],
  keyedPublicApi: {
    keyedRequests: 180,
    unkeyedRequests: 120,
    totalRequests: 300,
    keyedSharePct: 60,
    unkeyedSharePct: 40,
    totalKeys: OPS_FIXTURE_API_KEY_COUNT,
    returnedKeys: 0,
    omittedKeys: OPS_FIXTURE_API_KEY_COUNT,
    omittedRequests: 180,
    truncated: true,
  },
  apiKeys: [],
  scope: {
    countsTotalSiteDemand: true,
    countsWorkerLoad: true,
    includesPagesProxyCacheHits: true,
  },
};

const apiKeyRequestsResponse: ApiKeySelfServeRequestAdminListResponse = {
  generatedAt: STATUS_FIXTURE_NOW_SECONDS,
  requests: [
    {
      requestId: "fixture-request-001",
      status: "pending_verification",
      email: "requester@example.invalid",
      requesterName: "Fixture Requester",
      organization: "Fixture Integration Lab",
      projectUrl: "https://integration.example.invalid",
      useCase: "Read-only fixture analytics for monitored stablecoin data.",
      intendedEndpoints: ["/api/stablecoins"],
      expectedCadence: "hourly",
      expectedVolume: "100 requests/day",
      acceptedTerms: true,
      emailVerified: false,
      linkedKeyId: null,
      linkedKeyPrefix: null,
      linkedKeyActive: null,
      linkedKeyExpiresAt: null,
      rateLimitPerMinute: 30,
      selfServeExpiresAt: null,
      riskScore: 0,
      riskReasons: [],
      claimStatus: "pending_verification",
      verificationSentAt: STATUS_FIXTURE_NOW_SECONDS - 60,
      verificationExpiresAt: STATUS_FIXTURE_NOW_SECONDS + 1_800,
      issuedAt: null,
      rejectedAt: null,
      createdAt: STATUS_FIXTURE_NOW_SECONDS - 120,
      updatedAt: STATUS_FIXTURE_NOW_SECONDS - 60,
    },
  ],
};

const apiKeyAuditLogResponse: ApiKeyAuditLogResponse = {
  entries: [
    {
      id: 101,
      apiKeyId: 7,
      action: "rotated",
      actor: "admin",
      detail: null,
      createdAt: 1_783_695_600,
    },
  ],
};

const releaseMetadata = {
  commit: "fixture-commit-0123456789abcdef",
  runId: "fixture-run-001",
  runAttempt: "1",
  createdAt: "2023-11-14T22:12:00.000Z",
};

const genericProbeResponse = {
  ok: true,
  status: "healthy",
  timestamp: STATUS_FIXTURE_NOW_SECONDS,
  fixture: true,
};

function payloadForApiPath(pathname: string): unknown {
  const upstreamPath = pathname.startsWith("/api/admin/")
    ? `/api/${pathname.slice("/api/admin/".length)}`
    : pathname.startsWith("/_site-data/")
      ? `/api/${pathname.slice("/_site-data/".length)}`
      : pathname;

  switch (upstreamPath) {
    case "/api/status":
      return statusResponse;
    case "/api/health":
      return healthResponse;
    case "/api/status-history":
      return statusHistoryResponse;
    case "/api/request-source-stats":
      return requestSourceResponse;
    case "/api/api-keys":
      return apiKeyInventory;
    case "/api/api-key-requests-admin":
      return apiKeyRequestsResponse;
    case "/api/api-keys/audit-log":
      return apiKeyAuditLogResponse;
    case "/api/admin-safety-score-v9":
      return makeSafetyScoreV9AdminAvailableResponse();
    default:
      return genericProbeResponse;
  }
}

async function fulfillJson(route: Route, payload: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(payload),
  });
}

async function fulfillApiFixture(route: Route): Promise<void> {
  const { pathname } = new URL(route.request().url());
  await fulfillJson(route, payloadForApiPath(pathname));
}

export async function installOpsApiFixtures(page: Page): Promise<void> {
  await page.route("**/api/**", fulfillApiFixture);
  await page.route("**/_site-data/**", fulfillApiFixture);
  await page.route("**/__pharos_release.json", (route) => fulfillJson(route, releaseMetadata));
}
