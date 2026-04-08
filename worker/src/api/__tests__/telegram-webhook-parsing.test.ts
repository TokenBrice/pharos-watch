import { describe, expect, it, vi } from "vitest";
import { parsePendingDisambiguation } from "../telegram-webhook-parsing";
import type { PendingDisambiguationRow } from "../telegram-webhook-shared";

function makePendingRow(overrides: Partial<PendingDisambiguationRow> = {}): PendingDisambiguationRow {
  return {
    action_type: "subscribe",
    action_payload: JSON.stringify({ alertTypes: ["dews"] }),
    alert_types: JSON.stringify(["dews"]),
    resolved_ids: JSON.stringify(["usdc-circle"]),
    ambiguous_ticker: "USDF",
    candidates: JSON.stringify([
      { id: "usdf-falcon", symbol: "USDF", name: "Falcon USD" },
      { id: "usdf-tradfi", symbol: "USDF", name: "TradFi USD" },
    ]),
    remaining_tickers: JSON.stringify(["USDC"]),
    expires_at: 1_700_000_000,
    ...overrides,
  };
}

describe("parsePendingDisambiguation", () => {
  it("falls back to legacy alert types when action_payload is malformed", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const parsed = parsePendingDisambiguation(
      makePendingRow({
        action_payload: "{bad-json",
        alert_types: JSON.stringify(["safety"]),
      }),
    );

    expect(parsed).toMatchObject({
      actionType: "subscribe",
      ambiguousTicker: "USDF",
      remainingTickers: ["USDC"],
    });
    expect(parsed?.actionType === "subscribe" && [...parsed.alertTypes]).toEqual(["safety"]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("field=action_payload"));
  });

  it("preserves valid pending state when resolved_ids is malformed", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const parsed = parsePendingDisambiguation(
      makePendingRow({
        resolved_ids: "{bad-json",
      }),
    );

    expect(parsed).toMatchObject({
      actionType: "subscribe",
      ambiguousTicker: "USDF",
      remainingTickers: ["USDC"],
      resolvedCoins: [],
    });
    expect(parsed?.candidates).toHaveLength(2);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("field=resolved_ids"));
  });

  it("returns null when candidates are malformed because selection cannot continue", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const parsed = parsePendingDisambiguation(
      makePendingRow({
        candidates: "{bad-json",
      }),
    );

    expect(parsed).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("field=candidates"));
  });
});
