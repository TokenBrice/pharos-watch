// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import ErrorPage from "./error";

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

afterEach(() => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  cleanup();
});

describe("root app error boundary", () => {
  it("hides raw error.message in production", () => {
    process.env.NODE_ENV = "production";

    render(
      <ErrorPage
        error={new Error("select * from secrets where leaked = 1")}
        reset={() => {}}
      />,
    );

    expect(screen.getByText("Something went wrong while loading this page.")).toBeTruthy();
    expect(screen.queryByText("select * from secrets where leaked = 1")).toBeNull();
  });

  it("still shows the raw message in development", () => {
    process.env.NODE_ENV = "development";

    render(
      <ErrorPage
        error={new Error("development-only detail")}
        reset={() => {}}
      />,
    );

    expect(screen.getByText("development-only detail")).toBeTruthy();
  });

  it("calls reset when the retry button is clicked", () => {
    process.env.NODE_ENV = "production";
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
