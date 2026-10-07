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
    const response = {
      bodyUsed: false,
      body: { cancel },
    } as unknown as Response;

    await expect(cancelResponseBodyQuietly(response)).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("does not cancel responses whose body has already been consumed", async () => {
    const cancel = vi.fn(async () => undefined);
    const response = {
      bodyUsed: true,
      body: { cancel },
    } as unknown as Response;

    await expect(cancelResponseBodyQuietly(response)).resolves.toBeUndefined();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("swallows cancellation errors", async () => {
    const response = {
      bodyUsed: false,
      body: {
        cancel: vi.fn(async () => {
          throw new Error("cannot cancel");
        }),
      },
    } as unknown as Response;

    await expect(cancelResponseBodyQuietly(response)).resolves.toBeUndefined();
  });
});

describe("cancelUnsuccessfulResponseBodyQuietly", () => {
  it("does not cancel successful responses", async () => {
    const cancel = vi.fn(async () => undefined);
    const response = {
      ok: true,
      body: { cancel },
    } as unknown as Response;

    await expect(cancelUnsuccessfulResponseBodyQuietly(response)).resolves.toBeUndefined();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("cancels non-OK responses", async () => {
    const cancel = vi.fn(async () => undefined);
    const response = {
      ok: false,
      body: { cancel },
    } as unknown as Response;

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
    const fake = { json: async () => ({ ok: true }) } as unknown as Response;
    await readResponseJsonWithinLimitWithSignal(fake, 20, undefined, observe);
    expect(observe).toHaveBeenLastCalledWith({ intakeBytes: null, declaredBytes: null, outcome: "accepted" });
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
  });

  it("throws when the declared content length exceeds the strict limit", async () => {
    const response = new Response("abcdef", {
      headers: { "Content-Length": "6" },
    });

    await expect(readResponseTextWithinLimitWithSignal(response, 5)).rejects.toMatchObject({
      name: "ResponseBodyTooLargeError",
      maxBytes: 5,
      observedBytes: 6,
    });
  });

  it("throws when the streamed body exceeds the strict limit", async () => {
    const response = new Response("abcdef");

    await expect(readResponseTextWithinLimitWithSignal(response, 5)).rejects.toMatchObject({
      name: "ResponseBodyTooLargeError",
      maxBytes: 5,
      observedBytes: 6,
    });
  });
});

describe("readResponseTextBoundedWithSignal", () => {
  it("returns a truncated diagnostic body instead of throwing", async () => {
    const response = new Response("abcdef");

    await expect(readResponseTextBoundedWithSignal(response, 3)).resolves.toBe("abc");
  });

  it("returns an empty diagnostic body for a zero-byte limit", async () => {
    const response = new Response("abcdef");

    await expect(readResponseTextBoundedWithSignal(response, 0)).resolves.toBe("");
  });
});
