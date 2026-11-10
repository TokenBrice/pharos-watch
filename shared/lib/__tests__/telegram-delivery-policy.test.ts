import { describe, expect, it } from "vitest";
import { TELEGRAM_FANOUT_PAGE_CHATS, TELEGRAM_MESSAGE_CHUNK_LIMIT } from "../telegram-delivery-policy";

describe("telegram delivery policy", () => {
  // The broadcast coordinator divides the target chat count by
  // TELEGRAM_FANOUT_PAGE_CHATS × TELEGRAM_FANOUT_MAX_PAGES_PER_RUN.
  it("keeps a non-zero fan-out page size", () => {
    expect(TELEGRAM_FANOUT_PAGE_CHATS).toBeGreaterThan(0);
  });

  it("keeps the message chunk limit below Telegram's 4096-byte cap with headroom", () => {
    expect(TELEGRAM_MESSAGE_CHUNK_LIMIT).toBeLessThan(4096);
  });
});
