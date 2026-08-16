// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { mockFetch } from "../../worker/src/test-helpers/__shared/mock-fetch";

vi.mock("next/font/local", () => ({
  default: () => ({ className: "mock-local-font", variable: "--mock-local-font" }),
}));

import ErrorPage from "./error";

beforeEach(() => {
  // The root error boundary probes /api/health on mount. Stub fetch so the
  // tests don't surface a degraded callout (or an unhandled rejection from a
  // missing global fetch).
  mockFetch([{
    match: "/api/health",
    respond: () => new Error("offline"),
  }], { requireMatch: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  cleanup();
});

describe("root app error boundary", () => {
  it("hides raw error.message in production", () => {
    vi.stubEnv("NODE_ENV", "production");

    render(<ErrorPage error={new Error("select * from secrets where leaked = 1")} reset={() => {}} />);

    expect(
      screen.getByText("The data didn't reach this page. Try again, or check /status/ if it keeps happening."),
    ).toBeTruthy();
    expect(screen.queryByText("select * from secrets where leaked = 1")).toBeNull();
  });

  it("still shows the raw message in development", () => {
    vi.stubEnv("NODE_ENV", "development");

    render(<ErrorPage error={new Error("development-only detail")} reset={() => {}} />);

    expect(screen.getByText("development-only detail")).toBeTruthy();
  });

  it("calls reset when the retry button is clicked", () => {
    vi.stubEnv("NODE_ENV", "production");
    let called = 0;

    render(
      <ErrorPage
        error={new Error("boom")}
        reset={() => {
          called += 1;
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(called).toBe(1);
  });
});
