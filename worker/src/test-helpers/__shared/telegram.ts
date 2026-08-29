import { onTestFinished, vi, type Mock } from "vitest";
import {
  mockD1,
  type MockD1Database,
  type MockD1Options,
  type MockTableConfig,
} from "@shared/test-utils/mock-d1";

export interface TelegramSubscriberFixture extends Record<string, unknown> {
  chat_id?: string;
  username?: string | null;
}

export interface TelegramSubscriptionFixture extends Record<string, unknown> {
  chat_id?: string;
  stablecoin_id: string;
}

export interface TelegramPendingOperationFixture extends Record<string, unknown> {
  action_type: string;
  action_payload: string;
  expires_at: number;
  initiator_user_id: string | null;
}

type TelegramWriteOperation = "insert" | "update" | "delete";
type TelegramWriteTarget = "subscriber" | "subscription" | "pendingOperation";

export type TelegramWriteResultOverrides = Partial<
  Record<TelegramWriteTarget, Partial<Record<TelegramWriteOperation, number>>>
>;

export interface MockTelegramD1Options extends MockD1Options {
  /** Suite-wide fallbacks that are not scenario expectations. */
  fallbackTables?: MockTableConfig[];
  subscriber?: TelegramSubscriberFixture | null;
  subscriptions?: TelegramSubscriptionFixture[];
  pendingOperation?: TelegramPendingOperationFixture | null;
  writeResults?: TelegramWriteResultOverrides;
}

export interface TelegramWriteExpectation {
  sql: string;
  binds?: unknown[];
  exactBinds?: boolean;
}

export interface TelegramWriteHistoryEntry {
  sql: string;
  binds: unknown[];
}

const TELEGRAM_WRITE_MATCHES: Record<
  TelegramWriteTarget,
  Record<TelegramWriteOperation, string>
> = {
  subscriber: {
    insert: "INSERT INTO telegram_subscribers",
    update: "UPDATE telegram_subscribers",
    delete: "DELETE FROM telegram_subscribers",
  },
  subscription: {
    insert: "INSERT INTO telegram_subscriptions",
    update: "UPDATE telegram_subscriptions",
    delete: "DELETE FROM telegram_subscriptions",
  },
  pendingOperation: {
    insert: "INSERT INTO telegram_pending_disambiguation",
    update: "UPDATE telegram_pending_disambiguation",
    delete: "DELETE FROM telegram_pending_disambiguation",
  },
};

const TELEGRAM_WRITE_DEFAULTS: MockTableConfig[] = [
  { match: "INSERT INTO telegram_", rows: [] },
  { match: "INSERT OR IGNORE INTO telegram_", rows: [] },
  { match: "INSERT OR REPLACE INTO telegram_", rows: [] },
  { match: "UPDATE telegram_", rows: [] },
  { match: "UPDATE OR IGNORE telegram_", rows: [] },
  { match: "DELETE FROM telegram_", rows: [] },
  { match: "INSERT INTO cache", rows: [] },
  { match: "INSERT OR REPLACE INTO cache", rows: [] },
  { match: "UPDATE cache", rows: [] },
  { match: "DELETE FROM cache", rows: [] },
];

function tableWasUsed(table: MockTableConfig, history: TelegramWriteHistoryEntry[]): boolean {
  return history.some((entry) =>
    entry.sql.includes(table.match)
    && (table.matchBinds == null || JSON.stringify(entry.binds) === JSON.stringify(table.matchBinds)),
  );
}

/**
 * Strict Telegram D1 fixture with typed core reads and successful write defaults.
 * Explicit table matches win over fixtures, which win over the shared defaults.
 */
export function mockTelegramD1(
  tables: MockTableConfig[] = [],
  options: MockTelegramD1Options = {},
): MockD1Database {
  const subscriberConfigured = Object.prototype.hasOwnProperty.call(options, "subscriber");
  const subscriptionsConfigured = Object.prototype.hasOwnProperty.call(options, "subscriptions");
  const pendingOperationConfigured = Object.prototype.hasOwnProperty.call(options, "pendingOperation");
  const {
    subscriber = null,
    subscriptions = [],
    pendingOperation = null,
    writeResults = {},
    fallbackTables = [],
    ...mockOptions
  } = options;
  const configuredMatches: MockTableConfig[] = [...tables];
  const fixtureMatches: MockTableConfig[] = [
    {
      match: "FROM telegram_subscribers",
      rows: subscriber == null ? [] : [subscriber],
      first: subscriber,
    },
    { match: "FROM telegram_subscriptions", rows: subscriptions },
    {
      match: "FROM telegram_pending_disambiguation",
      rows: pendingOperation == null ? [] : [pendingOperation],
      first: pendingOperation,
    },
    { match: "FROM telegram_preset_subscriptions", rows: [] },
    { match: "FROM telegram_pending_alerts", rows: [], first: null },
    { match: "FROM telegram_recap_preferences", rows: [], first: null },
    { match: "FROM telegram_recap_targets", rows: [] },
    { match: "FROM price_cache", rows: [], first: null },
    { match: "FROM dex_liquidity", rows: [], first: null },
    { match: "FROM yield_data", rows: [], first: null },
    { match: "stress_signals", rows: [], first: null },
    { match: "FROM depeg_events", rows: [], first: null },
    { match: "FROM cache", rows: [], first: null },
  ];

  for (const target of Object.keys(writeResults) as TelegramWriteTarget[]) {
    const targetResults = writeResults[target];
    if (!targetResults) continue;
    for (const operation of Object.keys(targetResults) as TelegramWriteOperation[]) {
      const changes = targetResults[operation];
      if (changes == null) continue;
      const table = {
        match: TELEGRAM_WRITE_MATCHES[target][operation],
        rows: [],
        runMeta: { changes },
      };
      configuredMatches.push(table);
    }
  }

  const db = mockD1(
    [...configuredMatches, ...fixtureMatches, ...fallbackTables, ...TELEGRAM_WRITE_DEFAULTS],
    mockOptions,
  );
  db.assertAllMatchesUsed = () => {
    const history = db.getHistory();
    const requiredMatches = [
      ...configuredMatches,
      ...(subscriberConfigured ? fixtureMatches.slice(0, 1) : []),
      ...(subscriptionsConfigured ? fixtureMatches.slice(1, 2) : []),
      ...(pendingOperationConfigured ? fixtureMatches.slice(2, 3) : []),
    ];
    const unused = requiredMatches.filter((table) => !tableWasUsed(table, history));
    if (unused.length > 0) {
      throw new Error(`mockTelegramD1: unused configured match(es): ${unused.map((table) => table.match).join(", ")}`);
    }
  };
  onTestFinished(() => db.assertAllMatchesUsed());
  return db;
}

export function assertTelegramWrite(
  db: Pick<MockD1Database, "getHistory">,
  expected: TelegramWriteExpectation,
): TelegramWriteHistoryEntry {
  const entry = db.getHistory().filter((candidate) =>
    !/^\s*SELECT\b/iu.test(candidate.sql) && candidate.sql.includes(expected.sql),
  ).find((candidate) => {
    if (expected.binds == null) return true;
    if (expected.exactBinds) return JSON.stringify(candidate.binds) === JSON.stringify(expected.binds);
    return expected.binds.every((value) => candidate.binds.includes(value));
  });
  if (!entry) {
    throw new Error(`Expected Telegram write containing ${expected.sql}`);
  }
  return entry;
}

type FetchSpyLike = {
  mock: {
    calls: unknown[][];
  };
};

export type TelegramFetchSpy = Mock<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>;

export type TelegramMembershipUser = {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  [key: string]: unknown;
};

/**
 * The Telegram Bot API transport seam every webhook-side suite installs: a
 * global `fetch` spy that answers `{ ok: true }` unless a test says otherwise.
 *
 * Call `reset()` in `beforeEach` — clearing the spy also restores the default
 * OK response, which is what the hand-rolled copies of this preamble each did.
 */
export function createTelegramFetchSpy(): { fetchSpy: TelegramFetchSpy; reset: () => void } {
  const fetchSpy: TelegramFetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
  vi.stubGlobal("fetch", fetchSpy);
  const reset = (): void => {
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  };
  return { fetchSpy, reset };
}

export function mockTelegramMembership(
  fetchSpy: TelegramFetchSpy,
  status: string,
  user: TelegramMembershipUser = {
    id: 7,
    is_bot: false,
    first_name: status === "administrator" ? "admin" : "member",
  },
): void {
  fetchSpy.mockImplementation(async (url) => {
    if (String(url).includes("getChatMember")) {
      return new Response(JSON.stringify({ ok: true, result: { user, status } }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
}

export function telegramApiCalls(fetchSpy: FetchSpyLike, method: string): unknown[][] {
  return fetchSpy.mock.calls.filter((call) => String(call[0]).includes(method));
}

export function telegramCallBody<T = Record<string, unknown>>(call: unknown[] | undefined): T {
  if (!call) throw new Error("No Telegram API call recorded");
  const init = call[1] as RequestInit | undefined;
  return JSON.parse((init?.body as string | undefined) ?? "{}") as T;
}

export function telegramApiCallBody<T = Record<string, unknown>>(
  fetchSpy: FetchSpyLike,
  method: string,
  options: { last?: boolean } = {},
): T {
  const { last = true } = options;
  const calls = telegramApiCalls(fetchSpy, method);
  const call = last ? calls[calls.length - 1] : calls[0];
  if (!call) throw new Error(`No ${method} call recorded`);
  return telegramCallBody<T>(call);
}

export function lastSendMessageBody<T = Record<string, unknown>>(fetchSpy: FetchSpyLike): T {
  return telegramApiCallBody<T>(fetchSpy, "sendMessage");
}

export function makeTelegramUpdateRequest(
  payload: Record<string, unknown>,
  options: { secret?: string; updateId?: number } = {},
): Request {
  return new Request("https://x/api/telegram-webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": options.secret ?? "test-secret",
    },
    body: JSON.stringify({
      ...(options.updateId != null ? { update_id: options.updateId } : {}),
      ...payload,
    }),
  });
}
