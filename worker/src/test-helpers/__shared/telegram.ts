import { vi, type Mock } from "vitest";

type FetchSpyLike = {
  mock: {
    calls: unknown[][];
  };
};

export type TelegramFetchSpy = Mock<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>;

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
