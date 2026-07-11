import { describe, expect, it } from "vitest";
import {
  TELEGRAM_RECAP_DUE_PAGE_SIZE,
  TELEGRAM_RECAP_MAX_COINS,
  TELEGRAM_RECAP_MAX_FACT_LINES,
  TELEGRAM_RECAP_MAX_PAGES_PER_RUN,
  TELEGRAM_RECAP_PENDING_PRIORITY,
  TELEGRAM_RECAP_TTL_SEC,
  isTelegramRecapFactType,
} from "../telegram-recap-policy";

describe("Telegram recap policy", () => {
  it("owns the bounded low-priority daily recap contract", () => {
    expect(TELEGRAM_RECAP_PENDING_PRIORITY).toBe(100);
    expect(TELEGRAM_RECAP_TTL_SEC).toBe(6 * 60 * 60);
    expect(TELEGRAM_RECAP_DUE_PAGE_SIZE * TELEGRAM_RECAP_MAX_PAGES_PER_RUN).toBe(900);
    expect(TELEGRAM_RECAP_MAX_COINS).toBe(8);
    expect(TELEGRAM_RECAP_MAX_FACT_LINES).toBe(12);
  });

  it("admits only the reviewed tape types", () => {
    expect(isTelegramRecapFactType("depeg.opened")).toBe(true);
    expect(isTelegramRecapFactType("yield.pys_dropped")).toBe(true);
    expect(isTelegramRecapFactType("psi.changed")).toBe(false);
  });
});
