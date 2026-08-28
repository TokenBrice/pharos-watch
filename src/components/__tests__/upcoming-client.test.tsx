// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

vi.mock("next/image", () => ({
  default: ({ alt }: { alt: string }) => <img alt={alt} />,
}));

const { UpcomingClient } = await import("../upcoming-client");
const { PRE_LAUNCH_STABLECOINS } = await import("@shared/lib/stablecoins/registry");
const { logosById } = await import("@/lib/logos");

const upcomingLogos = Object.fromEntries(
  PRE_LAUNCH_STABLECOINS.map((coin) => [coin.id, logosById[coin.id]]),
);

describe("UpcomingClient", () => {

  it("renders AI-summary term markers as plain labels inside linked teaser cards", () => {
    const preLaunchId = PRE_LAUNCH_STABLECOINS[0]?.id;
    expect(preLaunchId).toBeTruthy();

    const { container } = render(
      <UpcomingClient
        coins={PRE_LAUNCH_STABLECOINS}
        logos={upcomingLogos}
        teasers={{
          [preLaunchId as string]:
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
        logos={upcomingLogos}
        teasers={{}}
      />,
    );

    expect(screen.getByRole("button", { name: "Beta" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Name" }).getAttribute("aria-pressed")).toBe("true");
  });
});
