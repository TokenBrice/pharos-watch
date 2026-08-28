// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { QueryErrorNotice } from "@/components/query-error-notice";
import { ApiFetchError } from "@/lib/api";


describe("QueryErrorNotice", () => {
  it("returns null when error is falsy", () => {
    const { container } = render(<QueryErrorNotice error={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("returns null when error is undefined", () => {
    const { container } = render(<QueryErrorNotice error={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders generic error notice for a plain Error", () => {
    render(<QueryErrorNotice error={new Error("Something went wrong")} />);
    expect(screen.getByText("Failed to load this dataset")).toBeTruthy();
  });

  it("has role=status for accessibility", () => {
    render(<QueryErrorNotice error={new Error("Oops")} />);
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("has aria-live=polite for screen reader announcements", () => {
    render(<QueryErrorNotice error={new Error("Oops")} />);
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
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

  it("renders network notice for TypeError with network message", () => {
    render(
      <QueryErrorNotice error={new TypeError("Failed to fetch")} hasData={false} />,
    );
    expect(screen.getByText("Connection issue")).toBeTruthy();
  });

  it("renders unavailable notice for 503 ApiFetchError", () => {
    const err = new ApiFetchError("/api/data", 503, null);
    render(<QueryErrorNotice error={err} hasData={false} />);
    expect(screen.getByText("Waiting for first sync")).toBeTruthy();
  });

  it("renders retry button when onRetry is provided", () => {
    const onRetry = vi.fn();
    render(<QueryErrorNotice error={new Error("Oops")} onRetry={onRetry} />);
    expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();
  });

  it("calls onRetry when retry button clicked", () => {
    const onRetry = vi.fn();
    render(<QueryErrorNotice error={new Error("Oops")} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("does not render retry button when onRetry is not provided", () => {
    render(<QueryErrorNotice error={new Error("Oops")} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows error detail message for short non-network errors", () => {
    render(
      <QueryErrorNotice error={new Error("Custom descriptive error detail")} />,
    );
    expect(screen.getByText("Custom descriptive error detail")).toBeTruthy();
  });

  it("does not show detail for network-style error messages", () => {
    render(<QueryErrorNotice error={new Error("Failed to fetch")} />);
    // The raw message matches the network pattern so detail is suppressed
    expect(screen.queryByText("Failed to fetch")).toBeNull();
  });
});
