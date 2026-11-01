// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { QueryErrorNotice } from "@/components/query-error-notice";
import { ApiFetchError } from "@/lib/api";


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


  it("renders unavailable notice only for the cache-not-populated 503", () => {
    const err = new ApiFetchError("/api/data", 503, '{"error":"Data not yet available"}');
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

});
