type FetchSpyLike = {
  mock: {
    calls: unknown[][];
  };
};

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
