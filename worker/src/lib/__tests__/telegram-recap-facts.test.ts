import { describe, expect, it } from "vitest";
import { parseTelegramRecapFact, parseTelegramRecapFacts, type TelegramRecapTapeRow } from "../telegram/recap-facts";

const baseRow: TelegramRecapTapeRow = {
  event_id: "event-1",
  type: "depeg.opened",
  severity: "warning",
  ts: Date.UTC(2026, 6, 11, 8),
  coin_id: "usdc-circle",
  payload_json: JSON.stringify({ direction: "below", absDeviationBps: 315, startedAt: 1_784_060_000 }),
};

describe("Telegram recap Tape parser", () => {
  it("admits reviewed canonical, active coin-scoped facts", () => {
    expect(parseTelegramRecapFact(baseRow)).toMatchObject({
      eventId: "event-1",
      family: "depeg",
      coinId: "usdc-circle",
      symbol: "USDC",
      severity: "warning",
    });
  });

  it("fails closed for unknown types, ids, inactive ids, and malformed payloads", () => {
    expect(parseTelegramRecapFact({ ...baseRow, type: "psi.changed" })).toBeNull();
    expect(parseTelegramRecapFact({ ...baseRow, coin_id: "not-a-canonical-id" })).toBeNull();
    expect(parseTelegramRecapFact({ ...baseRow, coin_id: null })).toBeNull();
    expect(parseTelegramRecapFact({ ...baseRow, payload_json: "{" })).toBeNull();
    expect(parseTelegramRecapFact({ ...baseRow, payload_json: JSON.stringify({ direction: "below" }) })).toBeNull();
  });

  it("uses guarded parsing across a shared ledger without throwing", () => {
    const facts = parseTelegramRecapFacts([baseRow, { ...baseRow, event_id: "bad", payload_json: "not JSON" }]);
    expect(facts).toHaveLength(1);
  });
});
