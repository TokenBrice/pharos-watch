// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PharosWatchBotPage, { metadata } from "./page";
import { TELEGRAM_FAQ, TELEGRAM_PAGE_DESCRIPTION } from "./telegram-content";
import {
  PHAROSWATCHBOT_BOT_URL,
  RECOMMENDED_SETUP,
  RECOMMENDED_SETUP_COMMAND,
  RECOMMENDED_SETUP_DEEP_LINK,
  RECOMMENDED_SETUP_START_PAYLOAD,
} from "./telegram-route-constants";
import {
  TELEGRAM_MINI_APP_PAYLOAD_PATTERN,
  TELEGRAM_START_PAYLOAD_MAX_LENGTH,
} from "@shared/lib/telegram-mini-app-payloads";
import { TRACKED_STABLECOIN_COUNT } from "@/lib/stablecoin-static-data";

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

type JsonLdRecord = Record<string, unknown>;

function parseJsonLd(container: HTMLElement): JsonLdRecord[] {
  return [...container.querySelectorAll('script[type="application/ld+json"]')].flatMap((node) => {
    const parsed = JSON.parse(node.textContent ?? "null") as JsonLdRecord | JsonLdRecord[];
    return Array.isArray(parsed) ? parsed : [parsed];
  });
}

function findJsonLdNode(nodes: readonly JsonLdRecord[], type: string): JsonLdRecord {
  const match = nodes.find((node) => node["@type"] === type);
  expect(match).toBeDefined();
  return match as JsonLdRecord;
}

describe("PharosWatchBotPage", () => {
  it("keeps public metadata and copy current", () => {
    expect(metadata.description).toBe(TELEGRAM_PAGE_DESCRIPTION);
    expect(TELEGRAM_PAGE_DESCRIPTION).toContain("pre-launch assets going live");
    expect(TELEGRAM_PAGE_DESCRIPTION).not.toContain("pre-launch launches");
  });

  it("builds the recommended setup deep link from a registry-valid start payload", () => {
    const url = new URL(RECOMMENDED_SETUP_DEEP_LINK);
    const startPayload = url.searchParams.get("start");

    expect(`${url.origin}${url.pathname}`).toBe(PHAROSWATCHBOT_BOT_URL);
    expect(startPayload).toBe("sub_dews-depeg_usd-top25");
    expect(startPayload).toBe(RECOMMENDED_SETUP_START_PAYLOAD);
    expect(RECOMMENDED_SETUP_START_PAYLOAD).toBe(
      `sub_${RECOMMENDED_SETUP.alertTypes.join("-")}_${RECOMMENDED_SETUP.presetId}`,
    );
    expect(RECOMMENDED_SETUP_COMMAND).toBe("/subscribe dews,depeg usd-top25");
    expect(RECOMMENDED_SETUP_START_PAYLOAD.length).toBeLessThanOrEqual(TELEGRAM_START_PAYLOAD_MAX_LENGTH);
    expect(TELEGRAM_MINI_APP_PAYLOAD_PATTERN.test(RECOMMENDED_SETUP_START_PAYLOAD)).toBe(true);
  });

  it("renders primary CTAs, command reference, tracked count, and JSON-LD", () => {
    const { container } = render(<PharosWatchBotPage />);

    expect(screen.getAllByRole("heading", { name: "PharosWatchBot" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: /open bot/i }).length).toBeGreaterThan(0);
    expect(screen.getByText("Command Reference")).toBeTruthy();
    expect(screen.getAllByText("/brief").length).toBeGreaterThan(0);
    expect(screen.getByText(String(TRACKED_STABLECOIN_COUNT))).toBeTruthy();
    expect(screen.getByText("tracked stablecoins across active, frozen, and pre-launch coverage")).toBeTruthy();
    expect(screen.getByText(/Opens a Telegram confirmation that preloads DEWS and depeg alerts/i)).toBeTruthy();
    expect(screen.getByText("Control every alert from the Mini App.")).toBeTruthy();
    expect(screen.getByText("Global alerts")).toBeTruthy();
    expect(screen.getByText("Per-coin tuning")).toBeTruthy();
    expect(screen.getByText("Delivery health")).toBeTruthy();
    expect(screen.getByText("Coin search")).toBeTruthy();
    expect(screen.getByText("Bot sync")).toBeTruthy();
    expect(screen.getByText("Deep links")).toBeTruthy();
    expect(screen.getByText("Launch alerts")).toBeTruthy();
    expect(screen.getByAltText(/home screen with watcher state/i).getAttribute("src")).toBe(
      "/featured/telegram-mini-app/home.png",
    );
    expect(screen.getByAltText(/watchlist screen with per-coin alert toggles/i).getAttribute("src")).toBe(
      "/featured/telegram-mini-app/watchlist.png",
    );
    expect(screen.getByAltText(/presets screen with followed and available preset watchlists/i).getAttribute("src")).toBe(
      "/featured/telegram-mini-app/presets.png",
    );
    expect(screen.getByAltText(/settings screen with global alerts/i).getAttribute("src")).toBe(
      "/featured/telegram-mini-app/settings.png",
    );

    const jsonLd = parseJsonLd(container);
    const faq = findJsonLdNode(jsonLd, "FAQPage");
    const howTo = findJsonLdNode(jsonLd, "HowTo");
    const application = findJsonLdNode(jsonLd, "SoftwareApplication");

    expect(faq.mainEntity).toHaveLength(10);
    expect(faq.mainEntity).toHaveLength(TELEGRAM_FAQ.length);
    expect(application).toMatchObject({
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: "PharosWatchBot",
      applicationCategory: "FinanceApplication",
      operatingSystem: "Telegram",
      url: "https://pharos.watch/pharoswatchbot/",
      installUrl: PHAROSWATCHBOT_BOT_URL,
      description: "Opt-in Telegram bot for stablecoin peg, DEWS, safety, and launch alerts.",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      publisher: { "@id": "https://pharos.watch#organization" },
    });
    expect(application.featureList).toHaveLength(8);
    expect(application.featureList).toContain(
      "Telegram Mini App for visual watchlist, settings, and presets management",
    );
    expect(howTo).toMatchObject({
      "@context": "https://schema.org",
      "@type": "HowTo",
      name: "Set up Pharos stablecoin alerts on Telegram",
      totalTime: "PT2M",
      tool: [{ "@type": "HowToTool", name: "Telegram" }],
    });
    expect(howTo.step).toEqual([
      {
        "@type": "HowToStep",
        position: 1,
        name: "Open @PharosWatchBot",
        text: "Open @PharosWatchBot in Telegram and send /start.",
        url: "https://pharos.watch/pharoswatchbot/#getting-started",
      },
      {
        "@type": "HowToStep",
        position: 2,
        name: "Subscribe and tune",
        text: "Subscribe and tune with commands like /subscribe dews,depeg USDT,USDC, /presets, /set USDT dews WARNING, and /mute 22-07.",
        url: "https://pharos.watch/pharoswatchbot/#getting-started",
      },
      {
        "@type": "HowToStep",
        position: 3,
        name: "Review active subscriptions",
        text: "Alerts arrive automatically when conditions change. Use /list to check active subscriptions and /presets to discover preset watchlists from inside Telegram.",
        url: "https://pharos.watch/pharoswatchbot/#getting-started",
      },
    ]);
  });
});
