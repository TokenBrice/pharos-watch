import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { handleAdminTelegramAdoptionReport } from "../admin-telegram-adoption-report";

describe("admin Telegram adoption report", () => {
  it("returns only suppressed aggregate data behind admin auth", async () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
      CREATE TABLE telegram_adoption_daily (
        day TEXT, campaign TEXT, placement TEXT, stage TEXT, feature TEXT,
        latency_bucket TEXT, outcome TEXT, count INTEGER, first_seen_at INTEGER, last_seen_at INTEGER
      );
      CREATE TABLE telegram_adoption_retention_daily (
        cohort_day TEXT, measurement_day TEXT, window_days INTEGER, feature TEXT,
        cohort_size INTEGER, retained_count INTEGER, measured_at INTEGER, quality TEXT
      );
      INSERT INTO telegram_adoption_daily VALUES
        ('2026-07-09', 'landing', 'hero', 'cta_click', '', '', 'success', 4, 1, 1);
    `);
    const response = await handleAdminTelegramAdoptionReport({
      db: createSqliteD1(sqlite),
      request: new Request("https://ops-api.pharos.watch/api/admin-telegram-adoption-report"),
      trustedAdmin: true,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    const body = await response.json() as { placements: Array<{ ctaClicks: number | null }>; quality: { warnings: string[] } };
    expect(body.placements).toEqual([expect.objectContaining({ placement: "hero", ctaClicks: null })]);
    expect(body.quality.warnings[0]).toContain("not joined users");
    expect(JSON.stringify(body)).not.toMatch(/chat[_-]?id|user[_-]?id/i);
  });

  it("rejects calls without the trusted admin context", async () => {
    const sqlite = new DatabaseSync(":memory:");
    const response = await handleAdminTelegramAdoptionReport({
      db: createSqliteD1(sqlite),
      request: new Request("https://ops-api.pharos.watch/api/admin-telegram-adoption-report"),
      trustedAdmin: false,
    });
    expect(response.status).toBe(401);
  });
});
