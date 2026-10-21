import { beforeEach, describe, expect, it, vi } from "vitest";

const { cacheRows, sendToChatMock } = vi.hoisted(() => ({
  cacheRows: new Map<string, { value: string; updatedAt: number }>(),
  sendToChatMock: vi.fn(async (..._args: unknown[]) => ({ ok: true })),
}));

vi.mock("../../lib/db-cache", () => ({
  getCache: vi.fn(async (_db: unknown, key: string) => cacheRows.get(key) ?? null),
  setCache: vi.fn(async (_db: unknown, key: string, value: string) => {
    cacheRows.set(key, { value, updatedAt: 0 });
  }),
}));

vi.mock("../../telegram/delivery/telegram", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../telegram/delivery/telegram")>()),
  sendToChat: sendToChatMock,
}));

import type { ReserveSyncStateRecord } from "../../lib/live-reserves/store";
import {
  RESERVE_OPERATOR_ALERT_COOLDOWN_SEC,
  alertOnReserveTransitions,
  buildReserveSyncConditions,
  type ReserveAlertCondition,
} from "../reserve-sync-operator-alert";

const db = {} as D1Database;
const creds = { botToken: "bot", chatId: "ops" };

function syncState(
  stablecoinId: string,
  lastStatus: ReserveSyncStateRecord["lastStatus"],
  extra: Partial<ReserveSyncStateRecord> = {},
): ReserveSyncStateRecord {
  return {
    stablecoinId,
    adapterKey: "adapter",
    breakerKey: "breaker",
    lastAttemptedAt: 1,
    lastSuccessAt: 1,
    lastStatus,
    warningCount: extra.warnings?.length ?? 0,
    warnings: [],
    lastError: null,
    metadata: {},
    ...extra,
  } as ReserveSyncStateRecord;
}

const boldDegraded = syncState("bold-liquity", "degraded", {
  warnings: [{
    code: "branch-reserve-book-partial",
    message: "liquity-v2-branches unavailable or unclassified constituents: WETH (balance-unavailable)",
    severity: "warning",
    effect: "degraded",
  }],
});

function coinConditions(...states: ReserveSyncStateRecord[]): ReserveAlertCondition[] {
  return buildReserveSyncConditions(
    new Map(states.map((state) => [state.stablecoinId, state])),
    states.map((state) => state.stablecoinId),
  );
}

describe("reserve sync operator alert", () => {
  beforeEach(() => {
    cacheRows.clear();
    sendToChatMock.mockClear();
    sendToChatMock.mockResolvedValue({ ok: true });
  });

  it("watches only configured coins whose sync is degraded or errored", () => {
    const conditions = buildReserveSyncConditions(new Map([
      ["bold-liquity", boldDegraded],
      ["usdc-circle", syncState("usdc-circle", "ok")],
      ["frax", syncState("frax", "error", { lastError: "HTTP 502", metadata: { failureCategory: "upstream-http" } })],
      ["not-configured", syncState("not-configured", "error")],
    ]), ["bold-liquity", "usdc-circle", "frax"]);
    expect(conditions.map(({ id, signature }) => [id, signature])).toEqual([
      ["bold-liquity", "degraded:branch-reserve-book-partial"],
      ["frax", "error:upstream-http"],
    ]);
    expect(conditions[0]?.line).toContain("WETH (balance-unavailable)");
  });

  it("alerts new and recovered coins once, re-raising only on a changed reason", async () => {
    const first = await alertOnReserveTransitions({ db, conditions: coinConditions(boldDegraded), nowSec: 1_000, operatorTelegramCreds: creds });
    expect(first).toMatchObject({ raised: ["coin:bold-liquity"], sent: true });
    expect(sendToChatMock.mock.calls[0]?.[1]).toContain("Reserve sync degraded");
    expect(sendToChatMock.mock.calls[0]?.[1]).toContain("bold-liquity: degraded — branch-reserve-book-partial");

    const quiet = await alertOnReserveTransitions({ db, conditions: coinConditions(boldDegraded), nowSec: 10_000, operatorTelegramCreds: creds });
    expect(quiet).toMatchObject({ raised: [], recovered: [], sent: false });

    const errored = syncState("bold-liquity", "error", { metadata: { failureCategory: "rpc-timeout" } });
    const changed = await alertOnReserveTransitions({ db, conditions: coinConditions(errored), nowSec: 20_000, operatorTelegramCreds: creds });
    expect(changed).toMatchObject({ raised: ["coin:bold-liquity"], sent: true });

    const recovered = await alertOnReserveTransitions({ db, conditions: [], nowSec: 30_000, operatorTelegramCreds: creds });
    expect(recovered).toMatchObject({ recovered: ["coin:bold-liquity"], sent: true });
    expect(sendToChatMock.mock.calls[2]?.[1]).toContain("Reserve sync recovered");
    expect(sendToChatMock).toHaveBeenCalledTimes(3);
  });

  it("holds transitions during the cooldown and retries them afterwards", async () => {
    await alertOnReserveTransitions({ db, conditions: coinConditions(boldDegraded), nowSec: 1_000, operatorTelegramCreds: creds });
    const during = await alertOnReserveTransitions({ db, conditions: [], nowSec: 1_000 + RESERVE_OPERATOR_ALERT_COOLDOWN_SEC - 1, operatorTelegramCreds: creds });
    expect(during).toMatchObject({ recovered: ["coin:bold-liquity"], sent: false, cooldown: true });
    const after = await alertOnReserveTransitions({ db, conditions: [], nowSec: 1_000 + RESERVE_OPERATOR_ALERT_COOLDOWN_SEC, operatorTelegramCreds: creds });
    expect(after).toMatchObject({ recovered: ["coin:bold-liquity"], sent: true });
    expect(sendToChatMock).toHaveBeenCalledTimes(2);
  });

  it("drops delivery without creds and keeps the transition pending", async () => {
    const unconfigured = await alertOnReserveTransitions({ db, conditions: coinConditions(boldDegraded), nowSec: 1_000, operatorTelegramCreds: null });
    expect(unconfigured).toMatchObject({ raised: ["coin:bold-liquity"], sent: false, cooldown: false });
    expect(sendToChatMock).not.toHaveBeenCalled();
    const configured = await alertOnReserveTransitions({ db, conditions: coinConditions(boldDegraded), nowSec: 2_000, operatorTelegramCreds: creds });
    expect(configured).toMatchObject({ raised: ["coin:bold-liquity"], sent: true });
  });

  it("retries after a failed delivery", async () => {
    sendToChatMock.mockResolvedValueOnce({ ok: false });
    const failed = await alertOnReserveTransitions({ db, conditions: coinConditions(boldDegraded), nowSec: 1_000, operatorTelegramCreds: creds });
    expect(failed).toMatchObject({ sent: false, deliveryFailed: true });
    const retry = await alertOnReserveTransitions({ db, conditions: coinConditions(boldDegraded), nowSec: 1_001, operatorTelegramCreds: creds });
    expect(retry).toMatchObject({ raised: ["coin:bold-liquity"], sent: true });
  });

  it("keeps prior state for sections whose evidence could not be read", async () => {
    const rule: ReserveAlertCondition = { section: "rule", id: "reserve-curated-fallback", signature: "active", line: "7 live-enabled coins on curated fallback" };
    await alertOnReserveTransitions({ db, conditions: [rule, ...coinConditions(boldDegraded)], nowSec: 1_000, operatorTelegramCreds: creds });
    const unknown = await alertOnReserveTransitions({ db, conditions: [rule], unknownSections: ["coin"], nowSec: 10_000, operatorTelegramCreds: creds });
    expect(unknown).toMatchObject({ raised: [], recovered: [], sent: false });
    expect(JSON.parse(cacheRows.get("reserve-post-sync-watchdog:operator-state:v1")!.value)).toHaveProperty("coin:bold-liquity");
  });

  it("summarizes long cohorts within the Telegram message limit", async () => {
    const states = Array.from({ length: 40 }, (_, index) => syncState(`coin-${index}`, "error", { lastError: "x".repeat(300) }));
    await alertOnReserveTransitions({ db, conditions: coinConditions(...states), nowSec: 1_000, operatorTelegramCreds: creds });
    const text = String(sendToChatMock.mock.calls[0]?.[1]);
    expect(text).toContain("+30 more");
    expect(text.length).toBeLessThan(4_096);
  });
});
