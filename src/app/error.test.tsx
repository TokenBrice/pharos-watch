// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("next/font/local", () => ({
  default: () => ({ className: "mock-local-font", variable: "--mock-local-font" }),
}));

import ErrorPage from "./error";

const fetchSpy = vi.fn();

beforeEach(() => {
  fetchSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
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

  it("makes no requests and calls reset on retry", () => {
    const reset = vi.fn();

    render(<ErrorPage error={new Error("boom")} reset={reset} />);

    expect(screen.getByText("The beam paused. The data is being re-aligned.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/currently degraded/i)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("labels chunk-load failures as a reload", () => {
    const chunkError = new Error("Loading chunk 42 failed");
    chunkError.name = "ChunkLoadError";

    render(<ErrorPage error={chunkError} reset={() => {}} />);

    expect(screen.getByText("A newer version of the site is up.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload page" })).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
