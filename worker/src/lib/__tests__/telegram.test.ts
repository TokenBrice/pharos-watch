import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal("fetch", fetchSpy);

const { buildTelegramMessage, postDigestToTelegram, sendToChat, sendBatch } = await import("../telegram");

const digestCreds = {
  botToken: "bot-token",
  chatId: "12345",
};

beforeEach(() => {
  fetchSpy.mockReset();
});

describe("sendToChat", () => {
  it("drains the success response body for digest sends", async () => {
    const response = new Response(JSON.stringify({ ok: true }), { status: 200 });
    fetchSpy.mockResolvedValueOnce(response);

    await postDigestToTelegram("Daily Digest", "PSI held steady.", "2026-03-21", digestCreds);

    expect(response.bodyUsed).toBe(true);
  });

  it("drains the error response body for digest sends", async () => {
    const response = new Response("Forbidden", { status: 403 });
    fetchSpy.mockResolvedValueOnce(response);

    await expect(postDigestToTelegram("Daily Digest", "PSI held steady.", "2026-03-21", digestCreds)).rejects.toThrow(
      "Telegram API 403:",
    );
    expect(response.bodyUsed).toBe(true);
  });

  it("sends HTML message and returns ok", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const result = await sendToChat("12345", "<b>Test</b>", "bot-token");
    expect(result).toMatchObject({
      ok: true,
      blocked: false,
      retryable: false,
      permanentFailure: false,
      statusCode: 200,
      delivery: "sent",
    });
    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.chat_id).toBe("12345");
    expect(body.parse_mode).toBe("HTML");
  });

  it("builds Telegram digest links with a trailing slash", () => {
    const body = buildTelegramMessage("Daily Digest", "PSI held steady.", "2026-03-21", null);
    expect(body).toContain(`<a href="https://pharos.watch/digest/2026-03-21/">Read on Pharos →</a>`);
  });

  it("builds weekly Telegram digest links with a trailing slash", () => {
    const body = buildTelegramMessage("Weekly Recap", "PSI held steady.", "2026-03-21-weekly", 1);
    expect(body).toContain(`<a href="https://pharos.watch/digest/2026-03-21-weekly/">Read on Pharos →</a>`);
  });

  it("returns blocked: true on 403", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("Forbidden", { status: 403 }));
    const result = await sendToChat("12345", "test", "bot-token");
    expect(result).toMatchObject({
      ok: false,
      blocked: true,
      retryable: false,
      permanentFailure: true,
      statusCode: 403,
      delivery: "blocked",
    });
  });

  it("returns retryable failure metadata on non-403 error", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("Server Error", { status: 500 }));
    const result = await sendToChat("12345", "test", "bot-token");
    expect(result).toMatchObject({
      ok: false,
      blocked: false,
      retryable: true,
      permanentFailure: false,
      statusCode: 500,
      errorClass: "server_error",
      delivery: "retryable_failure",
    });
  });

  it("passes disable_web_page_preview when set", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await sendToChat("12345", "test", "bot-token", { disableWebPagePreview: true });
    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.disable_web_page_preview).toBe(true);
  });

  it("passes link_preview_options when provided", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await sendToChat("12345", "test", "bot-token", {
      linkPreviewOptions: { is_disabled: false, prefer_small_media: true, show_above_text: false },
    });
    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.link_preview_options).toEqual({
      is_disabled: false,
      prefer_small_media: true,
      show_above_text: false,
    });
    expect(body.disable_web_page_preview).toBeUndefined();
  });

  it("prefers link_preview_options over disable_web_page_preview when both are set", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await sendToChat("12345", "test", "bot-token", {
      disableWebPagePreview: true,
      linkPreviewOptions: { is_disabled: false, prefer_small_media: true },
    });
    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.link_preview_options).toEqual({ is_disabled: false, prefer_small_media: true });
    expect(body.disable_web_page_preview).toBeUndefined();
  });

  it("passes disable_notification when set", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await sendToChat("12345", "test", "bot-token", { disableNotification: true });
    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.disable_notification).toBe(true);
  });

  it("passes caller abort signal through chat sends", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const controller = new AbortController();

    await sendToChat("12345", "test", "bot-token", { signal: controller.signal });

    expect(fetchSpy.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("treats ambiguous long retry-after 429s as global", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("Too Many Requests", {
        status: 429,
        headers: { "Retry-After": "30" },
      }),
    );
    const result = await sendToChat("12345", "test", "bot-token");
    expect(result).toMatchObject({
      ok: false,
      blocked: false,
      retryable: true,
      permanentFailure: false,
      statusCode: 429,
      errorClass: "rate_limit",
      delivery: "retryable_failure",
      rateLimitScope: "global",
    });
    expect(result.retryAfterSec).toBe(30);
  });

  it("returns retryAfterSec null when 429 has no Retry-After header", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("Too Many Requests", { status: 429 }));
    const result = await sendToChat("12345", "test", "bot-token");
    expect(result.retryAfterSec).toBeNull();
  });

  it("uses Telegram JSON retry_after when the Retry-After header is absent", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: false,
          error_code: 429,
          description: "Too Many Requests: retry after 12",
          parameters: { retry_after: 12 },
        }),
        { status: 429 },
      ),
    );

    const result = await sendToChat("12345", "test", "bot-token");

    expect(result.retryAfterSec).toBe(12);
    expect(result.rateLimitScope).toBe("chat");
  });

  it("classifies explicit bot-wide Telegram rate limits as global", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: false,
          error_code: 429,
          description: "Too Many Requests: bot-wide retry after 38",
          parameters: { retry_after: 38 },
        }),
        { status: 429 },
      ),
    );

    const result = await sendToChat("12345", "test", "bot-token");

    expect(result.retryAfterSec).toBe(38);
    expect(result.rateLimitScope).toBe("global");
  });

  it("returns retryAfterSec null for non-429 errors", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("Server Error", { status: 500 }));
    const result = await sendToChat("12345", "test", "bot-token");
    expect(result.retryAfterSec).toBeNull();
  });

  it("classifies timeout as retryable", async () => {
    fetchSpy.mockRejectedValueOnce(Object.assign(new Error("timeout"), { name: "TimeoutError" }));
    const result = await sendToChat("12345", "test", "bot-token");
    expect(result).toMatchObject({
      ok: false,
      retryable: true,
      errorClass: "timeout",
      retryAfterSec: null,
    });
  });
});

describe("sendBatch", () => {
  beforeEach(() => {
    fetchSpy.mockReset();
  });

  it("sends messages in parallel batches of the given size", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const messages = Array.from({ length: 7 }, (_, i) => ({
      chatId: `chat-${i}`,
      html: `<b>Alert ${i}</b>`,
      disableNotification: false,
    }));

    const results = await sendBatch(messages, "bot-token", 3);

    expect(results).toHaveLength(7);
    expect(results.every((r) => r.ok)).toBe(true);
    // 3 batches: [0,1,2], [3,4,5], [6]
    expect(fetchSpy).toHaveBeenCalledTimes(7);
  });

  it("sends same-chat chunks serially in ordinal order while other chats use bounded concurrency", async () => {
    const started: string[] = [];
    const completed: string[] = [];
    const releases = new Map<string, () => void>();
    let active = 0;
    let maxActive = 0;
    let sameChatActive = 0;
    let maxSameChatActive = 0;

    fetchSpy.mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { chat_id: string; text: string };
      const key = `${body.chat_id}:${body.text}`;
      started.push(key);
      active++;
      maxActive = Math.max(maxActive, active);
      if (body.chat_id === "same-chat") {
        sameChatActive++;
        maxSameChatActive = Math.max(maxSameChatActive, sameChatActive);
      }
      return new Promise<Response>((resolve) => {
        releases.set(key, () => {
          completed.push(key);
          active--;
          if (body.chat_id === "same-chat") sameChatActive--;
          resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
        });
      });
    });

    const messages = [
      ...Array.from({ length: 4 }, (_, index) => ({
        chatId: "same-chat",
        html: `chunk-${index}`,
        disableNotification: false,
        chunkIndex: index,
      })),
      ...["other-a", "other-b", "other-c", "other-d"].map((chatId) => ({
        chatId,
        html: "only-chunk",
        disableNotification: false,
      })),
    ];

    const sendPromise = sendBatch(messages, "bot-token", 4);
    await vi.waitFor(() => expect(started).toHaveLength(4));
    expect(started).toEqual([
      "same-chat:chunk-0",
      "other-a:only-chunk",
      "other-b:only-chunk",
      "other-c:only-chunk",
    ]);

    releases.get("other-a:only-chunk")?.();
    releases.get("other-b:only-chunk")?.();
    releases.get("other-c:only-chunk")?.();
    await Promise.resolve();
    expect(started).toHaveLength(4);

    releases.get("same-chat:chunk-0")?.();
    await vi.waitFor(() => expect(started).toHaveLength(6));
    expect(started.slice(4)).toEqual(["other-d:only-chunk", "same-chat:chunk-1"]);
    releases.get("other-d:only-chunk")?.();
    releases.get("same-chat:chunk-1")?.();
    await vi.waitFor(() => expect(started).toContain("same-chat:chunk-2"));
    releases.get("same-chat:chunk-2")?.();
    await vi.waitFor(() => expect(started).toContain("same-chat:chunk-3"));
    releases.get("same-chat:chunk-3")?.();

    const results = await sendPromise;
    expect(results).toHaveLength(messages.length);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(started.filter((key) => key.startsWith("same-chat:"))).toEqual([
      "same-chat:chunk-0",
      "same-chat:chunk-1",
      "same-chat:chunk-2",
      "same-chat:chunk-3",
    ]);
    expect(completed.filter((key) => key.startsWith("same-chat:"))).toEqual([
      "same-chat:chunk-0",
      "same-chat:chunk-1",
      "same-chat:chunk-2",
      "same-chat:chunk-3",
    ]);
    expect(maxActive).toBe(4);
    expect(maxSameChatActive).toBe(1);
  });

  it("reports blocked chats without throwing", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response("Forbidden", { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const messages = [
      { chatId: "a", html: "hi", disableNotification: false },
      { chatId: "b", html: "hi", disableNotification: false },
      { chatId: "c", html: "hi", disableNotification: false },
    ];

    const results = await sendBatch(messages, "bot-token", 3);
    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({ chatId: "a", ok: true, blocked: false, delivery: "sent" });
    expect(results[1]).toMatchObject({ chatId: "b", ok: false, blocked: true, delivery: "blocked" });
    expect(results[2]).toMatchObject({ chatId: "c", ok: true, blocked: false, delivery: "sent" });
  });

  it("keeps sending later batches after a chat-scoped rate limit", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response("Too Many Requests: chat retry after 45", {
          status: 429,
          headers: { "Retry-After": "45" },
        }),
      )
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const messages = Array.from({ length: 8 }, (_, index) => ({
      chatId: `chat-${index}`,
      html: `<b>Alert ${index}</b>`,
      disableNotification: false,
    }));

    const results = await sendBatch(messages, "bot-token", 5);

    expect(fetchSpy).toHaveBeenCalledTimes(8);
    expect(results).toHaveLength(8);
    expect(results.slice(0, 4).every((result) => result.ok)).toBe(true);
    expect(results[4]).toMatchObject({
      chatId: "chat-4",
      ok: false,
      retryable: true,
      errorClass: "rate_limit",
      retryAfterSec: 45,
      rateLimitScope: "chat",
    });
    expect(results.slice(5).every((result) => result.ok)).toBe(true);
  });

  it("does not launch later same-chat chunks after the first chunk is rate-limited", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response("Too Many Requests: chat retry after 45", {
          status: 429,
          headers: { "Retry-After": "45" },
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const messages = [
      { chatId: "same-chat", html: "<b>Alert 1</b>", disableNotification: false },
      { chatId: "same-chat", html: "<b>Alert 2</b>", disableNotification: false },
      { chatId: "same-chat", html: "<b>Alert 3</b>", disableNotification: false },
      { chatId: "same-chat", html: "<b>Alert 4</b>", disableNotification: false },
      { chatId: "other-chat", html: "<b>Other alert</b>", disableNotification: false },
    ];

    const results = await sendBatch(messages, "bot-token", 4);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(5);
    expect(results[0]).toMatchObject({
      chatId: "same-chat",
      errorClass: "rate_limit",
      retryAfterSec: 45,
      rateLimitScope: "chat",
      attempted: true,
    });
    expect(results.slice(1, 4).every((result) =>
      result.chatId === "same-chat" &&
      result.errorClass === "rate_limit" &&
      result.retryAfterSec === 45 &&
      result.rateLimitScope === "chat" &&
      result.attempted === false &&
      result.skippedReason === "predecessor_failure"
    )).toBe(true);
    expect(results[4].ok).toBe(true);
  });

  it.each([
    { status: 500, errorClass: "server_error", delivery: "retryable_failure" },
    { status: 400, errorClass: "bad_request", delivery: "permanent_failure" },
    { status: 403, errorClass: "blocked", delivery: "blocked" },
  ])("classifies an unattempted same-chat tail from a $status predecessor", async ({
    status,
    errorClass,
    delivery,
  }) => {
    fetchSpy
      .mockResolvedValueOnce(new Response("failed", { status }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const results = await sendBatch([
      { chatId: "same-chat", html: "chunk-0", disableNotification: false },
      { chatId: "same-chat", html: "chunk-1", disableNotification: false },
      { chatId: "same-chat", html: "chunk-2", disableNotification: false },
      { chatId: "other-chat", html: "other", disableNotification: false },
    ], "bot-token", 4);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(results[0]).toMatchObject({ statusCode: status, errorClass, delivery, attempted: true });
    expect(results.slice(1, 3).every((result) =>
      result.statusCode === status &&
      result.errorClass === errorClass &&
      result.delivery === delivery &&
      result.attempted === false &&
      result.skippedReason === "predecessor_failure"
    )).toBe(true);
    expect(results[3]).toMatchObject({ ok: true, attempted: true });
  });

  it("escalates repeated 429s across distinct chats to global backoff", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response("Too Many Requests: chat retry after 10", {
          status: 429,
          headers: { "Retry-After": "10" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("Too Many Requests: chat retry after 10", {
          status: 429,
          headers: { "Retry-After": "10" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("Too Many Requests: chat retry after 10", {
          status: 429,
          headers: { "Retry-After": "10" },
        }),
      )
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const messages = Array.from({ length: 5 }, (_, index) => ({
      chatId: `chat-${index}`,
      html: `<b>Alert ${index}</b>`,
      disableNotification: false,
    }));

    const results = await sendBatch(messages, "bot-token", 3);

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(results).toHaveLength(5);
    expect(results.slice(0, 3).every((result) => result.rateLimitScope === "global" && result.attempted === true)).toBe(true);
    expect(results.slice(3).every((result) => result.rateLimitScope === "global" && result.attempted === false)).toBe(true);
  });

  it("stops later batches after an ambiguous long Telegram JSON retry_after", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: false,
            error_code: 429,
            description: "Too Many Requests: retry after 38",
            parameters: { retry_after: 38 },
          }),
          { status: 429 },
        ),
      )
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const messages = Array.from({ length: 5 }, (_, index) => ({
      chatId: `chat-${index}`,
      html: `<b>Alert ${index}</b>`,
      disableNotification: false,
    }));

    const results = await sendBatch(messages, "bot-token", 2);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(5);
    expect(results[0]).toMatchObject({
      chatId: "chat-0",
      errorClass: "rate_limit",
      retryAfterSec: 38,
      rateLimitScope: "global",
      attempted: true,
    });
    expect(results[1]).toMatchObject({ ok: true, attempted: true });
    expect(results.slice(2).every((result) => result.rateLimitScope === "global" && result.attempted === false)).toBe(true);
  });

  it("marks the untouched tail as global retryable after a global rate limit stop", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ description: "Too Many Requests: global retry after 45" }), {
          status: 429,
          headers: { "Retry-After": "45" },
        }),
      );

    const messages = Array.from({ length: 5 }, (_, index) => ({
      chatId: `chat-${index}`,
      html: `<b>Alert ${index}</b>`,
      disableNotification: false,
    }));

    const results = await sendBatch(messages, "bot-token", 2);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(5);
    expect(results[0]).toMatchObject({ ok: true, attempted: true });
    expect(results[1]).toMatchObject({
      chatId: "chat-1",
      ok: false,
      retryable: true,
      errorClass: "rate_limit",
      retryAfterSec: 45,
      rateLimitScope: "global",
      attempted: true,
    });
    expect(results.slice(2).every((result) => result.errorClass === "rate_limit" && result.rateLimitScope === "global" && result.attempted === false)).toBe(true);
  });

  it("catches transient errors without crashing the batch", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const messages = [
      { chatId: "a", html: "hi", disableNotification: false },
      { chatId: "b", html: "hi", disableNotification: false },
      { chatId: "c", html: "hi", disableNotification: false },
    ];

    const results = await sendBatch(messages, "bot-token", 3);
    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({ chatId: "a", ok: true, blocked: false, delivery: "sent" });
    expect(results[1]).toMatchObject({
      chatId: "b",
      ok: false,
      blocked: false,
      retryable: true,
      delivery: "retryable_failure",
    });
    expect(results[2]).toMatchObject({ chatId: "c", ok: true, blocked: false, delivery: "sent" });
  });

  it("returns empty array for empty input", async () => {
    const results = await sendBatch([], "bot-token", 5);
    expect(results).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forwards per-message linkPreviewOptions instead of the default disable flag", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const messages = [
      {
        chatId: "single-coin",
        html: "<b>USDC</b> alert",
        disableNotification: false,
        linkPreviewOptions: { is_disabled: false, prefer_small_media: true, show_above_text: false },
      },
      {
        chatId: "multi-coin",
        html: "<b>USDC</b> + <b>USDT</b>",
        disableNotification: false,
      },
    ];

    await sendBatch(messages, "bot-token", 2);

    const firstBody = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(firstBody.link_preview_options).toEqual({
      is_disabled: false,
      prefer_small_media: true,
      show_above_text: false,
    });
    expect(firstBody.disable_web_page_preview).toBeUndefined();

    const secondBody = JSON.parse(fetchSpy.mock.calls[1][1]!.body as string);
    expect(secondBody.disable_web_page_preview).toBe(true);
    expect(secondBody.link_preview_options).toBeUndefined();
  });

  it("marks all messages retryable without fetching when the batch signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const results = await sendBatch([
      { chatId: "a", html: "hi", disableNotification: false },
      { chatId: "b", html: "hi", disableNotification: false },
    ], "bot-token", 2, controller.signal);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.retryable && result.errorClass === "timeout")).toBe(true);
  });

  it("marks the untouched tail retryable when the soft deadline has elapsed", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const results = await sendBatch([
      { chatId: "a", html: "hi", disableNotification: false },
      { chatId: "b", html: "hi", disableNotification: false },
    ], "bot-token", 2, undefined, { softDeadlineAtMs: Date.now() - 1 });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(results).toHaveLength(2);
    expect(results.every((result) =>
      result.retryable &&
      result.errorClass === "timeout" &&
      result.attempted === false
    )).toBe(true);
  });
});
