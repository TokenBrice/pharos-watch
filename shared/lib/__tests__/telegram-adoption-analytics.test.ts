import { describe, expect, it } from "vitest";
import {
  TELEGRAM_ADOPTION_CATALOG,
  parseTelegramAdoptionToken,
  telegramAdoptionEntryForPlacement,
  telegramAdoptionSource,
} from "../telegram-adoption-analytics";

describe("Telegram adoption catalog", () => {
  it("keeps every emitted token unique and inside Telegram start constraints", () => {
    const tokens = TELEGRAM_ADOPTION_CATALOG.map((entry) => entry.token);
    expect(new Set(tokens).size).toBe(tokens.length);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(token.length).toBeLessThanOrEqual(64);
      expect(parseTelegramAdoptionToken(token)).not.toBeNull();
    }
  });

  it("rejects arbitrary dimensions instead of normalizing them", () => {
    expect(parseTelegramAdoptionToken("pw1_landing_arbitrary")).toBeNull();
    expect(telegramAdoptionSource("pw1_landing_arbitrary")).toEqual({
      campaign: "organic",
      placement: "unknown",
    });
  });

  it("resolves placements from the same canonical catalog", () => {
    expect(telegramAdoptionEntryForPlacement("hero")).toMatchObject({
      token: "pw1_landing_hero",
      destination: "setup",
    });
  });
});
