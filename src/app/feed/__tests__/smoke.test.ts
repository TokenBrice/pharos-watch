import { describe, expect, it } from "vitest";

describe("feed routes smoke", () => {
  // Imports four route modules in one test; module transformation can exceed
  // the default 5s under a fully loaded machine (parallel merge-gate matrix),
  // so this smoke gets a generous timeout.
  it("advertised .xml feed routes emit RSS content", { timeout: 30_000 }, async () => {
    const routes = [
      await import("../digest.xml/route"),
      await import("../depeg.xml/route"),
      await import("../methodology.xml/route"),
      await import("../cemetery.xml/route"),
    ];

    for (const route of routes) {
      const res = await route.GET();
      const xml = await res.text();
      expect(res.headers.get("Content-Type")).toContain("application/rss+xml");
      expect(xml).toContain('<rss version="2.0"');
      expect(xml).toContain("<atom:link");
      expect(xml).toContain(".xml");
    }
  });

  it("digest route emits valid RSS XML", async () => {
    const mod = await import("../digest/route");
    const res = await mod.GET();
    const xml = await res.text();
    expect(res.headers.get("Content-Type")).toContain("application/rss+xml");
    expect(xml).toContain("<?xml");
    expect(xml).toContain("<title>Pharos Digest</title>");
    expect(xml).toContain("<atom:link");
  });

  it("depeg route emits the seeded events archive", async () => {
    const mod = await import("../depeg/route");
    const res = await mod.GET();
    const xml = await res.text();
    expect(xml).toContain("<title>Pharos Depeg Events</title>");
    expect(xml).toContain("<channel>");
    // data/depeg-events.json carries at least the seeded USDC 2023-03-11 event;
    // CI sync populates the rest. The route empty-channel branch still exists
    // for the case where the file becomes [].
    expect(xml).toContain("<item>");
    expect(xml).toContain("pharos:depeg-event:usdc-2023-03-11");
    expect(xml).toContain("https://pharos.watch/depeg/usdc-2023-03-11/");
    expect(xml).not.toContain("pharos:depeg-event:usdc-circle-2023-03-11");
  });

  it("methodology route emits items across the unified changelogs", async () => {
    const mod = await import("../methodology/route");
    const res = await mod.GET();
    const xml = await res.text();
    expect(xml).toContain("<title>Pharos Methodology Changelog</title>");
    expect(xml).toContain("<item>");
  });

  it("cemetery route emits items", async () => {
    const mod = await import("../cemetery/route");
    const res = await mod.GET();
    const xml = await res.text();
    expect(xml).toContain("<title>Pharos Cemetery</title>");
    expect(xml).toContain("<item>");
    expect(xml).toContain("pharos:cemetery:");
  });
});
