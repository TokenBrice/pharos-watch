// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { YieldAccessStructure } from "@/components/yield-access-structure";

afterEach(cleanup);

describe("YieldAccessStructure", () => {
  it.each([
    [undefined, "Unknown"],
    [null, "Unknown"],
    [0, "0 min"],
    [1, "<1 min"],
    [29, "<1 min"],
    [59, "<1 min"],
    [60, "1 min"],
    [3_599, "60 min"],
    [3_600, "1 hr"],
    [5_400, "1.5 hr"],
    [86_400, "1 days"],
    [129_600, "1.5 days"],
  ] as const)("displays withdrawal delay %s as %s", (withdrawalDelaySeconds, expected) => {
    render(<YieldAccessStructure sourceRisk={{ withdrawalDelaySeconds }} />);
    expect(screen.getByText("Withdrawal delay").nextElementSibling?.textContent).toBe(expected);
  });
});
