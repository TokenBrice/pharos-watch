// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PharosWatchBotPage, { metadata } from "./page";
import { TELEGRAM_PAGE_DESCRIPTION } from "./telegram-content";

vi.mock("next/image", () => ({
  default: ({ alt, ...props }: { alt: string; src: string; width: number; height: number; className?: string }) => (
    <img alt={alt} {...props} />
  ),
}));

vi.mock("@/components/feature-page-shell", () => ({
  FeaturePageShell: ({
    title,
    children,
    headerActions,
  }: {
    title: string;
    children: ReactNode;
    headerActions?: ReactNode;
  }) => (
    <main>
      <h1>{title}</h1>
      {headerActions}
      {children}
    </main>
  ),
}));

vi.mock("@/components/copy-button", () => ({
  CopyButton: ({ text }: { text: string }) => <button type="button" aria-label={`Copy ${text}`} />,
}));

vi.mock("./telegram-pulse-strip", () => ({
  TelegramPulseBoard: () => <section aria-label="Live Telegram adoption metrics">pulse board</section>,
  TelegramPulseStrip: () => <div>pulse strip</div>,
}));

afterEach(() => {
  cleanup();
});

describe("PharosWatchBotPage", () => {
  it("keeps public metadata and copy current", () => {
    expect(metadata.description).toBe(TELEGRAM_PAGE_DESCRIPTION);
    expect(TELEGRAM_PAGE_DESCRIPTION).toContain("pre-launch assets going live");
    expect(TELEGRAM_PAGE_DESCRIPTION).not.toContain("pre-launch launches");
  });

  it("renders primary CTAs, command reference, 311 tracked count, and JSON-LD", () => {
    const { container } = render(<PharosWatchBotPage />);

    expect(screen.getAllByRole("heading", { name: "PharosWatchBot" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: /open bot/i }).length).toBeGreaterThan(0);
    expect(screen.getByText("Command Reference")).toBeTruthy();
    expect(screen.getAllByText("/brief").length).toBeGreaterThan(0);
    expect(screen.getByText("311")).toBeTruthy();
    expect(screen.getByText("tracked stablecoins across active, frozen, and pre-launch coverage")).toBeTruthy();

    const jsonLd = [...container.querySelectorAll('script[type="application/ld+json"]')]
      .map((node) => node.textContent ?? "")
      .join("\n");
    expect(jsonLd).toContain("FAQPage");
    expect(jsonLd).toContain("SoftwareApplication");
    expect(jsonLd).toContain("HowTo");
  });
});
