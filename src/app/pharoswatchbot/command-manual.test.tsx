// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TELEGRAM_BOT_COMMANDS,
  TELEGRAM_BOT_GROUP_COMMANDS,
  TELEGRAM_COMMAND_REFERENCE,
} from "@shared/lib/telegram-bot-registration";
import { WATCHLIST_STORAGE_KEY } from "@/lib/watchlist-storage";
import { CommandManual } from "./command-manual";
import { SubscribeCommandBuilder } from "./subscribe-builder";

const copyTextMock = vi.hoisted(() => vi.fn(async () => ({ ok: true as const })));
vi.mock("@/lib/clipboard", () => ({
  copyText: copyTextMock,
}));

afterEach(() => {
  cleanup();
  copyTextMock.mockClear();
  window.localStorage.removeItem(WATCHLIST_STORAGE_KEY);
  window.localStorage.removeItem("pharos:portfolio");
  window.history.replaceState(null, "", "/pharoswatchbot/");
});

describe("CommandManual", () => {
  it("renders exactly the registered command syntax, nothing retired", () => {
    render(<CommandManual />);
    const reference = screen.getByLabelText("PharosWatchBot command reference");
    const rendered = within(reference).getAllByRole("term").map((term) => term.querySelector("code")?.textContent);
    const registered = Object.values(TELEGRAM_COMMAND_REFERENCE).flatMap((entry) =>
      entry.variants.map((variant) => variant.syntax));

    expect(rendered).toEqual(registered);
    for (const retired of ["/set", "/mute", "/timezone", "/top", "/brief", "/presets", "/health", "/why", "/coverage"]) {
      expect(rendered.some((syntax) => syntax?.split(" ")[0] === retired)).toBe(false);
    }
  });

  it("toggles Private and Group syntax and copies commands in one click", async () => {
    render(<CommandManual />);
    fireEvent.click(screen.getByRole("button", { name: "Copy /subscribe USDC USDT" }));
    await waitFor(() => expect(copyTextMock).toHaveBeenCalledWith("/subscribe USDC USDT"));

    fireEvent.click(screen.getByRole("button", { name: "Group" }));
    const reference = screen.getByLabelText("PharosWatchBot command reference");
    const rendered = within(reference).getAllByRole("term").map((term) => term.querySelector("code")?.textContent);
    expect(rendered).toContain("/subscribe@PharosWatchBot <targets>");
    expect(rendered.some((syntax) => syntax?.startsWith("/start"))).toBe(false);
    expect(rendered.some((syntax) => syntax?.startsWith("/forget"))).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Copy /subscribe@PharosWatchBot USDC USDT" }));
    await waitFor(() => expect(copyTextMock).toHaveBeenCalledWith("/subscribe@PharosWatchBot USDC USDT"));
  });

  it("keeps the menus at 7 private and 5 group commands", () => {
    expect(TELEGRAM_BOT_COMMANDS.map((entry) => entry.command)).toEqual([
      "start", "status", "list", "subscribe", "settings", "pause", "help",
    ]);
    expect(TELEGRAM_BOT_GROUP_COMMANDS.map((entry) => entry.command)).toEqual([
      "status", "list", "subscribe", "settings", "help",
    ]);
  });
});

describe("SubscribeCommandBuilder", () => {
  it("reads ?coin= from the URL, imports Watchlist and Portfolio, and switches Private/Group syntax", async () => {
    window.history.replaceState(null, "", "/pharoswatchbot/?coin=usdc-circle");
    window.localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(["usdt-tether", "dai-makerdao"]));
    window.localStorage.setItem("pharos:portfolio", JSON.stringify([{ coinId: "usde-ethena", amount: 500 }]));

    render(<SubscribeCommandBuilder />);
    const cmd = () => screen.getByTestId("telegram-subscribe-command").textContent;
    expect(cmd()).toBe("/subscribe dews,depeg,safety USDC");

    fireEvent.click(screen.getByRole("button", { name: "Import my Watchlist (2)" }));
    expect(cmd()).toBe("/subscribe dews,depeg,safety USDT DAI");

    fireEvent.click(screen.getByRole("button", { name: "Import my Portfolio (1)" }));
    expect(cmd()).toBe("/subscribe dews,depeg,safety USDe");

    fireEvent.click(screen.getByRole("button", { name: "Group" }));
    expect(cmd()).toBe("/subscribe@PharosWatchBot dews,depeg,safety USDe");

    fireEvent.click(screen.getByRole("button", { name: "Copy subscribe command" }));
    await waitFor(() => expect(copyTextMock).toHaveBeenCalledWith("/subscribe@PharosWatchBot dews,depeg,safety USDe"));
  });
});
