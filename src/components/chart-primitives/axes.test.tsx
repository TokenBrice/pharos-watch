// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TimeXAxis } from "@/components/chart-primitives/axes";

const axisState = vi.hoisted(() => ({ tickFormatter: undefined as ((value: unknown) => string) | undefined }));

vi.mock("recharts", () => ({
  CartesianGrid: () => null,
  Tooltip: () => null,
  YAxis: () => null,
  XAxis: ({ tickFormatter }: { tickFormatter?: (value: unknown) => string }) => {
    axisState.tickFormatter = tickFormatter;
    return null;
  },
}));

describe("TimeXAxis", () => {
  it("labels month ticks with an apostrophe year so it never reads as a day", () => {
    render(<TimeXAxis dataKey="ts" />);

    expect(axisState.tickFormatter?.(Date.UTC(2026, 9, 1))).toBe("Oct '26");
    expect(axisState.tickFormatter?.(null)).toBe("");
  });
});
