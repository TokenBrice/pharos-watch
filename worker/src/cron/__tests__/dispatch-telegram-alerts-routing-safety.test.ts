import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupDispatchTelegramAlertsTest,
  createDispatchHarness,
  dispatchTelegramAlerts,
  makeSafetySnapshotCache,
  makeSafetySourceCache,
  readCacheValue,
  resetDispatchTelegramAlertsTest,
  telegramDeliveryTranscript,
} from "./dispatch-telegram-alerts.test-support";

type SafetySnapshot = Record<string, { grade: string; score: number | null; methodologyVersion: string | null }>;

function snapshots(
  harness: ReturnType<typeof createDispatchHarness>,
  options: {
    dews?: Record<string, string>;
    dewsAlertable?: Record<string, string>;
    depeg?: Record<string, unknown>;
    safety?: SafetySnapshot | string;
    safetySource?: SafetySnapshot | string;
    updatedAt?: number;
  } = {},
) {
  const updatedAt = options.updatedAt ?? Math.floor(Date.now() / 1000) - 60;
  harness.cache("alert:dews-snapshot", options.dews ?? {}, updatedAt);
  if (options.dewsAlertable !== undefined)
    harness.cache("alert:dews-alertable-snapshot", options.dewsAlertable, updatedAt);
  harness.cache("alert:depeg-snapshot", options.depeg ?? {}, updatedAt);
  harness.cache(
    "alert:safety-snapshot",
    typeof options.safety === "string" ? options.safety : makeSafetySnapshotCache(options.safety ?? {}).value,
    updatedAt,
  );
  if (options.safetySource !== undefined) {
    harness.cache(
      "alert:safety-source-cache",
      typeof options.safetySource === "string"
        ? options.safetySource
        : makeSafetySourceCache(options.safetySource, updatedAt).value,
      updatedAt,
    );
  }
}

function direct(chatId: string, alerts: Record<string, boolean>, options: Record<string, unknown> = {}) {
  return {
    subscribers: [{ chatId, ...((options.subscriber as object | undefined) ?? {}) }],
    subscriptions: [
      {
        chatId,
        stablecoinId: String(options.stablecoinId ?? "usdc-circle"),
        alerts,
        ...((options.subscription as object | undefined) ?? {}),
      },
    ],
  };
}

function global(chatId: string, alerts: Record<string, boolean>, options: Record<string, unknown> = {}) {
  return { subscribers: [{ chatId, global: alerts, ...options }] };
}

describe("dispatchTelegramAlerts", () => {
  beforeEach(resetDispatchTelegramAlertsTest);
  afterEach(cleanupDispatchTelegramAlertsTest);

  it("detects DEWS/depeg/safety changes and fans out to subscribers", async () => {
    const now = Math.floor(Date.now() / 1000);
    const harness = createDispatchHarness();
    snapshots(harness, {
      dews: { "usdc-circle": "CALM" },
      safety: { "usdc-circle": { grade: "B", score: 78, methodologyVersion: "7.09" } },
      safetySource: { "usdc-circle": { grade: "C", score: 61, methodologyVersion: "7.09" } },
    });
    harness.seed({
      dews: [{ stablecoinId: "usdc-circle", signals: { supply: { value: 45, available: true } } }],
      depegs: [{ stablecoinId: "usdc-circle" }],
      safety: [{ stablecoinId: "usdc-circle", grade: "C", score: 61 }],
      subscribers: [{ chatId: "12345", lastActiveAt: now }],
      subscriptions: [
        { chatId: "12345", stablecoinId: "usdc-circle", alerts: { dews: true, depeg: true, safety: true } },
      ],
    });
    const result = await dispatchTelegramAlerts(harness.db, "bot-token");
    const metadata = JSON.parse(result.metadata);

    expect(metadata.eventsDetected).toMatchObject({
      dews: 1,
      depeg: 1,
      depegTriggered: 1,
      depegResolved: 0,
      depegWorsening: 0,
      safety: 1,
      suppressedMethodologyChanges: 0,
    });
    expect(metadata).toMatchObject({ subscribersNotified: 1, messagesSent: 1 });
    expect(telegramDeliveryTranscript).toEqual([expect.objectContaining({ chatId: "12345" })]);
  });

  it("suppresses only safety alerts when the live safety source cache is from the wrong generation", async () => {
    const now = Math.floor(Date.now() / 1000);
    const harness = createDispatchHarness();
    snapshots(harness, {
      dews: { "usdc-circle": "CALM" },
      safety: makeSafetySnapshotCache(
        { "usdc-circle": { grade: "B", score: 78, methodologyVersion: "7.08" } },
        "legacy-generation",
      ).value,
      safetySource: JSON.stringify({
        generation: "legacy-generation",
        methodologyVersion: "7.09",
        publishedAt: now - 60,
        snapshot: { "usdc-circle": { grade: "C", score: 61, methodologyVersion: "7.09" } },
      }),
    });
    harness.seed({
      dews: [{ stablecoinId: "usdc-circle" }],
      safety: [
        {
          stablecoinId: "usdc-circle",
          grade: "C",
          score: 61,
          prevGrade: "B",
          prevScore: 78,
          methodologyVersion: "7.09",
        },
      ],
      ...direct("12345", { dews: true, safety: true }),
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata).toMatchObject({
      eventsDetected: { dews: 1, safety: 0 },
      messagesSent: 1,
      safetyAlertSourceState: "wrong-generation",
      safetyAlertsSuppressed: true,
    });
    expect(telegramDeliveryTranscript).toEqual([expect.objectContaining({ chatId: "12345" })]);
  });

  it("fans out global all-stablecoin alert subscriptions without per-coin rows", async () => {
    const harness = createDispatchHarness();
    snapshots(harness, { dews: { "usdc-circle": "CALM" } });
    harness.seed({
      dews: [{ stablecoinId: "usdc-circle", signals: { supply: { value: 45, available: true } } }],
      ...global("777", { dews: true }),
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata).toMatchObject({ eventsDetected: { dews: 1 }, subscribersNotified: 1, messagesSent: 1 });
    expect(telegramDeliveryTranscript).toEqual([expect.objectContaining({ chatId: "777" })]);
  });

  it("sends global safety alerts only for material downgrades", async () => {
    const harness = createDispatchHarness();
    const safety = { "usdc-circle": { grade: "C+", score: 66, methodologyVersion: "7.09" } };
    snapshots(harness, {
      safety: { "usdc-circle": { grade: "B", score: 70, methodologyVersion: "7.09" } },
      safetySource: safety,
    });
    harness.seed({
      safety: [{ stablecoinId: "usdc-circle", grade: "C+", score: 66 }],
      ...global("777", { safety: true }),
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata).toMatchObject({ eventsDetected: { safety: 1 }, subscribersNotified: 1, messagesSent: 1 });
    expect(telegramDeliveryTranscript).toEqual([expect.objectContaining({ chatId: "777" })]);
  });

  it("sends global safety alerts for scoreless downgrades", async () => {
    const harness = createDispatchHarness();
    const safety = { "usdc-circle": { grade: "C+", score: null, methodologyVersion: "7.09" } };
    snapshots(harness, {
      safety: { "usdc-circle": { grade: "B", score: null, methodologyVersion: "7.09" } },
      safetySource: safety,
    });
    harness.seed({ safety: [{ stablecoinId: "usdc-circle", grade: "C+" }], ...global("777", { safety: true }) });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata).toMatchObject({ eventsDetected: { safety: 1 }, subscribersNotified: 1, messagesSent: 1 });
    expect(telegramDeliveryTranscript).toEqual([expect.objectContaining({ chatId: "777" })]);
  });

  it("suppresses minor global safety downgrades", async () => {
    const harness = createDispatchHarness();
    const safety = { "usdc-circle": { grade: "C+", score: 64, methodologyVersion: "7.09" } };
    snapshots(harness, {
      safety: { "usdc-circle": { grade: "B-", score: 65, methodologyVersion: "7.09" } },
      safetySource: safety,
    });
    harness.seed({
      safety: [{ stablecoinId: "usdc-circle", grade: "C+", score: 64 }],
      ...global("777", { safety: true }),
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata).toMatchObject({ eventsDetected: { safety: 1 }, subscribersNotified: 0, messagesSent: 0 });
    expect(telegramDeliveryTranscript).toEqual([]);
  });

  it("batches resolved depeg lookups into one query", async () => {
    const now = Math.floor(Date.now() / 1000);
    const harness = createDispatchHarness();
    snapshots(harness, {
      depeg: {
        "usdc-circle": { symbol: "USDC", direction: "below", deviationBps: 125, price: 0.9875, pegReference: 1 },
        "usdt-tether": { symbol: "USDT", direction: "below", deviationBps: 110, price: 0.989, pegReference: 1 },
      },
    });
    harness.seed({
      depegs: [
        {
          stablecoinId: "usdc-circle",
          symbol: "USDC",
          peakDeviationBps: 125,
          startedAt: now - 3_600,
          endedAt: now - 300,
          recoveryPrice: 1,
        },
        {
          stablecoinId: "usdt-tether",
          symbol: "USDT",
          peakDeviationBps: 110,
          startedAt: now - 1_800,
          endedAt: now - 240,
          recoveryPrice: 1,
        },
      ],
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata.eventsDetected).toMatchObject({ depegResolved: 2, depeg: 2 });
    expect(
      harness.operations.filter((entry) => entry.operation === "resolved-depeg-lookup").map((entry) => entry.binds),
    ).toEqual([["usdc-circle", "usdt-tether"]]);
    expect(harness.sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_alert_source_events").get()).toEqual({
      count: 1,
    });
  });

  it("chunks resolved depeg IN queries above 100 changed coins", async () => {
    const now = Math.floor(Date.now() / 1000);
    const ids = Array.from({ length: 101 }, (_, index) => `synthetic-${index}`);
    const harness = createDispatchHarness();
    snapshots(harness, {
      depeg: Object.fromEntries(
        ids.map((id, index) => [
          id,
          { symbol: `S${index}`, direction: "below", deviationBps: 125, price: 0.9875, pegReference: 1 },
        ]),
      ),
    });
    harness.seed({
      depegs: ids.map((stablecoinId, index) => ({
        stablecoinId,
        symbol: `S${index}`,
        peakDeviationBps: 125,
        startedAt: now - 3_600,
        endedAt: now - 300,
        recoveryPrice: 1,
      })),
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata.eventsDetected.depegResolved).toBe(101);
    expect(
      harness.operations
        .filter((entry) => entry.operation === "resolved-depeg-lookup")
        .map((entry) => entry.binds.length),
    ).toEqual([90, 11]);
    expect(harness.sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_alert_source_events").get()).toEqual({
      count: 1,
    });
    expect(telegramDeliveryTranscript).toEqual([]);
  });

  it("lets a per-coin DEWS threshold override a global all-stablecoin follow", async () => {
    const harness = createDispatchHarness();
    snapshots(harness, { dews: { "usdc-circle": "CALM" } });
    harness.seed({
      dews: [{ stablecoinId: "usdc-circle", band: "ALERT" }],
      subscribers: [{ chatId: "777", global: { dews: true } }],
      subscriptions: [{ chatId: "777", stablecoinId: "usdc-circle", alerts: { dews: true }, dewsMinBand: "WARNING" }],
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata).toMatchObject({ subscribersNotified: 0, messagesSent: 0 });
    expect(telegramDeliveryTranscript).toEqual([]);
  });

  it("lets a per-coin safety follow override the global material-only safety tier", async () => {
    const harness = createDispatchHarness();
    const safety = { "usdc-circle": { grade: "C+", score: 64, methodologyVersion: "7.09" } };
    snapshots(harness, {
      safety: { "usdc-circle": { grade: "B-", score: 65, methodologyVersion: "7.09" } },
      safetySource: safety,
    });
    harness.seed({
      safety: [{ stablecoinId: "usdc-circle", grade: "C+", score: 64 }],
      subscribers: [{ chatId: "777", global: { safety: true } }],
      subscriptions: [{ chatId: "777", stablecoinId: "usdc-circle", alerts: { safety: true } }],
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata).toMatchObject({ subscribersNotified: 1, messagesSent: 1 });
    expect(telegramDeliveryTranscript).toEqual([expect.objectContaining({ chatId: "777" })]);
  });

  it("lets a restrictive per-coin safety mode suppress the global safety tier", async () => {
    const harness = createDispatchHarness();
    const safety = { "usdc-circle": { grade: "C+", score: 66, methodologyVersion: "7.09" } };
    snapshots(harness, {
      safety: { "usdc-circle": { grade: "B", score: 70, methodologyVersion: "7.09" } },
      safetySource: safety,
    });
    harness.seed({
      safety: [{ stablecoinId: "usdc-circle", grade: "C+", score: 66 }],
      subscribers: [{ chatId: "777", global: { safety: true } }],
      subscriptions: [
        { chatId: "777", stablecoinId: "usdc-circle", alerts: { safety: true }, safetyMode: "upgrade-only" },
      ],
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata).toMatchObject({ subscribersNotified: 0, messagesSent: 0 });
    expect(telegramDeliveryTranscript).toEqual([]);
  });

  it("treats first-seen ids in a partial legacy safety snapshot as seed-only without alerting", async () => {
    const now = 1_778_150_000;
    const updatedAt = now - 3_600;
    const harness = createDispatchHarness();
    snapshots(harness, {
      safety: JSON.stringify({ "usdc-circle": { grade: "A", score: 84 } }),
      safetySource: {
        "usdc-circle": { grade: "A", score: 84, methodologyVersion: "7.09" },
        "bold-liquity": { grade: "B+", score: 79, methodologyVersion: "7.09" },
      },
      updatedAt,
    });
    harness.seed({
      safety: [
        { stablecoinId: "usdc-circle", grade: "A", score: 84, recordedAt: updatedAt - 86_400 },
        {
          stablecoinId: "bold-liquity",
          grade: "B+",
          score: 79,
          prevGrade: "A-",
          prevScore: 80,
          recordedAt: updatedAt + 60,
        },
      ],
      ...direct("12345", { safety: true }, { stablecoinId: "bold-liquity" }),
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata).toMatchObject({ eventsDetected: { safety: 0 }, subscribersNotified: 0 });
    expect(telegramDeliveryTranscript).toEqual([]);
    expect(readCacheValue(harness.sqlite, "alert:safety-snapshot")).toContain('"bold-liquity"');
    expect(readCacheValue(harness.sqlite, "alert:safety-snapshot")).toContain('"usdc-circle"');
  });

  it("does not alert on historical rows missing from a partial legacy safety snapshot", async () => {
    const now = 1_778_150_000;
    const updatedAt = now - 3_600;
    const harness = createDispatchHarness();
    snapshots(harness, {
      safety: JSON.stringify({ "usdc-circle": { grade: "A", score: 84 } }),
      safetySource: {
        "usdc-circle": { grade: "A", score: 84, methodologyVersion: "7.09" },
        "bold-liquity": { grade: "A-", score: 80, methodologyVersion: "7.09" },
      },
      updatedAt,
    });
    harness.seed({
      safety: [
        { stablecoinId: "usdc-circle", grade: "A", score: 84, recordedAt: updatedAt - 86_400 },
        {
          stablecoinId: "bold-liquity",
          grade: "A-",
          score: 80,
          prevGrade: "B+",
          prevScore: 79,
          recordedAt: updatedAt - 86_400,
        },
      ],
    });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata).toMatchObject({ eventsDetected: { safety: 0 }, subscribersNotified: 0, messagesSent: 0 });
    expect(telegramDeliveryTranscript).toEqual([]);
    expect(readCacheValue(harness.sqlite, "alert:safety-snapshot")).toContain('"bold-liquity"');
    expect(readCacheValue(harness.sqlite, "alert:safety-snapshot")).toContain('"usdc-circle"');
  });

  it("ignores DEWS transitions to CALM/WATCH", async () => {
    const harness = createDispatchHarness();
    snapshots(harness, { dews: { "usdc-circle": "ALERT" } });
    harness.seed({ dews: [{ stablecoinId: "usdc-circle", score: 20, band: "WATCH" }] });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata.eventsDetected.dews).toBe(0);
    expect(telegramDeliveryTranscript).toEqual([]);
  });

  it("does not resend the same DEWS alert band after a silent WATCH/CALM dip", async () => {
    const harness = createDispatchHarness();
    snapshots(harness, { dews: { "uusd-youves": "WATCH" }, dewsAlertable: { "uusd-youves": "ALERT" } });
    harness.seed({ dews: [{ stablecoinId: "uusd-youves", score: 39, band: "ALERT" }] });
    const metadata = JSON.parse((await dispatchTelegramAlerts(harness.db, "bot-token")).metadata);

    expect(metadata).toMatchObject({ eventsDetected: { dews: 0 }, messagesSent: 0 });
    expect(telegramDeliveryTranscript).toEqual([]);
    expect(readCacheValue(harness.sqlite, "alert:dews-alertable-snapshot")).toContain('"uusd-youves":"ALERT"');
  });
});
