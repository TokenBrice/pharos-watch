import { describe, expect, it, vi } from "vitest";

import { findThreats } from "../ci/check-safe-browsing";

describe("Safe Browsing provider boundary", () => {
  it("times out a stalled provider request", async () => {
    const stalledFetch = vi.fn((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      })) as unknown as typeof fetch;

    await expect(findThreats("fixture-key", stalledFetch, 5)).rejects.toThrow();
  });

  it("rejects malformed success payloads instead of reporting them clean", async () => {
    const malformedFetch = vi.fn(async () => Response.json({ matches: "bad" })) as unknown as typeof fetch;

    await expect(findThreats("fixture-key", malformedFetch)).rejects.toThrow();
  });

  it("accepts the provider's documented empty-object clean response", async () => {
    const cleanFetch = vi.fn(async () => Response.json({})) as unknown as typeof fetch;

    await expect(findThreats("fixture-key", cleanFetch)).resolves.toEqual([]);
  });
});
