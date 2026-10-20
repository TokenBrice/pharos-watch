import { describe, expect, it } from "vitest";
import { TELEGRAM_MESSAGE_CHUNK_LIMIT } from "../constants";

describe("telegram-constants", () => {

  it("keeps chunk limit below Telegram's 4096 cap with headroom", () => {
    expect(TELEGRAM_MESSAGE_CHUNK_LIMIT).toBe(4000);
    expect(TELEGRAM_MESSAGE_CHUNK_LIMIT).toBeLessThan(4096);
  });

});
