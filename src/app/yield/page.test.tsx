import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { YIELD_LANDING_RISK_BUDGET, YIELD_RISK_BUDGET_MIN_SAFETY, YIELD_RISK_BUDGET_SPECS } from "@/lib/yield-view-config";
import YieldPage from "./page";

vi.mock("next/dynamic", () => ({
  default: () =>
    function StubYieldClient() {
      return <div data-testid="yield-client">yield client</div>;
    },
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    prefetch: _prefetch,
    children,
    ...rest
  }: {
    href: string;
    prefetch?: boolean;
    children?: ReactNode;
    className?: string;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

describe("yield landing lead", () => {
  it("describes the Opportunistic band by its safety floor instead of a grade", () => {
    const html = renderToStaticMarkup(<YieldPage />);
    const landingSpec = YIELD_RISK_BUDGET_SPECS.find((spec) => spec.key === YIELD_LANDING_RISK_BUDGET)!;
    const landingFloor =
      YIELD_RISK_BUDGET_MIN_SAFETY[landingSpec.key as keyof typeof YIELD_RISK_BUDGET_MIN_SAFETY];

    expect(html).toContain(landingSpec.label);
    expect(html).toContain(`safety score ${landingFloor}+`);
    expect(html).not.toMatch(/C-\s*or above/u);
    expect(landingSpec.description).toContain(`safety ${landingFloor}+`);
    expect(landingSpec.description).not.toMatch(/C-\s*safety/u);
  });
});
