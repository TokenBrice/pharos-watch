import { makeJsonRequest } from "./api-request-response.test-support";
import {
  mockD1 as baseMockD1,
  type MockD1Database,
  type MockTableConfig,
} from "../../test-helpers/__shared/mock-d1";
import {
  TELEGRAM_MINI_APP_CATALOG_VERSION,
  TELEGRAM_MINI_APP_CATALOG_VERSION_PARAM,
  TELEGRAM_MINI_APP_CONTRACT_VERSION,
  TELEGRAM_MINI_APP_CONTRACT_VERSION_PARAM,
} from "@shared/lib/telegram-mini-app-contract";

export const BOT_TOKEN = "123456:test-token";
export const NOW_SEC = 1_800_000_000;

export const encoder = new TextEncoder();

export function makeMiniAppDb(
  tables: Parameters<typeof baseMockD1>[0] = [],
  options: Parameters<typeof baseMockD1>[1] = {},
): MockD1Database {
  return baseMockD1([
    ...tables,
    { match: "WHERE cache.updated_at <= ?", rows: [] },
    { match: "FROM telegram_subscribers", rows: [], first: null },
    { match: "FROM telegram_subscriptions", rows: [] },
    { match: "FROM telegram_preset_subscriptions", rows: [] },
    { match: "FROM telegram_pending_alerts", rows: [], first: null },
    { match: "FROM telegram_pending_disambiguation", rows: [], first: null },
    { match: "FROM telegram_recap_preferences", rows: [], first: null },
    { match: "FROM telegram_recap_targets", rows: [] },
    { match: "INSERT OR IGNORE INTO telegram_subscribers", rows: [] },
    { match: "INSERT INTO telegram_subscribers", rows: [] },
    { match: "UPDATE telegram_subscribers", rows: [] },
    { match: "INSERT INTO telegram_subscriptions", rows: [] },
    { match: "UPDATE telegram_subscriptions", rows: [] },
    { match: "DELETE FROM telegram_subscriptions", rows: [] },
    { match: "INSERT INTO telegram_preset_subscriptions", rows: [] },
    { match: "DELETE FROM telegram_preset_subscriptions", rows: [] },
    { match: "INSERT INTO telegram_pending_disambiguation", rows: [] },
    { match: "DELETE FROM telegram_pending_disambiguation", rows: [] },
    { match: "DELETE FROM telegram_pending_alerts", rows: [] },
    { match: "INSERT INTO telegram_recap_preferences", rows: [] },
    { match: "UPDATE telegram_recap_preferences", rows: [] },
    { match: "DELETE FROM telegram_recap_targets", rows: [] },
    { match: "DELETE FROM telegram_freeze_alert_targets", rows: [] },
    { match: "DELETE FROM telegram_alert_source_resolution_targets", rows: [] },
    { match: "DELETE FROM telegram_alert_target_plan_items", rows: [] },
    { match: "DELETE FROM telegram_alert_job_targets", rows: [] },
    { match: "DELETE FROM telegram_alert_job_target_items", rows: [] },
    { match: "DELETE FROM telegram_alert_target_plans", rows: [] },
    { match: "DELETE FROM telegram_alert_planning_subscribers", rows: [] },
    { match: "DELETE FROM telegram_transport_failure_observations", rows: [] },
    { match: "DELETE FROM telegram_alert_dead_letters", rows: [] },
    { match: "DELETE FROM telegram_chat_delivery_diagnostics", rows: [] },
    { match: "INSERT OR REPLACE INTO cache", rows: [] },
    { match: "INSERT INTO cache", rows: [] },
    { match: "UPDATE cache", rows: [] },
    { match: "DELETE FROM cache", rows: [] },
    { match: "INSERT INTO telegram_usage_daily", rows: [] },
    { match: "INSERT OR IGNORE INTO telegram_processed_updates", rows: [], runMeta: { changes: 1 } },
    { match: "UPDATE telegram_processed_updates", rows: [], runMeta: { changes: 1 } },
    { match: "FROM cache", rows: [], first: null },
  ], options);
}

export async function hmacSha256(keyBytes: Uint8Array, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

export function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function signedInitData(fields: Record<string, string>, token = BOT_TOKEN): Promise<string> {
  const params = new URLSearchParams(fields);
  const check = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join("\n");
  const secret = await hmacSha256(encoder.encode("WebAppData"), token);
  params.set("hash", hex(await hmacSha256(secret, check)));
  return params.toString();
}

export function makeMiniAppRequest(path: string, body: unknown): Request {
  return makeJsonRequest(`https://api.pharos.watch${path}`, body);
}

export function makeVersionedMiniAppRequest(
  path: string,
  body: unknown,
  versions: { contractVersion?: string; catalogVersion?: string } = {},
): Request {
  const url = new URL(path, "https://api.pharos.watch");
  url.searchParams.set(
    TELEGRAM_MINI_APP_CONTRACT_VERSION_PARAM,
    versions.contractVersion ?? TELEGRAM_MINI_APP_CONTRACT_VERSION,
  );
  url.searchParams.set(
    TELEGRAM_MINI_APP_CATALOG_VERSION_PARAM,
    versions.catalogVersion ?? TELEGRAM_MINI_APP_CATALOG_VERSION,
  );
  return makeJsonRequest(url, body);
}

export function makeStreamedMiniAppRequest(
  path: string,
  chunks: string[],
  headers: Record<string, string> = {},
): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Request(`https://api.pharos.watch${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

export async function privateInitData(ageSec = 60, startParam?: string): Promise<string> {
  return signedInitData({
    auth_date: String(NOW_SEC - ageSec),
    chat_type: "private",
    ...(startParam ? { start_param: startParam } : {}),
    user: JSON.stringify({ id: 42, username: "alice" }),
  });
}

export function stateReadTables(overrides: {
  subscriber?: Record<string, unknown> | null;
  subscriptions?: Record<string, unknown>[];
  presets?: Record<string, unknown>[];
} = {}): MockTableConfig[] {
  const subscriber = overrides.subscriber ?? {
    global_alert_dews: 0,
    global_alert_depeg: 0,
    global_alert_safety: 0,
    global_alert_launch: 0,
    global_alert_reserve: 0,
    global_depeg_worsening_bps_step: null,
    quiet_hours_enabled: 0,
    quiet_hours_start_utc: null,
    quiet_hours_end_utc: null,
    timezone: null,
    alert_snooze_until_ts: null,
  };
  return [
    { match: "FROM telegram_subscribers", first: subscriber, rows: subscriber == null ? [] : [subscriber] },
    { match: "FROM telegram_subscriptions", rows: overrides.subscriptions ?? [] },
    { match: "FROM telegram_preset_subscriptions", rows: overrides.presets ?? [] },
    { match: "FROM telegram_chat_delivery_diagnostics", first: null, rows: [] },
    { match: "FROM telegram_pending_alerts", first: { queued_alerts: 0 }, rows: [{ queued_alerts: 0 }] },
  ];
}

export function historyHas(db: MockD1Database, sqlNeedle: string, bindNeedles: unknown[] = []): boolean {
  return db.getHistory().some((entry) =>
    entry.sql.includes(sqlNeedle) && bindNeedles.every((value) => entry.binds.includes(value)),
  );
}

export type { MockD1Database, MockTableConfig };
