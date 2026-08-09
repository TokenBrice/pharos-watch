// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

vi.mock("next/image", () => ({
  default: ({ alt }: { alt: string }) => <img alt={alt} />,
}));

const { UpcomingClient } = await import("../upcoming-client");
const { CLIENT_TRACKED_STABLECOINS } = await import("@shared/lib/stablecoins/client-registry");

describe("UpcomingClient", () => {
  afterEach(() => cleanup());

  it("renders AI-summary term markers as plain labels inside linked teaser cards", () => {
    const preLaunchId = CLIENT_TRACKED_STABLECOINS.find((coin) => coin.status === "pre-launch")?.id;
    expect(preLaunchId).toBeTruthy();

    const { container } = render(
      <UpcomingClient
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
});
