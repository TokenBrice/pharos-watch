// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLIENT_CORE_AGGREGATE_ACTIVE_IDS } from "@shared/lib/stablecoins/aggregate-client-registry";
import { readSiteSessionCookie, verifySiteSessionToken } from "@shared/lib/site-session-token";

vi.mock("server-only", () => ({}));

// A top-stablecoins mirror exported before K-031: observed rows, no `supplyProvenance` column.
vi.mock("@/lib/datasets/public-dataset-current", () => ({
  PUBLIC_DATASET_CURRENT_EXPORTS: {
    "top-stablecoins": {
      _meta: { asOfISO: "2026-10-27T08:01:00.000Z" },
      rows: [...CLIENT_CORE_AGGREGATE_ACTIVE_IDS].map((id) => ({ id, pegType: "peggedUSD", circulatingUsd: 100 })),
    },
  },
}));
vi.mock("@/hooks/api-hooks", () => ({
  useHomepageSnapshot: () => ({ data: undefined, dataUpdatedAt: 0, error: null, refetch: vi.fn() }),
}));
vi.mock("@/components/homepage/home-alt-hero-chart-gate", () => ({ HomeAltHeroChartGate: () => <div /> }));
vi.mock("@/components/homepage/home-market-state-line", () => ({ HomeMarketStateLine: () => null }));
vi.mock("@/hooks/use-hydrated", () => ({ useHydrated: () => true }));
vi.mock("@/lib/analytics", () => ({ trackFreshDataReady: vi.fn() }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("HomeAltHero static fallback from a pre-provenance dataset (K-031, ADR-42)", () => {
  it.each(["", "build-signing-key"])("authenticates all five build-time history reads when configured (%s)", async (key) => {
    vi.stubEnv("SITE_SESSION_SIGNING_KEY", key);
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    const { getHomepageHeroSnapshot } = await import("@/lib/homepage-static-snapshot");
    const snapshot = await getHomepageHeroSnapshot();
    expect(fetch).toHaveBeenCalledTimes(5);
    for (const [url, init] of fetch.mock.calls as [URL, RequestInit][]) {
      expect(url.origin).toBe("https://pharos.watch");
      expect(url.pathname).toMatch(/^\/_site-data\//);
      const headers = new Headers(init.headers);
      expect(headers.get("Origin")).toBe(url.origin);
      const token = readSiteSessionCookie(headers.get("Cookie"));
      if (!key) expect(token).toBeNull();
      else expect(await verifySiteSessionToken({ token, keys: [key], nowSec: Math.floor(Date.now() / 1000) }))
        .toMatchObject({ ok: true, payload: { kind: "automation" } });
    }
    expect(JSON.stringify(snapshot)).not.toContain(key || "__Secure-pharos-session");
  });

  it("treats unrecorded chain coverage as legacy and renders the plain headline", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline build")));
    const { getHomepageHeroSnapshot } = await import("@/lib/homepage-static-snapshot");
    const { HomeAltHero } = await import("@/components/homepage/home-alt-hero");
    const snapshot = await getHomepageHeroSnapshot();
    expect(snapshot).toMatchObject({
      supplyObservedCount: CLIENT_CORE_AGGREGATE_ACTIVE_IDS.size,
      supplyCoverageUnknownCount: CLIENT_CORE_AGGREGATE_ACTIVE_IDS.size,
      supplyPartialCount: 0,
    });

    const view = render(<HomeAltHero snapshot={snapshot} fallbackSelectedAtMs={Date.parse(snapshot.asOfISO!)} />);
    expect(screen.getByText("Core market cap")).toBeTruthy();
    expect(view.container.textContent).not.toMatch(/Partial|known subtotal|assets observed/);
    expect(snapshot.cohort.usdt).toBe(100);
    expect(snapshot.cohort.usdc).toBe(100);
  });
});
