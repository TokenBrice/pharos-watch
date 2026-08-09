import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { handleAdminTelegramAdoptionReport } from "../admin-telegram-adoption-report";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";

describe("admin Telegram adoption report", () => {
  afterEach(() => vi.useRealTimers());

  it("returns only suppressed aggregate data behind admin auth", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00Z"));
    const sqlite = createLatestSchemaSqlite().sqlite;
    sqlite.exec(`
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
