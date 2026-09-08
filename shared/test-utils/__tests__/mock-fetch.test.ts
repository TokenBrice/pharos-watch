import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch, type MockRoute } from "@shared/test-utils/mock-fetch";

const url = "https://rpc.example/test";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("mockFetch cancellation boundaries", () => {
  it.each([undefined, 0, 100])("rejects pre-abort without consuming an outcome (delay %s)", async (delayMs) => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    controller.abort(reason);
    const fetch = mockFetch([{ match: url, outcomes: [{ body: { ok: true }, delayMs }] }], { stubGlobal: false });
    await expect(fetch(url, { signal: controller.signal })).rejects.toBe(reason);
    await expect((await fetch(url)).json()).resolves.toEqual({ ok: true });
    fetch.assertAllOutcomesUsed();
  });

  it.each(["match", "matchJson", "respond"] as const)("rejects cancellation during async %s", async (stage) => {
    const controller = new AbortController();
    const reason = new Error("cancelled during callback");
    const abort = async () => { await Promise.resolve(); controller.abort(reason); return true; };
    const route: MockRoute = stage === "respond"
      ? { match: url, respond: async () => { await abort(); return new Response("late"); } }
      : { match: stage === "match" ? abort : url, matchJson: stage === "matchJson" ? abort : undefined, body: "late" };
    const fetch = mockFetch([route], { stubGlobal: false });
    await expect(fetch(url, { method: "POST", body: "{}", signal: controller.signal })).rejects.toBe(reason);
  });

  it("does not execute later predicates after cancellation in a nonmatching predicate", async () => {
    const controller = new AbortController();
    const reason = new Error("stop matching");
    const next = vi.fn(() => true);
    const fetch = mockFetch([
      { match: async () => { controller.abort(reason); return false; }, body: "no" },
      { match: next, body: "late" },
    ], { stubGlobal: false });
    await expect(fetch(url, { signal: controller.signal })).rejects.toBe(reason);
    expect(next).not.toHaveBeenCalled();
  });

  it("uses the init signal and clears a delayed timer on cancellation", async () => {
    vi.useFakeTimers();
    const original = new AbortController();
    const effective = new AbortController();
    const reason = new Error("effective cancellation");
    const fetch = mockFetch([{ match: url, body: "late", delayMs: 100 }], { stubGlobal: false });
    const pending = fetch(new Request(url, { signal: original.signal }), { signal: effective.signal });
    const rejection = expect(pending).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(0);
    original.abort();
    await vi.advanceTimersByTimeAsync(99);
    expect(vi.getTimerCount()).toBe(1);
    effective.abort(reason);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows an explicit null init signal to replace an aborted Request signal", async () => {
    const original = new AbortController();
    original.abort();
    const fetch = mockFetch([{ match: url, body: "ok" }], { stubGlobal: false });
    await expect((await fetch(new Request(url, { signal: original.signal }), { signal: null })).text()).resolves.toBe("ok");
  });
});
