import { describe, expect, it } from "vitest";
import { buildBrowserHeaders } from "../request";

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
});
