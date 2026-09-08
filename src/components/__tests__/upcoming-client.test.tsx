// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { makeStablecoinMeta } from "@shared/test-utils/stablecoin";

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

vi.mock("next/image", () => ({
  default: ({ alt }: { alt: string }) => <img alt={alt} />,
}));

const { UpcomingClient } = await import("../upcoming-client");
const PRE_LAUNCH_STABLECOINS = [
  makeStablecoinMeta({ id: "fixture-announced", name: "Announced Coin", status: "pre-launch", launchPhase: "announced" }),
  makeStablecoinMeta({ id: "fixture-beta", name: "Beta Coin", status: "pre-launch", launchPhase: "beta" }),
];

describe("UpcomingClient", () => {

  it("renders AI-summary term markers as plain labels inside linked teaser cards", () => {
    const preLaunchId = "fixture-announced";

    const { container } = render(
      <UpcomingClient
        coins={PRE_LAUNCH_STABLECOINS}
        logos={{}}
        teasers={{
          [preLaunchId]:
            "An {{term:overcollateralization}}overcollateralized{{/term}} note parked in {{term:money-market-fund}}MMFs{{/term}}.",
        }}
      />,
    );
    const text = container.textContent ?? "";

    expect(text).not.toContain("{{term:");
    expect(text).not.toContain("{{/term}}");
    expect(text).toContain("overcollateralized");
    expect(text).toContain("MMFs");
  });

  it("hydrates phase and sort filters from the URL", () => {
    window.history.replaceState(null, "", "/upcoming/?phase=beta&sort=alphabetical");

    render(
      <UpcomingClient
        coins={PRE_LAUNCH_STABLECOINS}
        logos={{}}
        teasers={{}}
      />,
    );

    expect(screen.getByRole("button", { name: "Beta" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Name" }).getAttribute("aria-pressed")).toBe("true");
  });
});
