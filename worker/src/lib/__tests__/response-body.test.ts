import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { unstable_dev, unstable_readConfig } from "wrangler";
import type { Unstable_DevWorker } from "wrangler";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelResponseBodyQuietly,
  cancelUnsuccessfulResponseBodyQuietly,
  readResponseSnippetWithTimeout,
  readResponseTextBoundedWithSignal,
  readResponseTextWithinLimitWithSignal,
  readResponseJsonWithinLimitWithSignal,
  readResponseBytesWithinLimitWithSignal,
  readResponseTextWithinLimitWithTimeout,
} from "../response-body";

afterEach(() => vi.useRealTimers());

describe("response body cancellation and byte boundaries", () => {
  it("cancels a stalled strict read with the original parent reason", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
    const controller = new AbortController();
    const reason = new Error("parent cancelled");
    const pending = readResponseTextWithinLimitWithSignal(response, 10, controller.signal);
    const rejected = expect(pending).rejects.toBe(reason);
    controller.abort(reason);
    await rejected;
    expect(cancel).toHaveBeenCalledWith(reason);
  });

  it("does not start reading a pre-aborted stream", async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 }));
    const reason = new Error("already cancelled");
    await expect(readResponseTextWithinLimitWithSignal(response, 10, AbortSignal.abort(reason))).rejects.toBe(reason);
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith(reason);
  });

  it("returns no snippet on timeout but propagates parent cancellation", async () => {
    vi.useFakeTimers();
    const timeoutCancel = vi.fn();
    const options = { timeoutMs: 100, maxBytes: 10, maxChars: 10 };
    const timed = readResponseSnippetWithTimeout(
      new Response(new ReadableStream<Uint8Array>({ cancel: timeoutCancel })), options,
    );
    await vi.advanceTimersByTimeAsync(100);
    await expect(timed).resolves.toBeUndefined();
    expect(timeoutCancel).toHaveBeenCalledWith(expect.objectContaining({ name: "TimeoutError" }));

    const parent = new AbortController();
    const parentCancel = vi.fn();
    const reason = new Error("parent stopped snippet");
    const pending = readResponseSnippetWithTimeout(
      new Response(new ReadableStream<Uint8Array>({ cancel: parentCancel })), options, parent.signal,
    );
    const rejected = expect(pending).rejects.toBe(reason);
    parent.abort(reason);
    await rejected;
    expect(parentCancel).toHaveBeenCalledWith(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("accepts exact UTF-8 byte limits and rejects overflow despite fewer characters", async () => {
    const observe = vi.fn();
    await expect(readResponseTextWithinLimitWithSignal(new Response("éé"), 4, undefined, observe)).resolves.toBe("éé");
    expect(observe).toHaveBeenLastCalledWith({ intakeBytes: 4, declaredBytes: null, outcome: "accepted" });
    await expect(readResponseTextWithinLimitWithSignal(new Response("éé"), 3)).rejects.toMatchObject({
      name: "ResponseBodyTooLargeError", maxBytes: 3, observedBytes: 4,
    });
  });
});


describe("cancelResponseBodyQuietly", () => {
  it("cancels ignored bodies without reading or allocating them", async () => {
    const response = new Response(new ReadableStream<Uint8Array>({ cancel: vi.fn() }));
    const read = vi.spyOn(response, "arrayBuffer");
    await cancelResponseBodyQuietly(response);
    expect(read).not.toHaveBeenCalled();
  });

  it("returns for nullish responses", async () => {
    await expect(cancelResponseBodyQuietly(null)).resolves.toBeUndefined();
    await expect(cancelResponseBodyQuietly(undefined)).resolves.toBeUndefined();
  });

  it("cancels the body when present", async () => {
    const cancel = vi.fn(async () => undefined);
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }));

    await expect(cancelResponseBodyQuietly(response)).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("does not cancel responses whose body has already been consumed", async () => {
    const cancel = vi.fn(async () => undefined);
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.close(); }, cancel,
    }));
    await response.text();

    await expect(cancelResponseBodyQuietly(response)).resolves.toBeUndefined();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("swallows cancellation errors", async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      cancel: vi.fn(async () => { throw new Error("cannot cancel"); }),
    }));

    await expect(cancelResponseBodyQuietly(response)).resolves.toBeUndefined();
  });
});

describe("cancelUnsuccessfulResponseBodyQuietly", () => {
  it("does not cancel successful responses", async () => {
    const cancel = vi.fn(async () => undefined);
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }));

    await expect(cancelUnsuccessfulResponseBodyQuietly(response)).resolves.toBeUndefined();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("cancels non-OK responses", async () => {
    const cancel = vi.fn(async () => undefined);
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 500 });

    await expect(cancelUnsuccessfulResponseBodyQuietly(response)).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe("readResponseTextWithinLimitWithSignal", () => {
  it("accounts zero intake for declared preflight rejection and separates lying headers", async () => {
    const observe = vi.fn();
    await expect(readResponseTextWithinLimitWithSignal(new Response("abcdef", {
      headers: { "Content-Length": "100" },
    }), 5, undefined, observe)).rejects.toMatchObject({ code: "resource-budget-exceeded" });
    expect(observe).toHaveBeenLastCalledWith({ intakeBytes: 0, declaredBytes: 100, outcome: "rejected" });
    await expect(readResponseBytesWithinLimitWithSignal(new Response("abcdef", {
      headers: { "Content-Length": "1" },
    }), 5, undefined, observe)).rejects.toMatchObject({ observedBytes: 6 });
    expect(observe).toHaveBeenLastCalledWith({ intakeBytes: 6, declaredBytes: 1, outcome: "rejected" });
  });

  it("reports intake before JSON decoding and unavailable body-less evidence", async () => {
    const observe = vi.fn();
    await expect(readResponseJsonWithinLimitWithSignal(new Response("{bad"), 4, undefined, observe)).rejects.toBeInstanceOf(SyntaxError);
    expect(observe).toHaveBeenLastCalledWith({ intakeBytes: 4, declaredBytes: null, outcome: "accepted" });
    await expect(readResponseJsonWithinLimitWithSignal(new Response(null), 20, undefined, observe)).rejects.toBeInstanceOf(SyntaxError);
    expect(observe).toHaveBeenLastCalledWith({ intakeBytes: null, declaredBytes: null, outcome: "rejected" });
  });

  it("keeps native null bodies empty with unknown intake across transport modes", async () => {
    const observe = vi.fn();
    await expect(readResponseBytesWithinLimitWithSignal(new Response(null), 0, undefined, observe)).resolves.toEqual(new Uint8Array(0));
    await expect(readResponseTextWithinLimitWithSignal(new Response(null), 0, undefined, observe)).resolves.toBe("");
    expect(observe.mock.calls.map(([evidence]) => evidence)).toEqual([
      { intakeBytes: null, declaredBytes: null, outcome: "accepted" },
      { intakeBytes: null, declaredBytes: null, outcome: "accepted" },
    ]);
    await expect(readResponseTextBoundedWithSignal(new Response(null), 0)).resolves.toBe("");
  });

  it("preserves null-body validation, preflight and pre-abort ordering", async () => {
    const observe = vi.fn();
    const reason = new Error("already aborted");
    const signal = AbortSignal.abort(reason);
    await expect(readResponseTextWithinLimitWithSignal(new Response(null), -1, signal, observe)).rejects.toBeInstanceOf(RangeError);
    expect(observe).not.toHaveBeenCalled();
    await expect(readResponseTextWithinLimitWithSignal(new Response(null, {
      headers: { "Content-Length": "2" },
    }), 1, signal, observe)).rejects.toMatchObject({ name: "ResponseBodyTooLargeError" });
    expect(observe).toHaveBeenLastCalledWith({ intakeBytes: 0, declaredBytes: 2, outcome: "rejected" });
    await expect(readResponseTextWithinLimitWithSignal(new Response(null), 0, signal, observe)).rejects.toBe(reason);
    expect(observe).toHaveBeenLastCalledWith({ intakeBytes: null, declaredBytes: null, outcome: "rejected" });
    await expect(readResponseTextBoundedWithSignal(new Response(null), 0, signal)).rejects.toBe(reason);
  });

  it("rejects consumed and locked native bodies without reporting acceptance", async () => {
    const observe = vi.fn();
    const consumed = new Response("used");
    await consumed.text();
    const locked = new Response("locked");
    const reader = locked.body!.getReader();
    try {
      for (const response of [consumed, locked]) {
        await expect(readResponseBytesWithinLimitWithSignal(response, 10, undefined, observe)).rejects.toBeInstanceOf(TypeError);
      }
      expect(observe.mock.calls.map(([evidence]) => evidence)).toEqual([
        { intakeBytes: 0, declaredBytes: null, outcome: "rejected" },
        { intakeBytes: 0, declaredBytes: null, outcome: "rejected" },
      ]);
    } finally {
      reader.releaseLock();
    }
  });

  it("preserves partial streamed intake when a body stalls and is cancelled", async () => {
    vi.useFakeTimers();
    const observe = vi.fn();
    const parent = new AbortController();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); },
    }));
    const pending = readResponseBytesWithinLimitWithSignal(response, 5, parent.signal, observe);
    const rejection = expect(pending).rejects.toThrow("stop");
    await vi.advanceTimersByTimeAsync(0);
    parent.abort(new Error("stop"));
    await rejection;
    expect(observe).toHaveBeenLastCalledWith({ intakeBytes: 3, declaredBytes: null, outcome: "rejected" });
  });

  it("caps timeout reads and cancels a stalled stream at the existing deadline", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const pending = readResponseTextWithinLimitWithTimeout(
      new Response(new ReadableStream<Uint8Array>({ cancel })), { timeoutMs: 100, maxBytes: 4 },
    );
    const rejection = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

});

describe("readResponseTextBoundedWithSignal", () => {
  it("returns a truncated diagnostic body instead of throwing", async () => {
    const response = new Response("abcdef");

    await expect(readResponseTextBoundedWithSignal(response, 3)).resolves.toBe("abc");
  });

});

it("preserves null-body, byte-stream and cancellation evidence in workerd", async () => {
  const root = resolve(import.meta.dirname, "../../../..");
  mkdirSync(resolve(root, "agents"), { recursive: true });
  const scratch = mkdtempSync(resolve(root, "agents/response-body-runtime-"));
  let worker: Unstable_DevWorker | undefined;
  try {
    const config = resolve(scratch, "wrangler.json");
    const entry = resolve(scratch, "worker.ts");
    const production = unstable_readConfig({ config: resolve(root, "worker/wrangler.toml") });
    writeFileSync(config, JSON.stringify({
      name: "response-body-runtime-test",
      compatibility_date: production.compatibility_date,
      compatibility_flags: production.compatibility_flags,
      tsconfig: relative(scratch, resolve(root, "worker/tsconfig.json")),
    }));
    writeFileSync(entry, `
      import {
        readResponseBytesWithinLimitWithSignal as bytes,
        readResponseTextWithinLimitWithSignal as text,
        readResponseJsonWithinLimitWithSignal as json,
      } from ${JSON.stringify(resolve(root, "worker/src/lib/response-body.ts"))};
      export default {
        async fetch() {
          const observations = [];
          const observe = evidence => observations.push(evidence);
          const emptyBytes = await bytes(new Response(null), 0, undefined, observe);
          const emptyText = await text(new Response(null), 0, undefined, observe);
          let jsonError;
          try { await json(new Response(null), 0, undefined, observe); }
          catch (error) { jsonError = error.name; }
          const body = await bytes(new Response(new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([0, 128, 255]));
              controller.close();
            },
          })), 3, undefined, observe);
          let cancelReason;
          const parent = new AbortController();
          const reason = new Error("parent stopped");
          const stalled = new Response(new ReadableStream({
            cancel(value) { cancelReason = value; },
          }));
          const pending = bytes(stalled, 3, parent.signal, observe);
          const rejected = pending.catch(error => error === reason);
          parent.abort(reason);
          return Response.json({
            emptyBytes: [...emptyBytes], emptyText, jsonError, body: [...body],
            originalReason: await rejected, cancelled: cancelReason === reason, observations,
          });
        },
      };
    `);
    worker = await unstable_dev(entry, {
      config, local: true, persist: false, logLevel: "error", port: 0,
      experimental: { disableExperimentalWarning: true, disableDevRegistry: true },
    });
    const response = await worker.fetch("/");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      emptyBytes: [], emptyText: "", jsonError: "SyntaxError", body: [0, 128, 255],
      originalReason: true, cancelled: true,
      observations: [
        { intakeBytes: null, declaredBytes: null, outcome: "accepted" },
        { intakeBytes: null, declaredBytes: null, outcome: "accepted" },
        { intakeBytes: null, declaredBytes: null, outcome: "rejected" },
        { intakeBytes: 3, declaredBytes: null, outcome: "accepted" },
        { intakeBytes: 0, declaredBytes: null, outcome: "rejected" },
      ],
    });
  } finally {
    try { await worker?.stop(); }
    finally { rmSync(scratch, { recursive: true, force: true }); }
  }
}, 60_000);
