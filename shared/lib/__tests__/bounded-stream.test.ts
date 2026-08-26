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
