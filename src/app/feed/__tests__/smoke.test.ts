import { describe, expect, it } from "vitest";

describe("feed routes smoke", () => {
  it("digest route emits valid RSS XML", async () => {
    const mod = await import("../digest/route");
    const res = await mod.GET();
    const xml = await res.text();
    expect(res.headers.get("Content-Type")).toContain("application/rss+xml");
    expect(xml).toContain("<?xml");
    expect(xml).toContain("<title>Pharos Digest</title>");
    expect(xml).toContain("<atom:link");
  });

  it("depeg route gracefully emits empty channel when events file absent", async () => {
    const mod = await import("../depeg/route");
    const res = await mod.GET();
    const xml = await res.text();
    expect(xml).toContain("<title>Pharos Depeg Events</title>");
    expect(xml).toContain("<channel>");
    // data/depeg-events.json is produced by W3-D (Wave 3); until then, no items.
    expect(xml).not.toContain("<item>");
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
