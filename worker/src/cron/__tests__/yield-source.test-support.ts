import { vi } from "vitest";
import { mockFetch, type MockFetchSpy, type MockRoute } from "@shared/test-utils/mock-fetch";
import { mockFetchRetry } from "../../test-helpers/cron";

export function mockYieldSourceFetchRetryModule() {
  return mockFetchRetry();
}

export function mockYieldSourceRoutes(
  routes: MockRoute[] = [],
  options: Parameters<typeof mockFetch>[1] = {},
): MockFetchSpy {
  return mockFetch(routes, options);
}

export function cleanupYieldSourceTest(): void {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
}
