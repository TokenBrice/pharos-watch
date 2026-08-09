/* eslint-disable security/detect-non-literal-fs-filename -- test creates and cleans temporary feed fixture files under os.tmpdir() only. */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tmpRoots: string[] = [];

function makeDepegEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    stablecoinId: "usdc-circle",
    symbol: "USDC",
    pegType: "peggedUSD",
    direction: "below",
    peakDeviationBps: -1300,
    startedAt: 1_678_492_800,
    endedAt: 1_678_579_200,
    startPrice: 0.99,
    peakPrice: 0.87,
    recoveryPrice: 1,
    pegReference: 1,
    source: "backfill",
    confirmationSources: null,
    pendingReason: null,
    closeReason: null,
    provenance: null,
    slug: "usdc-2023-03-11",
    ...overrides,
  };
}

async function importDepegRouteWithData(raw: string | null) {
  vi.resetModules();
  const root = mkdtempRoot();
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  if (raw !== null) {
    writeFileSync(join(dataDir, "depeg-events.json"), raw, "utf8");
  }

  const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(root);
  const mod = await import("../depeg.xml/route");
  cwdSpy.mockRestore();
  return mod;
}

function mkdtempRoot(): string {
  const root = join(tmpdir(), `pharos-feed-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  tmpRoots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("feed routes smoke", () => {
  // Imports four route modules in one test; module transformation can exceed
  // the default 5s under a fully loaded machine (parallel merge-gate matrix),
  // so this smoke gets a generous timeout.
  it("advertised .xml feed routes emit RSS content", { timeout: 30_000 }, async () => {
    const routes = [
      await import("../blog.xml/route"),
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

  it("blog route emits valid RSS XML", async () => {
    const mod = await import("../blog.xml/route");
    const res = await mod.GET();
    const xml = await res.text();
    expect(res.headers.get("Content-Type")).toContain("application/rss+xml");
    expect(xml).toContain("<?xml");
    expect(xml).toContain("<title>Pharos Blog</title>");
    expect(xml).toContain("<atom:link");
    expect(xml).toContain("pharos:blog:");
  });

  it("digest route emits valid RSS XML", async () => {
    const mod = await import("../digest.xml/route");
    const res = await mod.GET();
    const xml = await res.text();
    expect(res.headers.get("Content-Type")).toContain("application/rss+xml");
    expect(xml).toContain("<?xml");
    expect(xml).toContain("<title>Pharos Digest</title>");
    expect(xml).toContain("<atom:link");
  });

  it("depeg route emits the seeded events archive", async () => {
    const mod = await import("../depeg.xml/route");
    const res = await mod.GET();
    const xml = await res.text();
    expect(xml).toContain("<title>Pharos Depeg Events</title>");
    expect(xml).toContain("<channel>");
    // data/depeg-events.json carries a committed seed (newest window + the
    // grow-only archive set); CI sync refreshes it at build. The route
    // empty-channel branch still exists for the case where the file becomes [].
    const seeded = (await import("../../../../data/depeg-events.json")).default as Array<{
      slug: string;
      startedAt: number;
      peakDeviationBps: number;
    }>;
    const { selectStaticDepegEventPages } = await import("../../depeg/[event]/config");
    const newest = selectStaticDepegEventPages(seeded)[0];
    expect(newest).toBeDefined();
    expect(xml).toContain("<item>");
    expect(xml).toContain(`pharos:depeg-event:${newest.slug}`);
    expect(xml).toContain(`https://pharos.watch/depeg/${newest.slug}/`);
    // Legacy stablecoinId-based guids must never resurface.
    expect(xml).not.toContain("pharos:depeg-event:usdc-circle-");
  });

  it("depeg route tolerates a missing prebuild events file", async () => {
    const mod = await importDepegRouteWithData(null);
    const res = await mod.GET();
    const xml = await res.text();
    expect(xml).toContain("<title>Pharos Depeg Events</title>");
    expect(xml).not.toContain("<item>");
  });

  it("depeg route throws on malformed events JSON", async () => {
    const mod = await importDepegRouteWithData("{not json");
    await expect(mod.GET()).rejects.toThrow(/Failed to parse .*depeg-events\.json as JSON/);
  });

  it("depeg route throws on non-array events JSON", async () => {
    const mod = await importDepegRouteWithData(JSON.stringify({ events: [] }));
    await expect(mod.GET()).rejects.toThrow(/contain an array of depeg events/);
  });

  it("depeg route throws on invalid event rows", async () => {
    const mod = await importDepegRouteWithData(JSON.stringify([makeDepegEvent({ slug: "" })]));
    await expect(mod.GET()).rejects.toThrow(/Invalid depeg feed event data/);
  });

  it("methodology route emits items across the unified changelogs", async () => {
    const mod = await import("../methodology.xml/route");
    const res = await mod.GET();
    const xml = await res.text();
    expect(xml).toContain("<title>Pharos Methodology Changelog</title>");
    expect(xml).toContain("<item>");
  });

  it("cemetery route emits items", async () => {
    const mod = await import("../cemetery.xml/route");
    const res = await mod.GET();
    const xml = await res.text();
    expect(xml).toContain("<title>Pharos Cemetery</title>");
    expect(xml).toContain("<item>");
    expect(xml).toContain("pharos:cemetery:");
  });
});
