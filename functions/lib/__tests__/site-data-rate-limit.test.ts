import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SITE_DATA_RATE_LIMIT_MAX_PER_WINDOW,
  SITE_DATA_RATE_LIMIT_WINDOW_MS,
  isSiteDataRateLimited,
  resetSiteDataRateLimitStateForTests,
} from "../site-data-rate-limit";

const env = { SITE_API_SHARED_SECRET: "shared-secret" };

function request(ip: string | null): Request {
  const headers = new Headers();
  if (ip !== null) headers.set("CF-Connecting-IP", ip);
  return new Request("https://pharos.watch/_site-data/stablecoins", { headers });
}

async function fillBudget(ip: string): Promise<void> {
  for (let i = 0; i < SITE_DATA_RATE_LIMIT_MAX_PER_WINDOW; i++) {
    expect(await isSiteDataRateLimited(request(ip), env)).toBe(false);
  }
}

describe("site-data per-source read ceiling", () => {
  beforeEach(() => {
    resetSiteDataRateLimitStateForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-20T12:00:00Z"));
  });

  afterEach(() => {
    resetSiteDataRateLimitStateForTests();
    vi.useRealTimers();
  });

  it("throttles a single client-IP source only after the full window budget", async () => {
    await fillBudget("203.0.113.77");

    expect(await isSiteDataRateLimited(request("203.0.113.77"), env)).toBe(true);

    vi.setSystemTime(Date.now() + SITE_DATA_RATE_LIMIT_WINDOW_MS - 1);
    expect(await isSiteDataRateLimited(request("203.0.113.77"), env)).toBe(true);

    vi.setSystemTime(Date.now() + 1);
    expect(await isSiteDataRateLimited(request("203.0.113.77"), env)).toBe(false);
  });

  it("keeps separate budgets for separate client IPs", async () => {
    await fillBudget("203.0.113.77");

    expect(await isSiteDataRateLimited(request("203.0.113.78"), env)).toBe(false);
  });

  it("does not throttle callers it cannot identify or hash", async () => {
    await fillBudget("203.0.113.77");

    expect(await isSiteDataRateLimited(request(null), env)).toBe(false);
    expect(await isSiteDataRateLimited(request("203.0.113.77"), {})).toBe(false);
  });
});
