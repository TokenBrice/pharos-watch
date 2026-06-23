import { describe, expect, it } from "vitest";
import { TELEGRAM_BOT_COMMANDS, TELEGRAM_BOT_GROUP_COMMANDS } from "@shared/lib/telegram-bot-registration";
import { COMMAND_HANDLERS } from "../index";

describe("Telegram command registry", () => {
  it("keeps every registered Bot API command mapped to a webhook handler", () => {
    const missingHandlers = TELEGRAM_BOT_COMMANDS.map((entry) => `/${entry.command}`).filter(
      (command) => COMMAND_HANDLERS[command] == null,
    );

    expect(missingHandlers).toEqual([]);
  });

  it("keeps the deprecated market alias wired to brief", () => {
    expect(COMMAND_HANDLERS["/market"]).toBe(COMMAND_HANDLERS["/brief"]);
  });

  it("keeps group command registration as a safe subset of private commands", () => {
    const privateCommands = new Set(TELEGRAM_BOT_COMMANDS.map((entry) => entry.command));
    const groupCommands = new Set(TELEGRAM_BOT_GROUP_COMMANDS.map((entry) => entry.command));

    expect([...groupCommands].filter((command) => !privateCommands.has(command))).toEqual([]);
    expect(groupCommands.has("start")).toBe(false);
    expect(groupCommands.has("forget")).toBe(false);
  });
});
