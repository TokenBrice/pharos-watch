// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { YieldApiWarnings } from "@/components/yield/yield-data-health";

afterEach(cleanup);

it("keeps safety-hydration fallbacks operator-only and shows other API warnings", () => {
  const { container, rerender } = render(<YieldApiWarnings warnings={[
    { code: "yield-safety-hydration-stale", message: "Serving the last coherent published safety snapshot." },
    { code: "yield-safety-hydration-degraded", message: "Live safety hydration is degraded.", reasons: ["v9-held"] },
  ]} />);
  expect(container.textContent).toBe("");

  rerender(<YieldApiWarnings warnings={[{ code: "yield-new-advisory", message: "Rankings advisory." }]} />);
  expect(screen.getByLabelText("Yield API warnings").textContent).toContain("Rankings advisory.");
});
