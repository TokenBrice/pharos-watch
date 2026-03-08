import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal("fetch", fetchSpy);

const { sendToChat } = await import("../telegram");

beforeEach(() => {
  fetchSpy.mockReset();
});

describe("sendToChat", () => {
  it("sends HTML message and returns ok", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const result = await sendToChat("12345", "<b>Test</b>", "bot-token");
    expect(result).toEqual({ ok: true, blocked: false });
    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.chat_id).toBe("12345");
    expect(body.parse_mode).toBe("HTML");
  });

  it("returns blocked: true on 403", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("Forbidden", { status: 403 }));
    const result = await sendToChat("12345", "test", "bot-token");
    expect(result).toEqual({ ok: false, blocked: true });
  });

  it("throws on non-403 error", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("Server Error", { status: 500 }));
    await expect(sendToChat("12345", "test", "bot-token")).rejects.toThrow("Telegram API 500");
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
