import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelResponseBodyQuietly,
  cancelUnsuccessfulResponseBodyQuietly,
  drainResponseBody,
  readResponseSnippetWithTimeout,
  readResponseTextBoundedWithSignal,
  readResponseTextWithinLimitWithSignal,
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
    await expect(readResponseTextWithinLimitWithSignal(new Response("éé"), 4)).resolves.toBe("éé");
    await expect(readResponseTextWithinLimitWithSignal(new Response("éé"), 3)).rejects.toMatchObject({
      name: "ResponseBodyTooLargeError", maxBytes: 3, observedBytes: 4,
    });
  });
});

describe("drainResponseBody", () => {
  it("returns without touching responses that are already consumed", async () => {
    const response = new Response("ok");
    await response.text();

    await expect(drainResponseBody(response)).resolves.toBeUndefined();
  });

  it("cancels the stream when arrayBuffer consumption fails", async () => {
    const cancel = vi.fn(async () => undefined);
    const response = {
      bodyUsed: false,
      body: { cancel },
      arrayBuffer: vi.fn(async () => {
        throw new Error("stream failed");
      }),
    } as unknown as Response;

    await expect(drainResponseBody(response)).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("swallows cancellation failures after a read failure", async () => {
    const response = {
      bodyUsed: false,
      body: {
        cancel: vi.fn(async () => {
          throw new Error("already cancelled");
        }),
      },
      arrayBuffer: vi.fn(async () => {
        throw new Error("stream failed");
      }),
    } as unknown as Response;

    await expect(drainResponseBody(response)).resolves.toBeUndefined();
  });
});

describe("cancelResponseBodyQuietly", () => {
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
