import { describe, expect, it } from "vitest";
import { splitMessage } from "../telegram-alerts-formatting";
import { formatTelegramRecap } from "../telegram-recap-formatting";
import type { TelegramRecapScopedFact } from "../telegram-recap-ranking";
import { mockFetch } from "../../test-helpers/__shared/mock-fetch";

function fact(overrides: Partial<TelegramRecapScopedFact> = {}): TelegramRecapScopedFact {
  return {
    eventId: "recap-1",
    type: "dews.escalated",
    family: "dews",
    severity: "warning",
    ts: Date.UTC(2026, 6, 11, 8),
    coinId: "usdc-circle",
    symbol: "USDC",
    name: "USD Coin",
    chain: null,
    payload: { prevBand: "WATCH", newBand: "ALERT" },
    membership: "direct",
    ...overrides,
  };
}

describe("Telegram recap formatter", () => {
  it("does not render an all-clear message", () => {
    expect(formatTelegramRecap({ facts: [], windowStartAtMs: 0, windowEndAtMs: 1, timezone: "UTC" })).toBeNull();
  });

  it("renders escaped deterministic HTML with Mini App controls and an optional digest link", () => {
    const fetchSpy = mockFetch([], { requireMatch: true });
    const rendered = formatTelegramRecap({
      facts: [fact({ payload: { prevBand: "WATCH<unsafe", newBand: "ALERT&urgent" } })],
      windowStartAtMs: Date.UTC(2026, 6, 10, 8),
      windowEndAtMs: Date.UTC(2026, 6, 11, 8),
      timezone: "UTC",
      digest: { url: "https://pharos.watch/digest/2026-07-11/" },
    });
    expect(rendered?.body).toContain("WATCH&lt;unsafe");
    expect(rendered?.body).toContain("ALERT&amp;urgent");
    expect(rendered?.body).toContain("Read the full market digest");
    expect(rendered?.replyMarkup.inline_keyboard[0]?.map((button) => button.text)).toEqual(["View watchlist", "Recap settings"]);
    expect(rendered?.replyMarkup.inline_keyboard[0]?.map((button) => button.web_app.url)).toEqual([
      "https://pharos.watch/pharoswatchbot/app/?startapp=recap_watchlist",
      "https://pharos.watch/pharoswatchbot/app/?startapp=recap_settings",
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps maximum fixtures in exactly one Telegram message", () => {
    const facts = Array.from({ length: 20 }, (_, index) => fact({
      eventId: `event-${index}`,
      type: index % 2 === 0 ? "yield.warning_emitted" : "score.downgraded",
      family: index % 2 === 0 ? "yield" : "score",
      coinId: `coin-${index}`,
      symbol: `C${index}`,
      payload: index % 2 === 0
        ? { signals: ["<&".repeat(100), "signal"] }
        : { prevGrade: "A+", newGrade: "B-" },
      ts: Date.UTC(2026, 6, 11, 8) - index,
    }));
    const rendered = formatTelegramRecap({
      facts,
      windowStartAtMs: Date.UTC(2026, 6, 10, 8),
      windowEndAtMs: Date.UTC(2026, 6, 11, 8),
      timezone: "UTC",
    });
    expect(rendered).not.toBeNull();
    expect(rendered!.body.length).toBeLessThanOrEqual(3500);
    expect(splitMessage(rendered!.body)).toHaveLength(1);
    expect(rendered!.omittedFactCount).toBeGreaterThan(0);
  });
});
