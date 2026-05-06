import { describe, expect, it } from "vitest";
import { buildBrowserHeaders, getCachedRequest } from "../request";

describe("buildBrowserHeaders", () => {
  it("returns the canonical Origin/Referer/Accept-Language triple", () => {
    const headers = buildBrowserHeaders("https://app.example.com") as Record<string, string>;
    expect(headers.Origin).toBe("https://app.example.com");
    expect(headers.Referer).toBe("https://app.example.com");
    expect(headers["Accept-Language"]).toBe("en-US,en;q=0.9");
  });

  it("allows a distinct Referer when an adapter uses a deeper path", () => {
    const headers = buildBrowserHeaders(
      "https://app.ethena.fi",
      "https://app.ethena.fi/dashboards/transparency",
    ) as Record<string, string>;
    expect(headers.Origin).toBe("https://app.ethena.fi");
    expect(headers.Referer).toBe("https://app.ethena.fi/dashboards/transparency");
  });

  it("evicts failed cached requests so the next call can recover", async () => {
    const ctx = { requestCache: new Map<string, Promise<unknown>>() };
    let calls = 0;

    await expect(getCachedRequest("recoverable", async () => {
      calls++;
      throw new Error("first attempt failed");
    }, ctx)).rejects.toThrow("first attempt failed");

    const recovered = await getCachedRequest("recoverable", async () => {
      calls++;
      return "ok";
    }, ctx);

    expect(recovered).toBe("ok");
    expect(calls).toBe(2);
  });
});
