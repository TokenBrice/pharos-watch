// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  TELEGRAM_BOT_COMMANDS,
  TELEGRAM_BOT_GROUP_COMMANDS,
  TELEGRAM_COMMAND_REFERENCE,
} from "@shared/lib/telegram-bot-registration";
import { CommandManual } from "./command-manual";

afterEach(cleanup);

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

  it("keeps the menus at 7 private and 5 group commands", () => {
    expect(TELEGRAM_BOT_COMMANDS.map((entry) => entry.command)).toEqual([
      "start", "status", "list", "subscribe", "settings", "pause", "help",
    ]);
    expect(TELEGRAM_BOT_GROUP_COMMANDS.map((entry) => entry.command)).toEqual([
      "status", "list", "subscribe", "settings", "help",
    ]);
  });
});
