import { describe, expect, it } from "vitest";
import { collectTelegramAdoptionReport, renderTelegramAdoptionBlock } from "../maintenance/report-telegram-adoption";

const NOW_SEC = 1_700_000_000;
const DAY_SEC = 24 * 60 * 60;

function fixtureClient(options: { lifecycle?: boolean; deliveries?: boolean } = {}) {
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
      if (sql.includes("FROM telegram_usage_daily")) return [
        { day: "2023-11-13", event_type: "alert_sent", outcome: "success", count: 3 },
        { day: "2023-11-14", event_type: "delivery", outcome: "failure", count: 100 },
        { day: "2023-11-14", event_type: "daily_active", outcome: "success", count: 9 },
      ] as T[];
      if (sql.includes("FROM telegram_alert_job_targets")) return (options.deliveries === false ? [] : [
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
      alertsSent7d: 1, alertsSent30d: 2,
    });
    expect(report.generatedAt).toBe(new Date(NOW_SEC * 1000).toISOString());
    expect(Object.keys(report).sort()).toEqual(["adoption", "generatedAt"]);
    expect(client.queries).toHaveLength(4);
    expect(client.queries.join("\n")).not.toMatch(/cron_runs|telegram_alert_source_events/);
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
    const report = collectTelegramAdoptionReport(fixtureClient({ lifecycle: false, deliveries: false }), NOW_SEC);
    expect(report.adoption).toEqual({
      subscriberCount: 855, activeWatchers7d: 11, configuredWatchersDaily: null,
      configuredWatchersSnapshotAt: null, alertsSent7d: 3, alertsSent30d: 3,
    });
    expect(renderTelegramAdoptionBlock(report)).toContain("| Configured watchers (daily snapshot) | not measured |");
  });
});
