// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { QueryErrorNotice } from "@/components/query-error-notice";
import { QueryFreshnessNotices } from "@/components/query-freshness-notices";
import { QueryStateNotice } from "@/components/query-state-notice";
import { ApiFetchError } from "@/lib/api";

vi.mock("@/hooks/use-freshness-boundary", () => ({ useFreshnessBoundary: () => Date.now() }));


describe("QueryErrorNotice", () => {
  it("returns null when error is falsy", () => {
    const { container } = render(<QueryErrorNotice error={null} />);
    expect(container.firstChild).toBeNull();
  });


  it("renders generic error notice for a plain Error", () => {
    render(<QueryErrorNotice error={new Error("Something went wrong")} />);
    expect(screen.getByText("Failed to load this dataset")).toBeTruthy();
  });


  it("stays silent over retained data (ADR-42 operator signal)", () => {
    const { container } = render(
      <QueryErrorNotice
        error={new Error("Network request failed")}
        hasData
      />,
    );
    expect(container.textContent).toBe("");
  });


  it.each([
    "Data not yet available",
    "Stablecoins data not yet available",
    "Redemption backstop snapshot unavailable",
  ])("renders the unavailable notice for the dataset-state 503 body %s", (error) => {
    const err = new ApiFetchError("/api/data", 503, JSON.stringify({ error }));
    render(<QueryErrorNotice error={err} hasData={false} />);
    expect(screen.getByText("Waiting for first sync")).toBeTruthy();
  });

  it.each([
    ["maintenance", '{"error":"maintenance","message":"Pharos is undergoing a brief maintenance. Please retry in a few minutes."}'],
    ["malformed cache", '{"error":"Cached stablecoins payload is malformed"}'],
    ["transport shed", '{"error":"Public API temporarily unavailable"}'],
    ["bodyless 503", null],
  ])("does not claim an unpopulated dataset for a %s 503", (_case, bodyText) => {
    render(<QueryErrorNotice error={new ApiFetchError("/api/data", 503, bodyText)} hasData={false} />);
    expect(screen.getByText("Failed to load this dataset")).toBeTruthy();
    expect(screen.queryByText("Waiting for first sync")).toBeNull();
    expect(screen.queryByText(/has not populated yet/)).toBeNull();
  });

  it("renders flat without shadow-sm and links to /status/ alongside Retry", () => {
    const onRetry = vi.fn();
    render(<QueryErrorNotice error={new Error("Request failed")} onRetry={onRetry} />);
    const notice = screen.getByRole("status");
    expect(notice.className).not.toContain("shadow-sm");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /status page/i }).getAttribute("href")).toMatch(/^\/status\/?$/);
  });

});

describe("QueryFreshnessNotices", () => {
  it("suppresses duplicate StaleDataBanner when a blocking QueryErrorNotice already covers failed queries", () => {
    const error = new Error("API unavailable");
    render(
      <QueryFreshnessNotices
        error={error}
        hasData={false}
        onRetry={vi.fn()}
        queries={[
          { preset: "reportCards", dataUpdatedAt: 0, error, hasData: false },
          { preset: "stablecoins", dataUpdatedAt: 0, error: new Error("secondary fail"), hasData: false },
        ]}
      />,
    );
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByText("Failed to load this dataset")).toBeTruthy();
    expect(screen.queryByText("Refresh failed")).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /status page/i }).getAttribute("href")).toMatch(/^\/status\/?$/);
  });

  it("delegates to StaleDataBanner when retained data exists", () => {
    const error = new Error("Refresh timeout");
    render(
      <QueryFreshnessNotices
        error={error}
        hasData
        onRetry={vi.fn()}
        queries={[
          { preset: "stablecoins", dataUpdatedAt: Date.now() - 5 * 3600_000, error, hasData: true },
        ]}
      />,
    );
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.queryByText("Failed to load this dataset")).toBeNull();
    expect(screen.getByText("Showing an older snapshot")).toBeTruthy();
  });
});

describe("QueryStateNotice", () => {
  it("renders with an explicit border class for unavailable states", () => {
    render(<QueryStateNotice state="unavailable" label="DEX liquidity data" />);
    const alert = screen.getByRole("alert");
    expect(alert.className.split(/\s+/)).toContain("border");
  });
});
