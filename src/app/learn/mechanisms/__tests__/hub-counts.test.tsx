import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MECHANISM_ARCHETYPE_VALUES } from "@shared/types/core";
import { getCoinsByLifecycleStatus } from "@shared/lib/stablecoins/by-mechanism";
import { isLaunchedAwaitingData } from "@/lib/pre-launch";
import MechanismExplainersHub from "../page";

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

vi.mock("next/font/local", () => ({
  default: () => ({ className: "font-test", variable: "--font-test" }),
}));

describe("mechanism explainers hub counts", () => {
  it("counts only genuinely upcoming rows as upcoming", () => {
    const upcoming = MECHANISM_ARCHETYPE_VALUES
      .flatMap((archetype) => getCoinsByLifecycleStatus(archetype, "pre-launch"))
      .filter((coin) => !isLaunchedAwaitingData(coin));
    const html = renderToStaticMarkup(<MechanismExplainersHub />);

    expect(html).toContain("Active coins by mechanism");
    expect(html).toContain(`+${upcoming.length}</span> upcoming`);
  });
});
