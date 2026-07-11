import { describe, expect, it } from "vitest";
import { TELEGRAM_ALERT_TYPES } from "../../types/status/telegram";
import {
  TELEGRAM_ALERT_FAMILIES,
  TELEGRAM_ALERT_FAMILY_COMMAND_TOKENS,
  TELEGRAM_ALERT_FAMILY_PHRASE_LIST,
} from "../telegram-alert-families";
import {
  TELEGRAM_BOT_DESCRIPTION,
  TELEGRAM_BOT_SHORT_DESCRIPTION,
} from "../telegram-bot-registration";

describe("telegram alert-family manifest", () => {
  it("mirrors the runtime alert-type membership and order", () => {
    expect(TELEGRAM_ALERT_FAMILIES.map((family) => family.key)).toEqual([...TELEGRAM_ALERT_TYPES]);
  });

  it("derives prose and command-token lists that name every family", () => {
    for (const family of TELEGRAM_ALERT_FAMILIES) {
      expect(TELEGRAM_ALERT_FAMILY_PHRASE_LIST).toContain(family.publicPhrase);
      expect(TELEGRAM_ALERT_FAMILY_COMMAND_TOKENS).toContain(family.key);
    }
    expect(TELEGRAM_ALERT_FAMILY_PHRASE_LIST).toMatch(/, and /);
  });
});

describe("bot profile registration copy", () => {
  it("derives the full description from the family manifest", () => {
    expect(TELEGRAM_BOT_DESCRIPTION).toContain(TELEGRAM_ALERT_FAMILY_PHRASE_LIST);
  });

  it("stays count-free instead of advertising a stale asset count", () => {
    expect(TELEGRAM_BOT_SHORT_DESCRIPTION).not.toMatch(/\d/);
    expect(TELEGRAM_BOT_DESCRIPTION).not.toMatch(/\d+\+/);
  });

  it("fits the Telegram Bot API length limits", () => {
    expect(TELEGRAM_BOT_SHORT_DESCRIPTION.length).toBeLessThanOrEqual(120);
    expect(TELEGRAM_BOT_DESCRIPTION.length).toBeLessThanOrEqual(512);
  });
});
