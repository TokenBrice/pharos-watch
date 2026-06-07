// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("next/image", () => ({
  default: ({ alt }: { alt: string }) => <img alt={alt} />,
}));

const { UpcomingClient } = await import("../upcoming-client");

describe("UpcomingClient", () => {
  afterEach(() => cleanup());

  it("renders AI-summary term markers as plain labels inside linked teaser cards", () => {
    const { container } = render(<UpcomingClient />);
    const text = container.textContent ?? "";

    expect(text).not.toContain("{{term:");
    expect(text).not.toContain("{{/term}}");
    expect(text).toContain("overcollateralized");
    expect(text).toContain("MMFs");
  });
});
