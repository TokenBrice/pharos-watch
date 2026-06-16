import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock sendToChat so the warning sub-pass never makes a real HTTP call. The
// test file owns the queue of responses; each `sendToChat` invocation pops the
// next entry. Tests can assert call args and call counts.
type SendResult = Awaited<ReturnType<typeof import("../../lib/telegram").sendToChat>>;
const sendToChatQueue: SendResult[] = [];
const sendToChatCalls: Array<{ chatId: string; text: string; botToken: string; opts: unknown }> = [];

vi.mock("../../lib/telegram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/telegram")>();
  return {
    ...actual,
    sendToChat: vi.fn(async (chatId: string, text: string, botToken: string, opts: unknown) => {
      sendToChatCalls.push({ chatId, text, botToken, opts });
      const next = sendToChatQueue.shift();
      if (next) return next;
      return {
        ok: true,
        blocked: false,
        retryable: false,
        permanentFailure: false,
        statusCode: 200,
        errorClass: null,
        delivery: "sent",
        retryAfterSec: null,
      } satisfies SendResult;
    }),
  };
});

const { runTelegramInactiveCleanup } = await import("../telegram-inactive-cleanup");

beforeEach(() => {
  sendToChatQueue.length = 0;
  sendToChatCalls.length = 0;
});

interface SubscriberRow {
  chat_id: string;
  last_active_at: number;
}

interface ChildRow {
  chat_id: string;
}

interface UsageEventRow {
  day: string;
  event_type: string;
  source_category: string;
  action_detail: string;
  outcome: string;
  latency_bucket: string;
  failure_class: string;
  count: number;
}

const ONE_DAY_SEC = 86_400;
const INACTIVE_RETENTION_SEC = 180 * ONE_DAY_SEC;
const WARN_WINDOW_START_SEC = 170 * ONE_DAY_SEC;
const RUN_INTERVAL_SEC = 7 * ONE_DAY_SEC;
const CACHE_LAST_RUN_KEY = "cron:telegram-inactive-cleanup:last-run";
const WARN_CACHE_KEY_PREFIX = "telegram:re-engagement-warned:";

interface StubState {
  subscribers: SubscriberRow[];
  subscriptions: ChildRow[];
  presets: ChildRow[];
  pendingAlerts: ChildRow[];
  pendingDisambig: ChildRow[];
  diagnostics: ChildRow[];
  cache: Map<string, { value: string; updated_at: number }>;
  usageEvents: UsageEventRow[];
}

function deleteFromChild(rows: ChildRow[], chatId: string): number {
  let removed = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].chat_id === chatId) {
      rows.splice(i, 1);
      removed += 1;
    }
  }
  return removed;
}

function createStubDb(state: StubState): D1Database {
  function prepare(sql: string): D1PreparedStatement {
    let bound: unknown[] = [];
    const stmt = {
      bind: (...args: unknown[]) => {
        bound = args;
        return stmt as unknown as D1PreparedStatement;
      },
      run: async () => {
        if (
          sql.startsWith("INSERT INTO cache")
          || sql.startsWith("INSERT OR REPLACE INTO cache")
        ) {
          const [key, value, updatedAt] = bound as [string, string, number];
          state.cache.set(key, { value, updated_at: updatedAt });
          return { success: true, meta: { changes: 1 } };
        }
        if (sql.startsWith("INSERT INTO telegram_usage_daily")) {
          const [
            day,
            eventType,
            sourceCategory,
            actionDetail,
            outcome,
            latencyBucket,
            failureClass,
          ] = bound as [string, string, string, string, string, string, string];
          const existing = state.usageEvents.find(
            (row) =>
              row.day === day
              && row.event_type === eventType
              && row.source_category === sourceCategory
              && row.action_detail === actionDetail
              && row.outcome === outcome
              && row.latency_bucket === latencyBucket
              && row.failure_class === failureClass,
          );
          if (existing) {
            existing.count += 1;
          } else {
            state.usageEvents.push({
              day,
              event_type: eventType,
              source_category: sourceCategory,
              action_detail: actionDetail,
              outcome,
              latency_bucket: latencyBucket,
              failure_class: failureClass,
              count: 1,
            });
          }
          return { success: true, meta: { changes: 1 } };
        }
        if (sql.startsWith("DELETE FROM telegram_chat_delivery_diagnostics WHERE chat_id")) {
          const [chatId] = bound as [string];
          return { success: true, meta: { changes: deleteFromChild(state.diagnostics, chatId) } };
        }
        if (sql.startsWith("DELETE FROM telegram_subscriptions WHERE chat_id")) {
          const [chatId] = bound as [string];
          return { success: true, meta: { changes: deleteFromChild(state.subscriptions, chatId) } };
        }
        if (sql.startsWith("DELETE FROM telegram_preset_subscriptions WHERE chat_id")) {
          const [chatId] = bound as [string];
          return { success: true, meta: { changes: deleteFromChild(state.presets, chatId) } };
        }
        if (sql.startsWith("DELETE FROM telegram_pending_alerts WHERE chat_id")) {
          const [chatId] = bound as [string];
          return { success: true, meta: { changes: deleteFromChild(state.pendingAlerts, chatId) } };
        }
        if (sql.startsWith("DELETE FROM telegram_pending_disambiguation WHERE chat_id")) {
          const [chatId] = bound as [string];
          return { success: true, meta: { changes: deleteFromChild(state.pendingDisambig, chatId) } };
        }
        if (sql.startsWith("DELETE FROM telegram_subscribers WHERE chat_id")) {
          const [chatId] = bound as [string];
          let removed = 0;
          for (let i = state.subscribers.length - 1; i >= 0; i--) {
            if (state.subscribers[i].chat_id === chatId) {
              state.subscribers.splice(i, 1);
              removed += 1;
            }
          }
          return { success: true, meta: { changes: removed } };
        }
        return { success: true, meta: { changes: 0 } };
      },
      first: async () => {
        if (sql.startsWith("SELECT value FROM cache WHERE key = ?")) {
          const [key] = bound as [string];
          const row = state.cache.get(key);
          return row ? { value: row.value } : null;
        }
        if (sql.startsWith("SELECT value, updated_at FROM cache WHERE key = ?")) {
          const [key] = bound as [string];
          const row = state.cache.get(key);
          return row ? { value: row.value, updated_at: row.updated_at } : null;
        }
        return null;
      },
      all: async () => {
        // Warning-candidate query: 170-179 day idle subscribers still tied to
        // active subscriptions or preset rows.
        if (
          sql.includes("SELECT DISTINCT s.chat_id")
          && sql.includes("FROM telegram_subscribers s")
        ) {
          const [warnWindowOlderBound, warnWindowNewerBound, limit] = bound as [number, number, number];
          const hasActive = (chatId: string) =>
            state.subscriptions.some((r) => r.chat_id === chatId)
            || state.presets.some((r) => r.chat_id === chatId);
          const eligible = state.subscribers
            .filter(
              (sub) =>
                sub.last_active_at >= warnWindowOlderBound
                && sub.last_active_at < warnWindowNewerBound
                && hasActive(sub.chat_id),
            )
            .sort((a, b) => a.last_active_at - b.last_active_at)
            .slice(0, limit)
            .map((row) => ({ chat_id: row.chat_id, last_active_at: row.last_active_at }));
          return { results: eligible, success: true, meta: {} };
        }
        if (sql.includes("FROM telegram_subscribers s")) {
          const [cutoffSec, limit] = bound as [number, number];
          const hasChild = (chatId: string) =>
            state.subscriptions.some((r) => r.chat_id === chatId)
            || state.presets.some((r) => r.chat_id === chatId)
            || state.pendingAlerts.some((r) => r.chat_id === chatId)
            || state.pendingDisambig.some((r) => r.chat_id === chatId);
          const eligible = state.subscribers
            .filter((sub) => sub.last_active_at < cutoffSec && !hasChild(sub.chat_id))
            .sort((a, b) => a.last_active_at - b.last_active_at)
            .slice(0, limit)
            .map((row) => ({ chat_id: row.chat_id }));
          return { results: eligible, success: true, meta: {} };
        }
        return { results: [], success: true, meta: {} };
      },
    };
    return stmt as unknown as D1PreparedStatement;
  }

  return {
    prepare,
    batch: async (stmts: D1PreparedStatement[]) => {
      const results: unknown[] = [];
      for (const s of stmts) {
        results.push(await (s as unknown as { run: () => Promise<unknown> }).run());
      }
      return results;
    },
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;
}

function makeState(): StubState {
  return {
    subscribers: [],
    subscriptions: [],
    presets: [],
    pendingAlerts: [],
    pendingDisambig: [],
    diagnostics: [],
    cache: new Map(),
    usageEvents: [],
  };
}

describe("runTelegramInactiveCleanup", () => {
  it("throws before D1 work when the cron signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("inactive cleanup aborted"));
    const db = createStubDb(makeState());
    await expect(runTelegramInactiveCleanup(db, controller.signal)).rejects.toThrow(
      "inactive cleanup aborted",
    );
  });

  it("deletes inactive subscribers with no children and writes the cache guard", async () => {
    const state = makeState();
    const now = Math.floor(Date.now() / 1000);
    state.subscribers.push(
      { chat_id: "stale-1", last_active_at: now - INACTIVE_RETENTION_SEC - 86_400 },
      { chat_id: "stale-2", last_active_at: now - INACTIVE_RETENTION_SEC - 3600 },
    );
    const db = createStubDb(state);

    const result = await runTelegramInactiveCleanup(db);

    expect(result.status).toBe("ok");
    expect(result.itemCount).toBe(2);
    expect(state.subscribers).toHaveLength(0);
    const cached = state.cache.get(CACHE_LAST_RUN_KEY);
    expect(cached).toBeTruthy();
    const metadata = JSON.parse(result.metadata!) as {
      cutoffSec: number;
      deleted: number;
      cappedAtLimit: boolean;
    };
    expect(metadata.deleted).toBe(2);
    expect(metadata.cappedAtLimit).toBe(false);
  });

  it("preserves recently-active subscribers and chats with any child rows", async () => {
    const state = makeState();
    const now = Math.floor(Date.now() / 1000);
    state.subscribers.push(
      { chat_id: "active", last_active_at: now - 3600 },
      { chat_id: "has-sub", last_active_at: now - INACTIVE_RETENTION_SEC - 1 },
      { chat_id: "has-preset", last_active_at: now - INACTIVE_RETENTION_SEC - 1 },
      { chat_id: "has-pending-alert", last_active_at: now - INACTIVE_RETENTION_SEC - 1 },
      { chat_id: "has-pending-disambig", last_active_at: now - INACTIVE_RETENTION_SEC - 1 },
      { chat_id: "eligible", last_active_at: now - INACTIVE_RETENTION_SEC - 1 },
    );
    state.subscriptions.push({ chat_id: "has-sub" });
    state.presets.push({ chat_id: "has-preset" });
    state.pendingAlerts.push({ chat_id: "has-pending-alert" });
    state.pendingDisambig.push({ chat_id: "has-pending-disambig" });
    const db = createStubDb(state);

    const result = await runTelegramInactiveCleanup(db);

    expect(result.itemCount).toBe(1);
    expect(state.subscribers.map((row) => row.chat_id).sort()).toEqual([
      "active",
      "has-pending-alert",
      "has-pending-disambig",
      "has-preset",
      "has-sub",
    ]);
  });

  it("caps deletions at 100 per run and marks cappedAtLimit when reached", async () => {
    const state = makeState();
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 150; i++) {
      state.subscribers.push({
        chat_id: `stale-${i}`,
        last_active_at: now - INACTIVE_RETENTION_SEC - (i + 1),
      });
    }
    const db = createStubDb(state);

    const result = await runTelegramInactiveCleanup(db);

    expect(result.itemCount).toBe(100);
    expect(state.subscribers).toHaveLength(50);
    const metadata = JSON.parse(result.metadata!) as { cappedAtLimit: boolean };
    expect(metadata.cappedAtLimit).toBe(true);
  });

  it("skips real work when the cache guard is still warm", async () => {
    const state = makeState();
    const now = Math.floor(Date.now() / 1000);
    state.cache.set(CACHE_LAST_RUN_KEY, {
      value: String(now - 86_400), // ran 1 day ago — under the 7-day interval
      updated_at: now - 86_400,
    });
    state.subscribers.push({
      chat_id: "stale-1",
      last_active_at: now - INACTIVE_RETENTION_SEC - 1,
    });
    const db = createStubDb(state);

    const result = await runTelegramInactiveCleanup(db);

    expect(result.itemCount).toBe(0);
    expect(state.subscribers).toHaveLength(1);
    const metadata = JSON.parse(result.metadata!) as { skipped: string };
    expect(metadata.skipped).toBe("cache-guard");
  });

  it("runs again after the 7-day interval elapses", async () => {
    const state = makeState();
    const now = Math.floor(Date.now() / 1000);
    state.cache.set(CACHE_LAST_RUN_KEY, {
      value: String(now - RUN_INTERVAL_SEC - 60), // ran just over a week ago
      updated_at: now - RUN_INTERVAL_SEC - 60,
    });
    state.subscribers.push({
      chat_id: "stale-1",
      last_active_at: now - INACTIVE_RETENTION_SEC - 1,
    });
    const db = createStubDb(state);

    const result = await runTelegramInactiveCleanup(db);

    expect(result.itemCount).toBe(1);
    expect(state.subscribers).toHaveLength(0);
  });

  it("clears telegram_chat_delivery_diagnostics when a chat is purged", async () => {
    const state = makeState();
    const now = Math.floor(Date.now() / 1000);
    state.subscribers.push({
      chat_id: "stale-1",
      last_active_at: now - INACTIVE_RETENTION_SEC - 86_400,
    });
    state.diagnostics.push({ chat_id: "stale-1" });
    state.diagnostics.push({ chat_id: "active" }); // unrelated row must survive
    const db = createStubDb(state);

    const result = await runTelegramInactiveCleanup(db);

    expect(result.itemCount).toBe(1);
    expect(state.subscribers).toHaveLength(0);
    expect(state.diagnostics.map((row) => row.chat_id)).toEqual(["active"]);
  });

  it("dispatches a warn-pass nudge and emits a re_engagement_warning event", async () => {
    const state = makeState();
    const now = Math.floor(Date.now() / 1000);
    // Subscriber sits inside the 170-179 day warn window AND still has an
    // active subscription so it is eligible for the nudge but not yet for
    // deletion.
    state.subscribers.push({
      chat_id: "warn-1",
      last_active_at: now - WARN_WINDOW_START_SEC - ONE_DAY_SEC * 5,
    });
    state.subscriptions.push({ chat_id: "warn-1" });
    const db = createStubDb(state);

    const result = await runTelegramInactiveCleanup(db, undefined, "bot-token-123");

    expect(result.status).toBe("ok");
    // The subscriber row must NOT be deleted in this run: it is in the warn
    // window, not past the 180-day inactivity cutoff.
    expect(state.subscribers).toHaveLength(1);
    expect(state.subscribers[0]?.chat_id).toBe("warn-1");

    // A nudge was dispatched to the eligible chat.
    expect(sendToChatCalls).toHaveLength(1);
    expect(sendToChatCalls[0]?.chatId).toBe("warn-1");
    expect(sendToChatCalls[0]?.botToken).toBe("bot-token-123");

    // The 30-day warn marker was persisted for this chat.
    const warnMarker = state.cache.get(`${WARN_CACHE_KEY_PREFIX}warn-1`);
    expect(warnMarker).toBeTruthy();

    // A re_engagement_warning usage event was recorded with outcome=sent.
    const warningEvents = state.usageEvents.filter(
      (row) => row.event_type === "re_engagement_warning",
    );
    expect(warningEvents).toHaveLength(1);
    expect(warningEvents[0]?.outcome).toBe("sent");

    // Metadata exposes the warning-pass summary, including the cap flag.
    const metadata = JSON.parse(result.metadata!) as {
      warningPass?: { attempted: number; warned: number; cappedAtLimit: boolean };
    };
    expect(metadata.warningPass?.attempted).toBe(1);
    expect(metadata.warningPass?.warned).toBe(1);
    expect(metadata.warningPass?.cappedAtLimit).toBe(false);
  });

  it("skips the warning pass entirely when botToken is not provided", async () => {
    const state = makeState();
    const now = Math.floor(Date.now() / 1000);
    state.subscribers.push({
      chat_id: "warn-1",
      last_active_at: now - WARN_WINDOW_START_SEC - ONE_DAY_SEC * 5,
    });
    state.subscriptions.push({ chat_id: "warn-1" });
    const db = createStubDb(state);

    const result = await runTelegramInactiveCleanup(db);

    expect(sendToChatCalls).toHaveLength(0);
    expect(state.usageEvents).toHaveLength(0);
    const metadata = JSON.parse(result.metadata!) as {
      warningPass?: unknown;
    };
    expect(metadata.warningPass).toBeUndefined();
  });
});
