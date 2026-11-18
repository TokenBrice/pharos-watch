import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MECHANISM_ARCHETYPE_VALUES } from "@shared/types/stablecoin-taxonomy";
import { countActiveByArchetype, getCoinsByLifecycleStatus } from "@shared/lib/stablecoins/by-mechanism";
import { ACTIVE_STABLECOINS, FROZEN_STABLECOINS, PRE_LAUNCH_STABLECOINS } from "@shared/lib/stablecoins/registry";
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
  it("counts only genuinely upcoming rows as upcoming and names the coins outside every design", () => {
    const byDesign = (status: "pre-launch" | "frozen") => MECHANISM_ARCHETYPE_VALUES
      .flatMap((archetype) => getCoinsByLifecycleStatus(archetype, status))
      .filter((coin) => !isLaunchedAwaitingData(coin)).length;
    const upcomingAll = PRE_LAUNCH_STABLECOINS.filter((coin) => !isLaunchedAwaitingData(coin)).length;
    const active = Object.values(countActiveByArchetype()).reduce((sum, count) => sum + count, 0);
    const [upcoming, frozen] = [byDesign("pre-launch"), byDesign("frozen")];
    const unresolved = ACTIVE_STABLECOINS.length - active + upcomingAll - upcoming + FROZEN_STABLECOINS.length - frozen;
    const html = renderToStaticMarkup(<MechanismExplainersHub />);

    expect(html).toContain("Active coins by mechanism");
    expect(html).toContain(`+${upcoming}</span>${upcoming === upcomingAll ? "" : ` of ${upcomingAll}`} upcoming`);
    expect(html.includes(`${active}</span> of ${ACTIVE_STABLECOINS.length} active`)).toBe(active !== ACTIVE_STABLECOINS.length);
    expect(html.includes(`${unresolved}</span> with an unresolved mechanism`)).toBe(unresolved > 0);
  });
});
