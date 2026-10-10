// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TelegramAdoptionLink } from "./telegram-adoption-link";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { RECOMMENDED_SETUP_DEEP_LINK } from "@/lib/telegram-route-constants";
import { telegramAdoptionSource } from "@shared/lib/telegram-adoption-analytics";

afterEach(cleanup);

describe("TelegramAdoptionLink", () => {
  beforeEach(() => {
    mockFetch([{
      match: "/pharoswatchbot-adoption",
      outcomes: [{ response: new Response(null, { status: 204 }) }],
    }], { requireMatch: true });
  });

  it("records one allowlisted aggregate click without delaying navigation", () => {
    render(<TelegramAdoptionLink href="#bot" placement="hero">Open bot</TelegramAdoptionLink>);
    fireEvent.click(screen.getByRole("link", { name: "Open bot" }));

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith("/pharoswatchbot-adoption", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ campaign: "landing", placement: "hero" }),
      keepalive: true,
    });
  });

  it("records the same setup campaign as the recommended start URL", () => {
    render(<TelegramAdoptionLink href={RECOMMENDED_SETUP_DEEP_LINK} placement="setup">Recommended</TelegramAdoptionLink>);
    const link = screen.getByRole("link", { name: "Recommended" });
    const token = new URL(link.getAttribute("href")!).searchParams.get("start");
    fireEvent.click(link);
    expect(fetch).toHaveBeenCalledWith("/pharoswatchbot-adoption", expect.objectContaining({
      body: JSON.stringify(telegramAdoptionSource(token)),
    }));
    expect(telegramAdoptionSource(token)).toEqual({ campaign: "landing", placement: "setup" });
  });

  it("does not record a click cancelled by another handler", () => {
    render(
      <TelegramAdoptionLink
        href="https://t.me/PharosWatchBot"
        placement="setup"
        onClick={(event) => event.preventDefault()}
      >
        Setup
      </TelegramAdoptionLink>,
    );
    fireEvent.click(screen.getByRole("link", { name: "Setup" }));
    expect(fetch).not.toHaveBeenCalled();
  });
});
