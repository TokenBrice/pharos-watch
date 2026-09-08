import { describe, expect, it, vi } from "vitest";
import {
  BoundedStreamOverflowError,
  bufferReadableStream,
  createCappedReadableStream,
  parseDeclaredLength,
} from "../bounded-stream";

describe("parseDeclaredLength", () => {
  it("accepts only digit-only safe integers", () => {
    expect(parseDeclaredLength(" 42 ")).toEqual({ status: "valid", value: 42 });
    expect(parseDeclaredLength("12.5")).toEqual({ status: "invalid", reason: "malformed" });
    expect(parseDeclaredLength("1e3")).toEqual({ status: "invalid", reason: "malformed" });
  });

  it("distinguishes negative and unsafe declared lengths", () => {
    expect(parseDeclaredLength("-1")).toEqual({ status: "invalid", reason: "negative" });
    expect(parseDeclaredLength("9007199254740992")).toEqual({ status: "invalid", reason: "unsafe" });
  });
});

describe("bufferReadableStream", () => {
  it("preserves all chunks below and at the cap, including empty zero-cap input", async () => {
    for (const maxBytes of [3, 4]) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
          controller.enqueue(new Uint8Array([2, 3]));
          controller.close();
        },
      });
      await expect(bufferReadableStream(stream, { maxBytes }))
        .resolves.toEqual({ bytes: new Uint8Array([1, 2, 3]), truncated: false });
    }
    const empty = new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
    await expect(bufferReadableStream(empty, { maxBytes: 0 }))
      .resolves.toEqual({ bytes: new Uint8Array(), truncated: false });
    const nonempty = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1])); controller.close(); },
    });
    await expect(bufferReadableStream(nonempty, { maxBytes: 0 }))
      .rejects.toMatchObject({ maxBytes: 0, observedBytes: 1 });
  });

  it("treats an exact-cap diagnostic as truncated without waiting for EOF", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1, 2])); },
      cancel,
    });
    // Diagnostics stop at the cap; truncated means EOF was not established.
    await expect(bufferReadableStream(stream, { maxBytes: 2, overflowMode: "truncate" }))
      .resolves.toEqual({ bytes: new Uint8Array([1, 2]), truncated: true });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels pre-aborted input with its original reason", async () => {
    const cancel = vi.fn();
    const controller = new AbortController();
    const reason = new Error("already stopped");
    controller.abort(reason);
    const stream = new ReadableStream<Uint8Array>({ cancel });
    await expect(bufferReadableStream(stream, { maxBytes: 1, signal: controller.signal }))
      .rejects.toBe(reason);
    expect(cancel).toHaveBeenCalledWith(reason);
  });

  it("rejects invalid caps before locking or consuming the input", async () => {
    for (const maxBytes of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const pull = vi.fn();
      const stream = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
      await expect(bufferReadableStream(stream, { maxBytes })).rejects.toBeInstanceOf(RangeError);
      expect(() => createCappedReadableStream(stream, { maxBytes })).toThrow(RangeError);
      expect(stream.locked).toBe(false);
      expect(pull).not.toHaveBeenCalled();
    }
  });

  it("cancels and throws as soon as a streamed body crosses the cap", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
      },
      cancel,
    });

    await expect(bufferReadableStream(stream, { maxBytes: 3 })).rejects.toMatchObject({
      name: "BoundedStreamOverflowError",
      maxBytes: 3,
      observedBytes: 4,
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels a pending read and preserves the abort reason", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => undefined);
      },
      cancel,
    });
    const controller = new AbortController();
    const reason = new DOMException("stop reading", "AbortError");
    const read = bufferReadableStream(stream, { maxBytes: 10, signal: controller.signal });

    controller.abort(reason);

    await expect(read).rejects.toBe(reason);
    expect(cancel).toHaveBeenCalledWith(reason);
  });

  it("propagates reader errors without normalizing them", async () => {
    const failure = new Error("reader failed");
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        throw failure;
      },
    });

    await expect(bufferReadableStream(stream, { maxBytes: 10 })).rejects.toBe(failure);
  });

  it("can truncate buffered diagnostics at the byte cap", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
      },
    });

    await expect(bufferReadableStream(stream, {
      maxBytes: 3,
      overflowMode: "truncate",
    })).resolves.toEqual({ bytes: new Uint8Array([1, 2, 3]), truncated: true });
  });
});

describe("createCappedReadableStream", () => {
  it("delivers the final permitted chunk and EOF, and forwards downstream cancellation", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.enqueue(new Uint8Array([2, 3]));
        controller.close();
      },
    });
    const reader = createCappedReadableStream(source, { maxBytes: 3 }).getReader();
    await expect(reader.read()).resolves.toEqual({ done: false, value: new Uint8Array([1]) });
    await expect(reader.read()).resolves.toEqual({ done: false, value: new Uint8Array([2, 3]) });
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });

    const cancel = vi.fn();
    const pending = createCappedReadableStream(new ReadableStream<Uint8Array>({ cancel }), { maxBytes: 3 });
    const reason = new Error("consumer stopped");
    await pending.cancel(reason);
    expect(cancel).toHaveBeenCalledWith(reason);
  });

  it("forwards chunks until overflow, then invokes the policy hook and cancels upstream", async () => {
    const cancel = vi.fn();
    const onOverflow = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
      },
      cancel,
    });
    const capped = createCappedReadableStream(source, {
      maxBytes: 3,
      onOverflow,
      overflowCancelReason: (error) => error,
    });
    const reader = capped.getReader();

    await expect(reader.read()).resolves.toEqual({ done: false, value: new Uint8Array([1, 2]) });
    await expect(reader.read()).rejects.toBeInstanceOf(BoundedStreamOverflowError);
    expect(onOverflow).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });
});
