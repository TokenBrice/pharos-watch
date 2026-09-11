// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { summarizeDdrrRows } from "@shared/lib/depeg-resolver-review";
import { mockFetch, type MockFetchSpy } from "@shared/test-utils/mock-fetch";
import type { DdrResponse } from "@shared/types/depeg-resolver";
import type { DdrrResponse } from "@shared/types/depeg-resolver-review";
import { DDR_TEST_META } from "@/components/depeg-resolver-test-support";
import type * as FeatureFlags from "@/lib/feature-flags";
import { useDepegResolverSurfaces } from "@/hooks/use-depeg-resolver-surfaces";

/**
 * The gates run against the real query layer: a mocked `api-hooks` can only
 * echo the `enabled` flag back, which says nothing about whether a gated
 * surface actually stays off the network.
 */
const flags = vi.hoisted(() => ({
  resolverEnabled: vi.fn<() => boolean>(),
  reviewerEnabled: vi.fn<() => boolean>(),
}));

vi.mock("@/lib/feature-flags", async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlags>()),
  isDepegResolverEnabled: flags.resolverEnabled,
  isDepegResolverReviewerEnabled: flags.reviewerEnabled,
}));

const RESOLVER_PATH = API_PATHS.depegResolver();
const REVIEW_PATH = API_PATHS.depegResolverReview();

const METHODOLOGY = {
  version: "1.0",
  versionLabel: "v1.0",
  currentVersion: "1.0",
  currentVersionLabel: "v1.0",
  changelogPath: "/methodology/depeg-resolver-changelog/",
  asOf: 1,
  isCurrent: true,
};

const RESOLVER_PAYLOAD: DdrResponse = {
  _meta: DDR_TEST_META,
  rows: [],
  methodology: METHODOLOGY,
};

const REVIEW_PAYLOAD: DdrrResponse = {
  _meta: {
    computedAt: 1,
    expiresAt: 2,
    degraded: false,
    degradedReason: null,
    reviewerVersion: "ddr-reviewer-v3",
    publicWarning: "review warning",
    assessedEventCount: 0,
    reviewedEventCount: 0,
    pendingEventCount: 0,
    durationScoredCount: 0,
    verdictScoredCount: 0,
    assessmentRowLimit: 20_000,
    assessmentRowsTruncated: false,
    incidentRowLimit: 20_000,
    incidentRowsTruncated: false,
    publicRowLimit: 100,
    publicRowsTruncated: false,
    methodologyVersions: ["1.0"],
  },
  summary: summarizeDdrrRows([]),
  rows: [],
  methodology: METHODOLOGY,
};

/** Both endpoints are served, so an unwanted request shows up as a call, not an error. */
function renderSurfaces() {
  const fetchSpy = mockFetch(
    [
      {
        match: (request: Request) => new URL(request.url).pathname === RESOLVER_PATH,
        respond: () => ({ body: RESOLVER_PAYLOAD }),
      },
      {
        match: (request: Request) => new URL(request.url).pathname === REVIEW_PATH,
        respond: () => ({ body: REVIEW_PAYLOAD }),
      },
    ],
    { requireMatch: true },
  );
  const queryClient = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { fetchSpy, ...renderHook(() => useDepegResolverSurfaces(), { wrapper }) };
}

function requestsTo(fetchSpy: MockFetchSpy, path: string): number {
  return fetchSpy.getHistory().filter((entry) => new URL(entry.url).pathname === path).length;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("useDepegResolverSurfaces", () => {
  it("suppresses both requests while DDR is off, then issues one each after the flag flips", async () => {
    flags.resolverEnabled.mockReturnValue(false);
    // Reviewer flag is on: the DDR gate alone must still keep the ledger silent.
    flags.reviewerEnabled.mockReturnValue(true);

    const { fetchSpy, result, rerender } = renderSurfaces();

    expect(result.current.resolverEnabled).toBe(false);
    expect(result.current.resolverReviewerEnabled).toBe(false);
    expect(result.current.resolver.fetchStatus).toBe("idle");
    expect(result.current.resolverReview.fetchStatus).toBe("idle");
    // A gated query must not defer its request to a later tick either.
    const tick = Promise.withResolvers<void>();
    setTimeout(tick.resolve, 0);
    await tick.promise;
    expect(fetchSpy).toHaveBeenCalledTimes(0);
    expect(result.current.resolver.data).toBeUndefined();
    expect(result.current.resolverReview.data).toBeUndefined();

    flags.resolverEnabled.mockReturnValue(true);
    rerender();

    await waitFor(() => expect(result.current.resolver.data).toEqual(RESOLVER_PAYLOAD));
    await waitFor(() => expect(result.current.resolverReview.data).toEqual(REVIEW_PAYLOAD));
    expect(requestsTo(fetchSpy, RESOLVER_PATH)).toBe(1);
    expect(requestsTo(fetchSpy, REVIEW_PATH)).toBe(1);
  });

  it("serves DDR while the reviewer ledger stays unfetched behind its own flag", async () => {
    flags.resolverEnabled.mockReturnValue(true);
    flags.reviewerEnabled.mockReturnValue(false);

    const { fetchSpy, result } = renderSurfaces();

    await waitFor(() => expect(result.current.resolver.data).toEqual(RESOLVER_PAYLOAD));
    expect(result.current.resolverReviewerEnabled).toBe(false);
    expect(result.current.resolverReview.data).toBeUndefined();
    expect(result.current.resolverReview.fetchStatus).toBe("idle");
    expect(requestsTo(fetchSpy, RESOLVER_PATH)).toBe(1);
    expect(requestsTo(fetchSpy, REVIEW_PATH)).toBe(0);
  });
});
