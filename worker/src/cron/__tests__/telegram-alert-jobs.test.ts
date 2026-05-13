import { describe, expect, it } from "vitest";
import type { PerAlertTypeDelivery } from "@shared/types/status";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";
import {
  finalizeTelegramAlertJobManifests,
  persistTelegramAlertJobManifests,
} from "../telegram-alert-jobs";
import type { RoutedSubscriberAlert } from "../dispatch-telegram-routing";

function subscriber(partial: Partial<RoutedSubscriberAlert> = {}): RoutedSubscriberAlert {
  const canonicalHtml = partial.canonicalHtml ?? "<b>USDC depeg</b>";
  return {
    chatId: partial.chatId ?? "100",
    lastActiveAt: partial.lastActiveAt ?? 1_800_000_000,
    alerts: partial.alerts ?? {
      dews: [],
      depegTriggered: [],
      depegResolved: [],
      depegWorsening: [],
      safety: [],
      launch: [],
    },
    canonicalHtml,
    chunks: partial.chunks ?? [canonicalHtml],
    disableNotification: partial.disableNotification ?? false,
    alertType: partial.alertType ?? "depeg",
  };
}

function emptyDelivery(): PerAlertTypeDelivery {
  return {
    depeg: { sent: 0, enqueued: 0, failed: 0, blocked: 0, firstSendLatencyMs: null },
    dews: { sent: 0, enqueued: 0, failed: 0, blocked: 0, firstSendLatencyMs: null },
    safety: { sent: 0, enqueued: 0, failed: 0, blocked: 0, firstSendLatencyMs: null },
    launch: { sent: 0, enqueued: 0, failed: 0, blocked: 0, firstSendLatencyMs: null },
  };
}

describe("telegram alert job manifests", () => {
  it("persists durable jobs and cursorable targets grouped by alert type", async () => {
    const db = mockD1();
    const manifests = await persistTelegramAlertJobManifests(
      db,
      [
        subscriber({ chatId: "100", alertType: "depeg", chunks: ["a", "b"], canonicalHtml: "ab" }),
        subscriber({ chatId: "200", alertType: "safety", chunks: ["s"], canonicalHtml: "s" }),
      ],
      1_800_000_000,
    );

    expect(manifests.map((manifest) => manifest.alertType).sort()).toEqual(["depeg", "safety"]);
    expect(manifests.find((manifest) => manifest.alertType === "depeg")?.targetCount).toBe(2);
    expect(manifests.find((manifest) => manifest.alertType === "safety")?.targetCount).toBe(1);

    const history = db.getHistory();
    const jobInserts = history.filter((entry) => entry.sql.includes("INSERT INTO telegram_alert_jobs"));
    const targetInserts = history.filter((entry) => entry.sql.includes("INSERT INTO telegram_alert_job_targets"));
    expect(jobInserts).toHaveLength(2);
    expect(targetInserts).toHaveLength(3);
    expect(jobInserts.every((entry) => String(entry.binds[0]).startsWith("telegram:"))).toBe(true);
    expect(targetInserts.map((entry) => entry.binds[2]).sort()).toEqual(["100", "100", "200"]);
  });

  it("finalizes job counters from per-alert-type delivery stats", async () => {
    const db = mockD1();
    const perAlertType = emptyDelivery();
    perAlertType.depeg.sent = 7;
    perAlertType.depeg.enqueued = 2;
    perAlertType.depeg.blocked = 1;

    await finalizeTelegramAlertJobManifests(
      db,
      [{ jobId: "telegram:depeg:abc", alertType: "depeg", targetCount: 10 }],
      perAlertType,
      1_800_000_060,
    );

    const update = db.getHistory().find((entry) => entry.sql.includes("UPDATE telegram_alert_jobs"));
    expect(update?.binds[0]).toBe("degraded");
    expect(update?.binds[1]).toBe(7);
    expect(update?.binds[2]).toBe(2);
    expect(update?.binds[3]).toBe(1);
    expect(update?.binds[5]).toBe("telegram:depeg:abc");
  });
});
