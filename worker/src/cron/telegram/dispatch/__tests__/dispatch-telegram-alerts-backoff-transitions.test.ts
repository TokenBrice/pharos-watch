import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedDispatchSnapshots } from "./dispatch-telegram-snapshots.test-support";
import {
  cleanupDispatchTelegramAlertsTest,
  createDispatchHarness as createBaseDispatchHarness,
  dispatchTelegramAlerts,
  mockSendToChat,
  resetDispatchTelegramAlertsTest,
  scriptTelegramDeliveries,
  telegramDeliveryTranscript,
} from "./dispatch-telegram-alerts.test-support";

// These transport scenarios need accepted DEWS, not pointerless diagnostic rows.
// Keep acceptance local to this suite so unavailable-source fixtures stay explicit.
function createDispatchHarness() {
  const harness = createBaseDispatchHarness();
  const seed = harness.seed;
  harness.seed = (input) => {
    seed(input);
    if (input.dews?.length) {
      const computedAt = Math.max(...input.dews.map((row) => row.computedAt ?? Math.floor(Date.now() / 1000)));
      harness.cache("dews:published-generation", {
        updatedAt: computedAt,
        source: "compute-dews",
        publishStatus: "published",
      }, computedAt);
    }
  };
  return harness;
}


describe("dispatchTelegramAlerts", () => {
  beforeEach(resetDispatchTelegramAlertsTest);
  afterEach(cleanupDispatchTelegramAlertsTest);

  it("records a fresh-send chat_not_found first strike without deactivating the subscriber", async () => {
    const harness = createDispatchHarness();
    seedDispatchSnapshots(harness, { dews: { "usdc-circle": "CALM" } });
    harness.seed({
      dews: [{ stablecoinId: "usdc-circle" }],
      subscribers: [{ chatId: "99999" }],
      subscriptions: [{ chatId: "99999", stablecoinId: "usdc-circle", alerts: { dews: true } }],
    });
    scriptTelegramDeliveries({
      ok: false,
      blocked: true,
      retryable: false,
      permanentFailure: true,
      statusCode: 400,
      errorClass: "chat_not_found",
      delivery: "blocked",
      retryAfterSec: null,
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata.blockedUsersCleanedUp).toBe(0);
    expect(
      harness.sqlite
        .prepare("SELECT consecutive_block_count, alert_dews FROM telegram_subscribers WHERE chat_id = '99999'")
        .get(),
    ).toEqual({ consecutive_block_count: 1, alert_dews: 0 });
    expect(
      harness.sqlite.prepare("SELECT alert_dews FROM telegram_subscriptions WHERE chat_id = '99999'").get(),
    ).toEqual({ alert_dews: 1 });
  });

  it("deactivates a fresh-send chat_not_found subscriber only on the second strike", async () => {
    const now = Math.floor(Date.now() / 1000);
    const harness = createDispatchHarness();
    seedDispatchSnapshots(harness, { dews: { "usdc-circle": "CALM" } });
    harness.seed({
      dews: [{ stablecoinId: "usdc-circle" }],
      subscribers: [{ chatId: "99999", direct: { launch: true }, global: { launch: true }, consecutiveBlockCount: 1, consecutiveBlockFirstAt: now - 60 }],
      subscriptions: [{ chatId: "99999", stablecoinId: "usdc-circle", alerts: { dews: true, launch: true } }],
    });
    expect(harness.sqlite.prepare("SELECT alert_launch, global_alert_launch FROM telegram_subscribers WHERE chat_id = '99999'").get())
      .toEqual({ alert_launch: 1, global_alert_launch: 1 });
    expect(harness.sqlite.prepare("SELECT alert_launch FROM telegram_subscriptions WHERE chat_id = '99999'").get())
      .toEqual({ alert_launch: 1 });
    scriptTelegramDeliveries({
      ok: false,
      blocked: true,
      retryable: false,
      permanentFailure: true,
      statusCode: 400,
      errorClass: "chat_not_found",
      delivery: "blocked",
      retryAfterSec: null,
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata.blockedUsersCleanedUp).toBe(1);
    expect(
      harness.sqlite
        .prepare(
          "SELECT alert_dews, alert_launch, global_alert_launch FROM telegram_subscribers WHERE chat_id = '99999'",
        )
        .get(),
    ).toEqual({ alert_dews: 0, alert_launch: 0, global_alert_launch: 0 });
    expect(
      harness.sqlite.prepare("SELECT alert_dews, alert_launch FROM telegram_subscriptions WHERE chat_id = '99999'").get(),
    ).toEqual({ alert_dews: 0, alert_launch: 0 });

    const attemptedAtDisable = mockSendToChat.mock.calls.length;
    vi.advanceTimersByTime(121_000);
    harness.seed({
      dews: [{ stablecoinId: "usdc-circle", score: 92, band: "DANGER", computedAt: now + 121 }],
    });

    const nextMetadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);
    expect(nextMetadata).toMatchObject({
      eventsDetected: { dews: 1 },
      subscribersNotified: 0,
      messagesSent: 0,
    });
    expect(mockSendToChat).toHaveBeenCalledTimes(attemptedAtDisable);
    expect(
      harness.sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_deliveries WHERE chat_id = '99999' AND state IN ('pending', 'retry')").get(),
    ).toEqual({ count: 0 });
  });

  // This case is the file's whole runtime (6.45s of 7.95s, measured 2026-09-09),
  // and the 3,665-subscriber burst is load-bearing: it is the smallest burst
  // above the production format budget, so a smaller one would make the
  // per-cycle bound below trivially true. The cost is production-side and
  // superlinear in the burst — per-flush target-plan verification (2.43s over
  // 204 correlated-count reads of the generation's target rows) plus per-send
  // job-counter reconciliation that re-aggregates every target of the job
  // (2.35s over 916 transition batches). The same file at 400 subscribers costs
  // 194ms, and the only phase seeding could skip (subscriber capture) is 110ms,
  // so pre-seeding target-plan state does not pay here.
  it("emits worsening depeg alerts when the configured bps step is crossed", async () => {
    const harness = createDispatchHarness();
    seedDispatchSnapshots(harness, {
      depeg: {
        "usdc-circle": {
          stablecoinId: "usdc-circle",
          symbol: "USDC",
          direction: "below",
          deviationBps: 120,
          price: 0.988,
          pegReference: 1,
        },
      },
    });
    harness.seed({
      depegs: [{ stablecoinId: "usdc-circle", peakDeviationBps: 260, startPrice: 0.974 }],
      subscribers: [{ chatId: "12345" }],
      subscriptions: [
        { chatId: "12345", stablecoinId: "usdc-circle", alerts: { depeg: true }, depegWorseningBpsStep: 100 },
      ],
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata.eventsDetected.depegWorsening).toBe(1);
    expect(telegramDeliveryTranscript[0]?.html).toContain("depeg deepened");
  });

  it("renders the active depeg peak price when a worsening event moved far past its opening price", async () => {
    const harness = createDispatchHarness();
    seedDispatchSnapshots(harness, {
      depeg: {
        "usdc-circle": {
          stablecoinId: "usdc-circle",
          symbol: "USDC",
          direction: "below",
          deviationBps: 3800,
          price: 0.62,
          pegReference: 1,
        },
      },
    });
    harness.seed({
      depegs: [{
        stablecoinId: "usdc-circle",
        peakDeviationBps: -5940,
        startPrice: 0.9884,
        peakPrice: 0.406,
      }],
      subscribers: [{ chatId: "12345" }],
      subscriptions: [
        { chatId: "12345", stablecoinId: "usdc-circle", alerts: { depeg: true }, depegWorseningBpsStep: 100 },
      ],
    });

    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata.eventsDetected.depegWorsening).toBe(1);
    expect(telegramDeliveryTranscript[0]?.html).toContain("depeg deepened to 59.4% below $1.00 ($0.4060)");
    expect(telegramDeliveryTranscript[0]?.html).toContain("Was 38.0% at the last alert");
    expect(telegramDeliveryTranscript[0]?.html).not.toContain("$0.9884");
  });

  it("suppresses fresh global depeg alerts below the configured bps step", async () => {
    const harness = createDispatchHarness();
    seedDispatchSnapshots(harness);
    harness.seed({
      depegs: [{ stablecoinId: "usdc-circle", peakDeviationBps: 125 }],
      subscribers: [{ chatId: "global-123", global: { depeg: true }, globalDepegWorseningBpsStep: 250 }],
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata).toMatchObject({
      eventsDetected: { depeg: 1, depegTriggered: 1 },
      messagesSent: 0,
      subscribersNotified: 0,
    });
    expect(telegramDeliveryTranscript).toEqual([]);
  });

  it("sends fresh global depeg alerts when the configured bps step is met", async () => {
    const harness = createDispatchHarness();
    seedDispatchSnapshots(harness);
    harness.seed({
      depegs: [{ stablecoinId: "usdc-circle", peakDeviationBps: 260, startPrice: 0.974 }],
      subscribers: [{ chatId: "global-123", global: { depeg: true }, globalDepegWorseningBpsStep: 250 }],
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata).toMatchObject({ eventsDetected: { depegTriggered: 1 }, messagesSent: 1, subscribersNotified: 1 });
    expect(telegramDeliveryTranscript).toEqual([
      expect.objectContaining({ chatId: "global-123", html: expect.stringContaining("2.6% below $1.00") }),
    ]);
  });

  it("emits global worsening depeg alerts when the configured global bps step is crossed", async () => {
    const harness = createDispatchHarness();
    seedDispatchSnapshots(harness, {
      depeg: {
        "usdc-circle": {
          stablecoinId: "usdc-circle",
          symbol: "USDC",
          direction: "below",
          deviationBps: 120,
          price: 0.988,
          pegReference: 1,
        },
      },
    });
    harness.seed({
      depegs: [{ stablecoinId: "usdc-circle", peakDeviationBps: 260, startPrice: 0.974 }],
      subscribers: [{ chatId: "global-123", global: { depeg: true }, globalDepegWorseningBpsStep: 100 }],
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata.eventsDetected.depegWorsening).toBe(1);
    expect(telegramDeliveryTranscript).toEqual([
      expect.objectContaining({ chatId: "global-123", html: expect.stringContaining("depeg deepened") }),
    ]);
  });

  it("clears retired launch alert flags when deactivating a blocked subscriber", async () => {
    const now = Math.floor(Date.now() / 1000);
    const harness = createDispatchHarness();
    seedDispatchSnapshots(harness, { dews: { "usdc-circle": "CALM" } });
    harness.seed({
      dews: [{ stablecoinId: "usdc-circle" }],
      subscribers: [{ chatId: "99999", direct: { launch: true }, global: { launch: true }, consecutiveBlockCount: 1, consecutiveBlockFirstAt: now - 60 }],
      subscriptions: [{ chatId: "99999", stablecoinId: "usdc-circle", alerts: { dews: true, launch: true } }],
    });
    expect(harness.sqlite.prepare("SELECT alert_launch, global_alert_launch FROM telegram_subscribers WHERE chat_id = '99999'").get())
      .toEqual({ alert_launch: 1, global_alert_launch: 1 });
    expect(harness.sqlite.prepare("SELECT alert_launch FROM telegram_subscriptions WHERE chat_id = '99999'").get())
      .toEqual({ alert_launch: 1 });
    scriptTelegramDeliveries({
      ok: false,
      blocked: true,
      retryable: false,
      permanentFailure: true,
      statusCode: 403,
      errorClass: "blocked",
      delivery: "blocked",
      retryAfterSec: null,
    });
    await dispatchTelegramAlerts(harness.db, "bot-token");

    expect(
      harness.sqlite
        .prepare("SELECT alert_launch, global_alert_launch FROM telegram_subscribers WHERE chat_id = '99999'")
        .get(),
    ).toEqual({ alert_launch: 0, global_alert_launch: 0 });
    expect(harness.sqlite.prepare("SELECT alert_launch FROM telegram_subscriptions WHERE chat_id = '99999'").get())
      .toEqual({ alert_launch: 0 });
  });

  it("does not emit a worsening alert when an active depeg flips direction (same stablecoin_id)", async () => {
    const harness = createDispatchHarness();
    seedDispatchSnapshots(harness, {
      depeg: { "usdc-circle": { symbol: "USDC", direction: "below", deviationBps: 50, price: 0.995, pegReference: 1 } },
    });
    harness.seed({
      depegs: [{ stablecoinId: "usdc-circle", direction: "above", peakDeviationBps: 100, startPrice: 1.01 }],
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata.eventsDetected).toMatchObject({ depegTriggered: 0, depegResolved: 0, depegWorsening: 0 });
  });
});
