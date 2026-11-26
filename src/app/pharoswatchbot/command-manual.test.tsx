// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
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

const roots: Root[] = [];

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  cleanup();
  document.body.innerHTML = "";
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
    const groupMenuTerms = within(screen.getByRole("region", { name: "In the menu" }))
      .getAllByRole("term")
      .map((term) => term.querySelector("code")?.textContent?.match(/^\/([a-z]+)/)?.[1]);
    expect(new Set(groupMenuTerms)).toEqual(new Set(TELEGRAM_BOT_GROUP_COMMANDS.map((entry) => entry.command)));
    expect(groupMenuTerms).toContain("pause");
    expect(rendered).toContain("/pause@PharosWatchBot [1h|4h|24h|off]");

    fireEvent.click(screen.getByRole("button", { name: "Copy /subscribe@PharosWatchBot USDC USDT" }));
    await waitFor(() => expect(copyTextMock).toHaveBeenCalledWith("/subscribe@PharosWatchBot USDC USDT"));
  });

  it("keeps the menus at 7 private and 6 group commands", () => {
    expect(TELEGRAM_BOT_COMMANDS.map((entry) => entry.command)).toEqual([
      "start", "status", "list", "subscribe", "settings", "pause", "help",
    ]);
    expect(TELEGRAM_BOT_GROUP_COMMANDS.map((entry) => entry.command)).toEqual([
      "status", "list", "subscribe", "settings", "pause", "help",
    ]);
  });
});

describe("SubscribeCommandBuilder", () => {
  it("hydrates without mismatch on ?coins=, ignores URL params as portfolio state, and tracks SPA navigation", async () => {
    window.history.replaceState(null, "", "/pharoswatchbot/?coins=usdc-circle");
    const container = document.createElement("div");
    container.innerHTML = renderToString(<SubscribeCommandBuilder />);
    document.body.append(container);
    expect(container.textContent).not.toContain("Import my Portfolio");

    const errors: unknown[] = [];
    await act(async () => {
      roots.push(hydrateRoot(container, <SubscribeCommandBuilder />, {
        onRecoverableError: (error) => errors.push(error),
      }));
    });
    expect(errors).toEqual([]);

    const view = within(container);
    await waitFor(() => {
      expect(view.getByTestId("telegram-subscribe-command").textContent).toBe("/subscribe dews,depeg,safety USDC");
    });
    // Wait past hydration frames to confirm ?coins= never produces a false Portfolio import button.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(view.queryByRole("button", { name: /Import my Portfolio/i })).toBeNull();

    // SPA navigation via history.pushState updates the builder command without a full reload.
    await act(async () => {
      window.history.pushState(null, "", "/pharoswatchbot/?coins=dai-makerdao");
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(view.getByTestId("telegram-subscribe-command").textContent).toBe("/subscribe dews,depeg,safety DAI");
    });
  });

  it("hydrates cleanly with saved localStorage portfolio and imports storage holdings rather than ?coins=", async () => {
    window.history.replaceState(null, "", "/pharoswatchbot/?coins=usdc-circle");
    window.localStorage.setItem("pharos:portfolio", JSON.stringify([{ coinId: "usde-ethena", amount: 500 }]));
    const container = document.createElement("div");
    container.innerHTML = renderToString(<SubscribeCommandBuilder />);
    document.body.append(container);
    expect(container.textContent).not.toContain("Import my Portfolio");

    const errors: unknown[] = [];
    await act(async () => {
      roots.push(hydrateRoot(container, <SubscribeCommandBuilder />, {
        onRecoverableError: (error) => errors.push(error),
      }));
    });
    expect(errors).toEqual([]);

    const view = within(container);
    const portfolioButton = await view.findByRole("button", { name: "Import my Portfolio (1)" });
    fireEvent.click(portfolioButton);
    expect(view.getByTestId("telegram-subscribe-command").textContent).toBe("/subscribe dews,depeg,safety USDe");
  });

  it("reads ?coin= from the URL, imports Watchlist and Portfolio, and switches Private/Group syntax", async () => {
    window.history.replaceState(null, "", "/pharoswatchbot/?coin=usdc-circle");
    window.localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(["usdt-tether", "dai-makerdao"]));
    window.localStorage.setItem("pharos:portfolio", JSON.stringify([{ coinId: "usde-ethena", amount: 500 }]));

    render(<SubscribeCommandBuilder />);
    const cmd = () => screen.getByTestId("telegram-subscribe-command").textContent;
    expect(cmd()).toBe("/subscribe dews,depeg,safety USDC");

    fireEvent.click(screen.getByRole("button", { name: "Import my Watchlist (2)" }));
    expect(cmd()).toBe("/subscribe dews,depeg,safety USDT DAI");

    fireEvent.click(await screen.findByRole("button", { name: "Import my Portfolio (1)" }));
    expect(cmd()).toBe("/subscribe dews,depeg,safety USDe");

    fireEvent.click(screen.getByRole("button", { name: "Group" }));
    expect(cmd()).toBe("/subscribe@PharosWatchBot dews,depeg,safety USDe");

    fireEvent.click(screen.getByRole("button", { name: "Copy subscribe command" }));
    await waitFor(() => expect(copyTextMock).toHaveBeenCalledWith("/subscribe@PharosWatchBot dews,depeg,safety USDe"));
  });

  it("disables Reserve/Freeze on preset targets, reconciles when the last coin is removed, and gates the Mini App link to Private mode", () => {
    render(<SubscribeCommandBuilder />);
    const cmd = () => screen.getByTestId("telegram-subscribe-command").textContent;
    const reserve = () => screen.getByRole("button", { name: "Reserve" }) as HTMLButtonElement;
    const freeze = () => screen.getByRole("button", { name: "Freeze" }) as HTMLButtonElement;

    expect(cmd()).toBe("/subscribe dews,depeg,safety usd-top25");
    expect(reserve().disabled).toBe(true);
    expect(freeze().disabled).toBe(true);
    expect(screen.getByText(/Pick specific coins above to add Reserve drift or Freeze alerts/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /USDC/ }));
    expect(reserve().disabled).toBe(false);
    fireEvent.click(reserve());
    fireEvent.click(freeze());
    expect(cmd()).toBe("/subscribe dews,depeg,safety,reserve,freeze USDC");
    expect(screen.getByRole("link", { name: /Open USDC in Mini App/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Group" }));
    expect(screen.queryByRole("link", { name: /Open USDC in Mini App/ })).toBeNull();
    expect(screen.getByText(/Paste in your group chat after adding @PharosWatchBot/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove USD Coin from command" }));
    expect(cmd()).toBe("/subscribe@PharosWatchBot dews,depeg,safety usd-top25");
    expect(reserve().disabled).toBe(true);
    expect(reserve().getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: /USDC/ }));
    expect(cmd()).toBe("/subscribe@PharosWatchBot dews,depeg,safety USDC");
  });
});
