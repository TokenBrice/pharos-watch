import { describe, expect, it } from "vitest";

import { getAnalyticsPayloadUrls, hasGaConfigInit, verifyAnalyticsSnippet } from "../smoke-ui.mjs";

describe("hasGaConfigInit", () => {
  it("accepts the single-quoted GA config emitted by older builds", () => {
    expect(hasGaConfigInit("gtag('config', 'G-6TS0KG8H04');", "G-6TS0KG8H04")).toBe(true);
  });

  it("accepts the double-quoted GA config emitted by JSON.stringify", () => {
    expect(hasGaConfigInit("gtag('config', \"G-6TS0KG8H04\");", "G-6TS0KG8H04")).toBe(true);
  });

  it("accepts the JSON-escaped GA config emitted in static RSC payloads", () => {
    expect(hasGaConfigInit("gtag('config', \\\"G-6TS0KG8H04\\\");", "G-6TS0KG8H04")).toBe(true);
  });

  it("rejects a different GA measurement id", () => {
    expect(hasGaConfigInit("gtag('config', \"G-OTHER\");", "G-6TS0KG8H04")).toBe(false);
  });
});

describe("getAnalyticsPayloadUrls", () => {
  it("returns root static payload candidates", () => {
    expect(getAnalyticsPayloadUrls("https://pharos.watch/")).toEqual([
      "https://pharos.watch/index.txt",
      "https://pharos.watch/__next._index.txt",
      "https://pharos.watch/__next._full.txt",
    ]);
  });
});

describe("verifyAnalyticsSnippet", () => {
  it("accepts GA config init from the root static RSC payload", async () => {
    const fetchMock = async (url: string) => {
      if (url === "https://pharos.watch/") {
        return new Response('<link rel="preload" href="https://www.googletagmanager.com/gtag/js?id=G-6TS0KG8H04" as="script"/>');
      }
      if (url === "https://pharos.watch/index.txt") {
        return new Response("gtag('config', \\\"G-6TS0KG8H04\\\");");
      }
      return new Response("not found", { status: 404 });
    };

    await expect(verifyAnalyticsSnippet("https://pharos.watch/", "G-6TS0KG8H04", fetchMock)).resolves.toBeUndefined();
  });
});
