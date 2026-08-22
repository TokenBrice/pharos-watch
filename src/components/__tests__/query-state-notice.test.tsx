// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { QueryStateNotice } from "@/components/query-state-notice";

afterEach(cleanup);

describe("QueryStateNotice", () => {
  it("uses the classified unavailable tone while preserving its message API", () => {
    const { container } = render(<QueryStateNotice state="unavailable" label="Liquidity data" />);

    expect(screen.getByText("Liquidity data is temporarily unavailable. No status claim is being made.")).toBeTruthy();
    const className = container.firstElementChild?.getAttribute("class") ?? "";
    expect(className).toContain("bg-muted/40");
    expect(className).not.toContain("bg-amber-500");
  });

  it("keeps compact sizing for stale data", () => {
    const { container } = render(<QueryStateNotice state="stale-with-data" label="Yield data" compact />);

    const className = container.firstElementChild?.getAttribute("class") ?? "";
    expect(className).toContain("px-2.5");
    expect(className).toContain("text-xs");
  });
});
