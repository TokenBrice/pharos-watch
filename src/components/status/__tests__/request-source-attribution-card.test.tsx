// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { makeApiRequestAttributionResponse, makeAttributionMeasurement } from "@/test-utils/status-fixtures";
import { RequestSourceAttributionCard } from "../request-source-attribution-card";

const sampled = makeAttributionMeasurement({
  kind: "estimated", observedSampleCount: 1, probabilityStrata: [{ inverseRate: 64, observedSampleCount: 1 }],
  reason: "low-sample", standardError: null,
});

afterEach(cleanup);

describe("RequestSourceAttributionCard", () => {
  it("marks estimates, sample sizes/rates, low precision and captured failures distinctly", () => {
    const stats = makeApiRequestAttributionResponse();
    stats.totals = {
      siteRequests: 64, externalRequests: 64, totalRequests: 128, siteSharePct: 50, externalSharePct: 50,
      measurement: { siteRequests: sampled, externalRequests: sampled, totalRequests: sampled, siteSharePct: sampled, externalSharePct: sampled },
    };
    stats.siteDelivery.pagesUpstreamTimeouts = 3;
    stats.siteDelivery.pagesUpstreamFetches = 64;
    stats.siteDelivery.measurement.pagesUpstreamFetches = sampled;
    stats.lanes = [{ lane: "site-api", ...stats.totals }];
    stats.routes = [{ routeKey: "a", routePath: "/api/a", ...stats.totals }];
    render(<RequestSourceAttributionCard stats={stats} />);
    expect(screen.getAllByText(/Est\. 64/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Observed samples: 1 \(1\/64: 1\)/)).toBeTruthy();
    expect(screen.getByText(/precision unavailable below 30 sampled events/)).toBeTruthy();
    expect(screen.getByText("Estimated worker load")).toBeTruthy();
    expect(screen.getByText("Captured Pages timeouts").parentElement?.textContent).toBe("Captured Pages timeouts3");
    expect(screen.getByText("Pages cache hits (historical)")).toBeTruthy();
  });

  it("does not call zero selected observations zero requests", () => {
    const stats = makeApiRequestAttributionResponse();
    const empty = makeAttributionMeasurement({ ...sampled, observedSampleCount: 0, coverage: "unknown", probabilityStrata: [{ inverseRate: 64, observedSampleCount: 0 }] });
    stats.totals.measurement = { siteRequests: empty, externalRequests: empty, totalRequests: empty, siteSharePct: empty, externalSharePct: empty };
    render(<RequestSourceAttributionCard stats={stats} />);
    expect(screen.getAllByText("No sampled observations").length).toBeGreaterThan(0);
    expect(screen.queryByText(/No requests/i)).toBeNull();
    expect(screen.getByText(/Missing observations do not prove no traffic/)).toBeTruthy();
  });

  it("renders only the latest eight buckets without recalculating full-window demand", () => {
    const stats = makeApiRequestAttributionResponse({ totals: { totalRequests: 98765 } });
    stats.buckets = Array.from({ length: 10 }, (_, index) => ({ bucketStart: 1_700_000_000 + index * 3600, ...stats.totals, totalRequests: 1 }));
    const { container } = render(<RequestSourceAttributionCard stats={stats} />);
    expect(screen.getByText("Latest 8 observed buckets")).toBeTruthy();
    expect(screen.getByText("98.8k")).toBeTruthy();
    expect(container.querySelectorAll(".h-2")).toHaveLength(8);
  });

  it("keeps failed reads visible instead of presenting retained traffic as current evidence", () => {
    render(<RequestSourceAttributionCard stats={makeApiRequestAttributionResponse()} error="Attribution query failed" />);
    expect(screen.getByText("Attribution query failed")).toBeTruthy();
    expect(screen.queryByText("Total demand")).toBeNull();
  });
});
