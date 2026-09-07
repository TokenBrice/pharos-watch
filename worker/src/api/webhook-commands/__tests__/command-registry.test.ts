import { describe, expect, it } from "vitest";
import {
  TELEGRAM_BOT_COMMANDS,
  TELEGRAM_BOT_GROUP_COMMANDS,
} from "@shared/lib/telegram-bot-registration";

describe("Telegram command registry", () => {

  it("keeps group command registration as a safe subset of private commands", () => {
    const privateCommands = new Set(TELEGRAM_BOT_COMMANDS.map((entry) => entry.command));
    const groupCommands = new Set(TELEGRAM_BOT_GROUP_COMMANDS.map((entry) => entry.command));

    expect([...groupCommands].filter((command) => !privateCommands.has(command))).toEqual([]);
    expect(groupCommands.has("start")).toBe(false);
    expect(groupCommands.has("forget")).toBe(false);
  });
});
