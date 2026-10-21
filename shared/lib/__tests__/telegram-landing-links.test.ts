import { describe, expect, it } from "vitest";
import {
  TELEGRAM_LANDING_LINK_CATALOG,
  parseTelegramLandingToken,
  telegramLandingEntryForPlacement,
} from "../telegram-landing-links";

describe("Telegram landing link catalog", () => {
  it("rejects arbitrary tokens instead of normalizing them", () => {
    expect(parseTelegramLandingToken("pw1_landing_arbitrary")).toBeNull();
  });

  it("round-trips every placement through its token", () => {
    for (const entry of TELEGRAM_LANDING_LINK_CATALOG) {
      expect(telegramLandingEntryForPlacement(entry.placement)).toBe(entry);
      expect(parseTelegramLandingToken(entry.token.toUpperCase())).toBe(entry);
    }
  });
});
