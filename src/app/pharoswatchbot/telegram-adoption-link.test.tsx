// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TelegramAdoptionLink } from "./telegram-adoption-link";

describe("TelegramAdoptionLink", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 }))));

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
