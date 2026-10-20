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

  it.each([
    { error: { code: 403, message: "Permission denied" } },
    { status: "unavailable" },
    { matches: [], error: { code: 500, message: "Provider failure" } },
  ])("rejects HTTP-200 error or unknown envelopes: %j", async (payload) => {
    const fetchImpl = vi.fn(async () => Response.json(payload)) as unknown as typeof fetch;

    await expect(findThreats("fixture-key", fetchImpl)).rejects.toThrow();
  });

  it("returns validated threat matches instead of reporting a clean verdict", async () => {
    const match = {
      threat: { url: "https://pharos.watch/" },
      threatType: "SOCIAL_ENGINEERING",
      platformType: "ANY_PLATFORM",
      cacheDuration: "300s",
    };
    const fetchImpl = vi.fn(async () => Response.json({ matches: [match] })) as unknown as typeof fetch;

    await expect(findThreats("fixture-key", fetchImpl)).resolves.toEqual([match]);
  });

  it("rejects HTTP failures instead of reporting them clean", async () => {
    const fetchImpl = vi.fn(async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch;

    await expect(findThreats("fixture-key", fetchImpl)).rejects.toThrow("Safe Browsing API error 503");
  });
});
