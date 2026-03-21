import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal("fetch", fetchSpy);

const { postDigestToTelegram, sendToChat, sendBatch } = await import("../telegram");

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
      "Telegram API 403: Forbidden",
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

  it("passes disable_notification when set", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await sendToChat("12345", "test", "bot-token", { disableNotification: true });
    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.disable_notification).toBe(true);
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
});
