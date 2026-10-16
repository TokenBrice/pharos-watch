import { describe, expect, it } from "vitest";
import {
  parseTelegramAdoptionToken,
  telegramAdoptionSource,
} from "../telegram-adoption-analytics";

describe("Telegram adoption catalog", () => {
  it("rejects arbitrary dimensions instead of normalizing them", () => {
    expect(parseTelegramAdoptionToken("pw1_landing_arbitrary")).toBeNull();
    expect(telegramAdoptionSource("pw1_landing_arbitrary")).toEqual({
      campaign: "organic",
      placement: "unknown",
    });
  });
});
