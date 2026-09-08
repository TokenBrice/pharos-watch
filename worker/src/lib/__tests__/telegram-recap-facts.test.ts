import { describe, expect, it, vi } from "vitest";
import { parseTelegramRecapFact, parseTelegramRecapFacts, type TelegramRecapTapeRow } from "../telegram/recap-facts";

vi.mock("@shared/lib/stablecoins/worker-runtime-registry", () => {
  const active = { id: "usdc-circle", symbol: "USDC", name: "USD Coin", status: "active" };
  const frozen = { id: "frozen-coin", symbol: "OLD", name: "Frozen Coin", status: "frozen" };
  return {
    WORKER_ACTIVE_META_BY_ID: new Map([[active.id, active]]),
    WORKER_TRACKED_META_BY_ID: new Map([active, frozen].map((coin) => [coin.id, coin])),
  };
});

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
    expect(parseTelegramRecapFact({ ...baseRow, coin_id: "frozen-coin" })).toBeNull();
    expect(parseTelegramRecapFact({ ...baseRow, coin_id: null })).toBeNull();
    expect(parseTelegramRecapFact({ ...baseRow, payload_json: "{" })).toBeNull();
    expect(parseTelegramRecapFact({ ...baseRow, payload_json: JSON.stringify({ direction: "below" }) })).toBeNull();
  });

  it("uses guarded parsing across a shared ledger without throwing", () => {
    const facts = parseTelegramRecapFacts([baseRow, { ...baseRow, event_id: "bad", payload_json: "not JSON" }]);
    expect(facts.map((fact) => fact.eventId)).toEqual(["event-1"]);
  });

  it("validates all remaining family payload forms independently", () => {
    const forms = [
      { type: "dews.escalated", family: "dews", valid: { prevBand: "CALM", newBand: "ALERT" }, invalid: { prevBand: "CALM" } },
      { type: "score.downgraded", family: "score", valid: { prevGrade: "A", newGrade: "B" }, invalid: { prevGrade: "A" } },
      { type: "freeze.blocked", family: "freeze", valid: { chainName: "Ethereum" }, invalid: {} },
      { type: "freeze.unblocked", family: "freeze", valid: { chainId: "ethereum" }, invalid: { chainId: " " } },
      { type: "mint_burn.large_burn", family: "mint_burn", valid: { amountUsd: 500 }, invalid: { amountUsd: "500" } },
      { type: "yield.warning_emitted", family: "yield", valid: { signals: ["low"] }, invalid: { signals: "low" } },
      { type: "yield.warning_emitted", family: "yield", valid: { newSignals: ["low"] }, invalid: {} },
      { type: "yield.pys_dropped", family: "yield", valid: { prevScore: 90, newScore: 70 }, invalid: { prevScore: 90 } },
    ];
    for (const { type, family, valid, invalid } of forms) {
      expect(parseTelegramRecapFact({ ...baseRow, type, payload_json: JSON.stringify(valid) })).toMatchObject({ type, family, payload: valid });
      expect(parseTelegramRecapFact({ ...baseRow, type, payload_json: JSON.stringify(invalid) })).toBeNull();
    }
    expect(parseTelegramRecapFact({ ...baseRow, type: "mint_burn.large_mint", payload_json: "{}" }))
      .toMatchObject({ family: "mint_burn", payload: {} });
  });

  it("normalizes severe severity and blank chains while rejecting unknown severity", () => {
    expect(parseTelegramRecapFact({ ...baseRow, severity: "severe", chain: "  " }))
      .toMatchObject({ severity: "critical", chain: null });
    expect(parseTelegramRecapFact({ ...baseRow, severity: "unknown" })).toBeNull();
  });

  it("rejects blank event identities and nonfinite timestamps", () => {
    expect(parseTelegramRecapFact({ ...baseRow, event_id: " " })).toBeNull();
    for (const ts of [NaN, Infinity, -Infinity]) {
      expect(parseTelegramRecapFact({ ...baseRow, ts })).toBeNull();
    }
  });
});
