// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { RequestFailure, RequestSequence, requestJson, requestJsonWithResponse } from "@/lib/request";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("request lifecycle", () => {
  it("keeps the timeout active while the response body is being consumed", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input, init) => {
        const signal = init?.signal;
        return new Response(
          new ReadableStream({
            start(controller) {
              signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    const pending = requestJson("/slow-body", { timeoutMs: 50 }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(51);

    await expect(pending).resolves.toMatchObject({ kind: "timeout" });
  });

  it("classifies HTTP failures and preserves the consumed error body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"error":"nope"}', { status: 503 })),
    );

    await expect(requestJson("/unavailable")).rejects.toMatchObject({
      kind: "http",
      status: 503,
      bodyText: '{"error":"nope"}',
    });
  });

  it("validates JSON with a schema-like contract", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"ok":"no"}', { status: 200 })),
    );
    const schema = {
      safeParse: () => ({
        success: false as const,
        error: { issues: [{ path: ["ok"], message: "Expected boolean" }] },
      }),
    };

    await expect(requestJsonWithResponse("/schema", { schema })).rejects.toMatchObject({
      kind: "schema",
      message: "Response schema validation failed: ok: Expected boolean",
    });
  });

  it.each(["init", "explicit"] as const)("composes the %s abort signal", async (source) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
          }),
      ),
    );
    const initController = new AbortController();
    const explicitController = new AbortController();
    const pending = requestJson("/composed-signal", {
      init: { signal: initController.signal },
      signal: explicitController.signal,
      timeoutMs: null,
    });

    const controller = source === "init" ? initController : explicitController;
    controller.abort(new DOMException(`${source} aborted`, "AbortError"));

    await expect(pending).rejects.toMatchObject({ kind: "aborted", message: "Request was aborted" });
  });

  it("normalizes non-finite timeouts to 10 seconds", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
          }),
      ),
    );

    const pending = requestJson("/default-timeout", { timeoutMs: Number.POSITIVE_INFINITY });
    const rejection = expect(pending).rejects.toMatchObject({
      kind: "timeout",
      message: "Request timed out after 10000ms",
    });
    await vi.advanceTimersByTimeAsync(10_000);

    await rejection;
  });

  it("rejects a late result when a newer request supersedes it", async () => {
    const sequence = new RequestSequence();
    let resolveFirst: ((value: string) => void) | undefined;
    const first = sequence.run(
      () =>
        new Promise<string>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const second = sequence.run(async () => "second");

    resolveFirst?.("first");

    await expect(second).resolves.toBe("second");
    await expect(first).rejects.toBeInstanceOf(RequestFailure);
  });
});
