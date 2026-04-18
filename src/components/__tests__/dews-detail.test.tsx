// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { DEWSFiringList } from "@/components/dews-detail";

afterEach(cleanup);

describe("DEWSFiringList", () => {
  it("lists firing signals with their numeric value", () => {
    render(
      <DEWSFiringList
        signals={{
          supply: { value: 55, available: true },
          pool: { value: 0, available: true },
          liq: { value: 0, available: false },
          price: { value: 25, available: true },
          diverg: { value: 80, available: true },
          black: { value: 0, available: false },
          flow: { value: 0, available: false },
          yield: { value: 0, available: false },
        }}
      />,
    );
    // The firing list sorts by value descending and excludes zero/unavailable.
    const items = screen.getAllByTestId("dews-firing-signal");
    expect(items.length).toBe(3);
    expect(items[0].textContent).toMatch(/diverg/i);
    expect(items[0].textContent).toMatch(/80/);
  });

  it("renders empty-state fallback when no signals are firing", () => {
    render(
      <DEWSFiringList
        signals={{
          supply: { value: 0, available: true },
          pool: { value: 0, available: false },
        }}
      />,
    );
    expect(screen.queryAllByTestId("dews-firing-signal").length).toBe(0);
    expect(screen.getByText("No stress signals firing")).toBeTruthy();
  });
});
