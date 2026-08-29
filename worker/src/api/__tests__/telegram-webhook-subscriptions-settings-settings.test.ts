import { beforeEach, describe, expect, it, vi } from "vitest";


import {
  handleTelegramWebhook,
  resolveTicker,
  makeWebhookRequest,
  sentMessageBody,
  resetTelegramWebhookTest,
  makeTelegramWebhookDb,
} from "./telegram-webhook.test-support";


// Webhook tests exercise command routing, so stub the canonical V9 loader with
// one matching card (the fail-closed paths have their own focused tests).
vi.mock("../../lib/safety-score-active-source", async () => {
  const { makeWorkerReportCardsV9Response, makeWorkerV9Card } = await import(
    "../../test-helpers/report-cards-v9"
  );
  const snapshot = makeWorkerReportCardsV9Response({
    updatedAt: 1_700_000_000,
    cards: [makeWorkerV9Card({ id: "usdc-circle", grade: "A", score: 85 })],
  });
  return {
    loadActiveSafetyScoreSource: vi.fn(async () => ({
      kind: "v9",
      snapshot,
    })),
  };
});

describe("handleTelegramWebhook", () => {
  beforeEach(resetTelegramWebhookTest);
  it("finalizes pending /set disambiguation with the shared completion handler", async () => {
    const ambiguous = resolveTicker("USDF");
    const usdc = resolveTicker("USDC");
    if (ambiguous.status !== "ambiguous" || usdc.status !== "unique") {
      throw new Error("Expected fixed ticker fixtures for telegram set disambiguation flow test");
    }

    const db = makeTelegramWebhookDb([
      {
        match: "FROM telegram_pending_disambiguation WHERE chat_id = ?",
        rows: [],
        first: {
          action_type: "set",
          action_payload: JSON.stringify({
            schemaVersion: 1,
            ticker: "USDF",
            setting: "dews",
            enabled: true,
            minBand: "WARNING",
            resolvedIds: [],
            ambiguousTicker: "USDF",
            candidates: ambiguous.matches,
            remainingTickers: ["USDC"],
          }),
          alert_types: JSON.stringify([]),
          resolved_ids: JSON.stringify([]),
          ambiguous_ticker: "USDF",
          candidates: JSON.stringify(ambiguous.matches),
          remaining_tickers: JSON.stringify(["USDC"]),
          expires_at: Math.floor(Date.now() / 1000) + 60,
        },
      },
      {
        match: "FROM telegram_subscriptions",
        matchBinds: ["123", ambiguous.matches[0].id, usdc.matches[0].id],
        rows: [
          {
            stablecoin_id: ambiguous.matches[0].id,
            alert_dews: 1,
            alert_depeg: 0,
            alert_safety: 0,
            dews_min_band: "WARNING",
            safety_mode: null,
            depeg_worsening_bps_step: null,
          },
          {
            stablecoin_id: usdc.matches[0].id,
            alert_dews: 1,
            alert_depeg: 0,
            alert_safety: 0,
            dews_min_band: "WARNING",
            safety_mode: null,
            depeg_worsening_bps_step: null,
          },
        ],
      },
    ]);

    await handleTelegramWebhook(db, makeWebhookRequest(123, "1"), "test-secret", "bot-token");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("DELETE FROM telegram_pending_disambiguation"))).toBe(true);
    expect(
      history
        .filter((entry) => entry.sql.includes("INSERT INTO telegram_subscriptions"))
        .map((entry) => entry.binds[1]),
    ).toEqual([ambiguous.matches[0].id, usdc.matches[0].id]);

    const text = sentMessageBody().text;
    expect(text).toContain("Updated settings");
    expect(text).toContain("DEWS&gt;=WARNING");
  });

});
