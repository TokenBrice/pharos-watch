import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { apiFetch, apiFetchWithMeta } from "../api";
import { requestJson } from "../request";
import { postMiniAppJson } from "@/app/pharoswatchbot/app/mini-app-api";

const abortSignalAnyDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, "any")!;

function delayedBody(status = 200, delayMs = 80) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    const signal = init?.signal;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        const abort = () => {
          clearTimeout(timer);
          controller.error(signal?.reason);
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", abort);
          controller.enqueue(new TextEncoder().encode('{"ok":true}'));
          controller.close();
        }, delayMs);
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      },
    }), { status });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  Object.defineProperty(AbortSignal, "any", abortSignalAnyDescriptor);
});

describe("body-scoped frontend requests", () => {
  it.each([200, 503])("keeps the API timeout active while reading status %i bodies", async (status) => {
    vi.useFakeTimers();
    delayedBody(status);
    const pending = apiFetch("/api/test", undefined, undefined, undefined, { timeoutMs: 10 });
    const rejection = expect(pending).rejects.toMatchObject({
      name: "TimeoutError", message: "API request timed out after 10ms",
    });
    await vi.advanceTimersByTimeAsync(10);
    await rejection;
  });

  it("covers metadata response bodies with the same budget", async () => {
    vi.useFakeTimers();
    delayedBody();
    const rejection = expect(apiFetchWithMeta("/api/test", undefined, undefined, undefined, {
      timeoutMs: 10,
    })).rejects.toBeInstanceOf(DOMException);
    await vi.advanceTimersByTimeAsync(10);
    await rejection;
  });

  it.each(["native", "fallback"])("propagates parent cancellation after headers using %s signal merging", async (merger) => {
    vi.useFakeTimers();
    if (merger === "fallback") Object.defineProperty(AbortSignal, "any", { configurable: true, value: undefined });
    delayedBody();
    const parent = new AbortController();
    const reason = new DOMException("query cancelled", "AbortError");
    const pending = apiFetch("/api/test", undefined, undefined, undefined, { signal: parent.signal });
    const rejection = expect(pending).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(1);
    parent.abort(reason);
    await rejection;
  });

  it.each(["init", "explicit"])("keeps bespoke requests composed with the %s signal after headers", async (source) => {
    vi.useFakeTimers();
    delayedBody();
    const init = new AbortController();
    const explicit = new AbortController();
    const rejection = expect(requestJson("/api/test", {
      init: { signal: init.signal }, signal: explicit.signal,
    })).rejects.toMatchObject({ kind: "aborted" });
    await vi.advanceTimersByTimeAsync(1);
    (source === "init" ? init : explicit).abort();
    await rejection;
  });

  it.each([200, 503])("keeps Mini App status %i body reads inside the API deadline", async (status) => {
    vi.useFakeTimers();
    delayedBody(status, 20_000);
    const rejection = expect(postMiniAppJson("/api/telegram-mini-app/session", {}, z.object({
      ok: z.boolean(),
    }))).rejects.toMatchObject({ name: "TimeoutError", message: "API request timed out after 10000ms" });
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
  });

  it("preserves ordinary API and Mini App JSON", async () => {
    vi.useFakeTimers();
    delayedBody();
    const schema = z.object({ ok: z.boolean() });
    const api = apiFetch("/api/test", schema);
    await vi.advanceTimersByTimeAsync(80);
    expect(await api).toEqual({ ok: true });
    const miniApp = postMiniAppJson("/api/telegram-mini-app/session", {}, schema);
    await vi.advanceTimersByTimeAsync(80);
    expect(await miniApp).toEqual({ ok: true });
  });
});
