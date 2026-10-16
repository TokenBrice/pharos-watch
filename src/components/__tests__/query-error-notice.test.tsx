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


  it("renders stale notice when hasData=true", () => {
    render(
      <QueryErrorNotice
        error={new Error("Network request failed")}
        hasData
      />,
    );
    expect(screen.getByText("Refresh delayed")).toBeTruthy();
    expect(
      screen.getByText(/Showing the last successful snapshot/i),
    ).toBeTruthy();
  });


  it("renders unavailable notice for 503 ApiFetchError", () => {
    const err = new ApiFetchError("/api/data", 503, null);
    render(<QueryErrorNotice error={err} hasData={false} />);
    expect(screen.getByText("Waiting for first sync")).toBeTruthy();
  });

});
