import { afterEach, describe, expect, it, vi } from "vitest";
import { readResponseSnippet } from "../pricing-provider-diagnostics";

afterEach(() => vi.useRealTimers());

describe("pricing diagnostic snippets", () => {
  it("stops at the byte envelope and cancels without waiting for EOF", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(4097))); }, cancel,
    }));
    expect(await readResponseSnippet(response)).toBe("x".repeat(240));
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("uses the five-second body deadline on a stalled diagnostic stream", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const pending = readResponseSnippet(new Response(new ReadableStream<Uint8Array>({ cancel })));
    await vi.advanceTimersByTimeAsync(5000);
    await expect(pending).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledOnce();
  });
});
