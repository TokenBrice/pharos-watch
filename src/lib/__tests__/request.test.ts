// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { RequestFailure, RequestSequence, requestJson, requestJsonWithResponse } from "@/lib/request";
import { mockFetch } from "@shared/test-utils/mock-fetch";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("request lifecycle", () => {
  it("keeps the timeout active while the response body is being consumed", async () => {
    vi.useFakeTimers();
    mockFetch([{
      match: "/slow-body",
      respond: (request) => new Response(
          new ReadableStream({
            start(controller) {
              request.signal.addEventListener("abort", () => controller.error(request.signal.reason), { once: true });
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    }], { requireMatch: true });

    const pending = requestJson("/slow-body", { timeoutMs: 50 }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(51);

    await expect(pending).resolves.toMatchObject({ kind: "timeout" });
  });

  it("classifies HTTP failures and preserves the consumed error body", async () => {
    mockFetch([{ match: "/unavailable", body: '{"error":"nope"}', status: 503 }], { requireMatch: true });

    await expect(requestJson("/unavailable")).rejects.toMatchObject({
      kind: "http",
      status: 503,
      bodyText: '{"error":"nope"}',
    });
  });

  it("validates JSON with a schema-like contract", async () => {
    mockFetch([{ match: "/schema", body: '{"ok":"no"}' }], { requireMatch: true });
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
    mockFetch([{
      match: "/composed-signal",
      outcomes: [{ stall: true }],
    }], { requireMatch: true });
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
    mockFetch([{
      match: "/default-timeout",
      outcomes: [{ stall: true }],
    }], { requireMatch: true });

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
