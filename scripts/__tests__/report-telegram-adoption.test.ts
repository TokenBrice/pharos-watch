import { describe, expect, it } from "vitest";
import { collectTelegramAdoptionReport, renderTelegramAdoptionBlock } from "../maintenance/report-telegram-adoption";

const NOW_SEC = 1_700_000_000;
const DAY_SEC = 24 * 60 * 60;

function fixtureClient(options: { lifecycle?: boolean; deliveries?: { final_delivery_at: number }[] } = {}) {
  const queries: string[] = [];
  return {
    queries,
    query<T>(sql: string): T[] {
      queries.push(sql);
      if (sql.includes("FROM telegram_subscribers")) return [{ subscriber_count: 855, active_watchers_7d: 11 }] as T[];
      if (sql.includes("FROM telegram_watcher_lifecycle_daily")) return (options.lifecycle === false ? [] : [
        { day: "2023-11-13", snapshot_at: NOW_SEC - DAY_SEC, active_watchers: 12 },
        { day: "2023-11-14", snapshot_at: NOW_SEC - 60, active_watchers: 14 },
      ]) as T[];
      if (sql.includes("FROM telegram_alert_job_targets")) return (options.deliveries ?? [
        { final_delivery_at: NOW_SEC - 2 * DAY_SEC },
        { final_delivery_at: NOW_SEC - 10 * DAY_SEC },
      ]) as T[];
      throw new Error(`Unexpected query: ${sql}`);
    },
    queryRaw: () => "",
    executeStatements: () => undefined,
  };
}

describe("Telegram adoption reporter", () => {
  it("keeps seven-day activity distinct from the configured-watcher snapshot and its source clock", () => {
    const client = fixtureClient();
    const report = collectTelegramAdoptionReport(client, NOW_SEC);
    expect(report.adoption).toEqual({
      subscriberCount: 855, activeWatchers7d: 11, configuredWatchersDaily: 14,
      configuredWatchersSnapshotAt: new Date((NOW_SEC - 60) * 1000).toISOString(),
      alertsSent7d: null, alertsSent7dUnavailableReason: "delivery-window-coverage-unproven",
      alertsSent30d: null, alertsSent30dUnavailableReason: "source-retention-shorter-than-window",
      retainedAlertsSent7d: 1, retainedAlertsSent30d: 2,
    });
    expect(report.generatedAt).toBe(new Date(NOW_SEC * 1000).toISOString());
    expect(Object.keys(report).sort()).toEqual(["adoption", "generatedAt"]);
    const block = renderTelegramAdoptionBlock(report);
    expect(block).toContain("<!-- GENERATED-START: telegram-adoption -->");
    expect(block).toContain("<!-- GENERATED-END: telegram-adoption -->");
    expect(block).toContain("### Telegram adoption");
    expect(block).toContain(`Observed ${report.generatedAt}`);
    expect(block).toContain("855");
    expect(block).toContain("| Active watchers (7d) | 11 |");
    expect(block).toContain("| Configured watchers (daily snapshot) | 14 |");
    expect(block).toContain(`| Configured watchers snapshot observed at | ${report.adoption.configuredWatchersSnapshotAt} |`);
    expect(block).not.toMatch(/planning|proceed41|14-day|4\.2|4\.3/i);
  });

  it("reports missing configured-watcher snapshots as unavailable without substituting weekly activity", () => {
    const report = collectTelegramAdoptionReport(fixtureClient({ lifecycle: false, deliveries: [] }), NOW_SEC);
    expect(report.adoption).toEqual({
      subscriberCount: 855, activeWatchers7d: 11, configuredWatchersDaily: null,
      configuredWatchersSnapshotAt: null,
      alertsSent7d: null, alertsSent7dUnavailableReason: "delivery-window-coverage-unproven",
      alertsSent30d: null, alertsSent30dUnavailableReason: "source-retention-shorter-than-window",
      retainedAlertsSent7d: 0, retainedAlertsSent30d: 0,
    });
    expect(renderTelegramAdoptionBlock(report)).toContain("| Configured watchers (daily snapshot) | not measured |");
  });

  it.each<[string, { final_delivery_at: number }[]]>([
    ["empty retained source", []],
    ["nonempty retained source", [{ final_delivery_at: NOW_SEC - DAY_SEC }]],
  ])("does not infer seven-day coverage from %s", (_label, deliveries) => {
    const report = collectTelegramAdoptionReport(fixtureClient({ deliveries }), NOW_SEC);
    expect(report.adoption.alertsSent7d).toBeNull();
    expect(report.adoption.alertsSent7dUnavailableReason).toBe("delivery-window-coverage-unproven");
    expect(renderTelegramAdoptionBlock(report)).toContain("| Alerts sent (7d / 30d) | not measured / not measured |");
  });

  it("does not turn a retained 14-day subtotal into a 30-day total after a 20-day target was pruned", () => {
    // Frozen 30-day history: accepted deliveries at day -20 and day -2.
    // Only day -2 survives the authoritative replay window; usage counters cannot restore day -20.
    const client = fixtureClient({ deliveries: [{ final_delivery_at: NOW_SEC - 2 * DAY_SEC }] });
    const report = collectTelegramAdoptionReport(client, NOW_SEC);
    expect(report.adoption.alertsSent30d).toBeNull();
    expect(report.adoption.alertsSent30dUnavailableReason).toBe("source-retention-shorter-than-window");
    expect(report.adoption.retainedAlertsSent30d).toBe(1);
    const block = renderTelegramAdoptionBlock(report);
    expect(block).toContain("source-retention-shorter-than-window");
    expect(block).toContain("delivery-window-coverage-unproven");
    expect(block).toContain("| Retained accepted targets only (7d / 30d; not complete delivery totals) | 1 / 1 |");
    expect(client.queries.join("\n")).not.toContain("telegram_usage_daily");
  });

  it("reports a successfully queried complete empty retained-target domain as zero, not a full-window zero", () => {
    const report = collectTelegramAdoptionReport(fixtureClient({ deliveries: [] }), NOW_SEC);
    expect(report.adoption.retainedAlertsSent7d).toBe(0);
    expect(report.adoption.retainedAlertsSent30d).toBe(0);
    expect(report.adoption.alertsSent7d).toBeNull();
    expect(report.adoption.alertsSent30d).toBeNull();
    expect(renderTelegramAdoptionBlock(report)).toContain("| Retained accepted targets only (7d / 30d; not complete delivery totals) | 0 / 0 |");
  });

  it("bounds retained delivery subtotals by final_delivery_at without treating source age as delivery age", () => {
    const report = collectTelegramAdoptionReport(fixtureClient({ deliveries: [
      { final_delivery_at: NOW_SEC - 30 * DAY_SEC - 1 },
      { final_delivery_at: NOW_SEC - 30 * DAY_SEC },
      { final_delivery_at: NOW_SEC - 7 * DAY_SEC },
      { final_delivery_at: NOW_SEC },
      { final_delivery_at: NOW_SEC + 1 },
    ] }), NOW_SEC);
    expect(report.adoption.retainedAlertsSent7d).toBe(2);
    expect(report.adoption.retainedAlertsSent30d).toBe(3);
    expect(report.adoption.alertsSent7d).toBeNull();
  });

  it("propagates a failed delivery read instead of publishing unavailable counts as empty success", () => {
    const client = fixtureClient();
    const query = client.query.bind(client);
    client.query = <T>(sql: string): T[] => {
      if (sql.includes("FROM telegram_alert_job_targets")) throw new Error("d1-query-failed");
      return query<T>(sql);
    };
    expect(() => collectTelegramAdoptionReport(client, NOW_SEC)).toThrow("d1-query-failed");
  });

});
