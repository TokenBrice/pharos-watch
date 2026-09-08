import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { selectStaticDepegEventPages } from "@/lib/depeg-event-config";
import { readDepegEventSnapshot } from "@/lib/depeg-event-snapshot";

interface RssRouteModule {
  GET: () => Promise<Response>;
}

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

// Static-content routes are pure modules: import each route graph exactly once
// and reuse the references. vi.resetModules() is reserved for the fixture
// loader below, where a mocked process.cwd() must be baked in at import time.
let routes: Promise<{
  blog: RssRouteModule;
  digest: RssRouteModule;
  depeg: RssRouteModule;
  methodology: RssRouteModule;
  cemetery: RssRouteModule;
}> | undefined;

function loadRoutes() {
  return (routes ??= Promise.all([
    import("../blog.xml/route"),
    import("../digest.xml/route"),
    import("../depeg.xml/route"),
    import("../methodology.xml/route"),
    import("../cemetery.xml/route"),
  ]).then(([blog, digest, depeg, methodology, cemetery]) => ({ blog, digest, depeg, methodology, cemetery })));
}

// All filesystem-rooted scenarios share one temp root and one fixture module
// instance: the route re-reads the data directory on every GET, so tests only
// mutate the shard file between calls.
let fixtureRoot: string | undefined;
let fixtureRoute: Promise<RssRouteModule> | undefined;

function fixtureRouteModule(): Promise<RssRouteModule> {
  return (fixtureRoute ??= (() => {
    fixtureRoot = join(tmpdir(), `pharos-feed-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(join(fixtureRoot, "data/depeg-events"), { recursive: true });
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(fixtureRoot);
    vi.resetModules();
    return import("../depeg.xml/route").then((mod) => {
      cwdSpy.mockRestore();
      return mod;
    });
  })());
}

function writeShard(raw: string) {
  writeFileSync(join(fixtureRoot!, "data/depeg-events/2023.json"), raw, "utf8");
}

function parseItems(xml: string): Array<{ title: string; link: string; guid: string; description: string }> {
  const text = (body: string, tag: string) => {
    // Same element slice as `<tag[^>]*>([\s\S]*?)</tag>`: skip attributes to
    // the opening tag's `>`, then take plain text to the first close tag.
    const open = `<${tag}`;
    const openAt = body.indexOf(open);
    const gt = openAt === -1 ? -1 : body.indexOf(">", openAt + open.length);
    const closeAt = gt === -1 ? -1 : body.indexOf(`</${tag}>`, gt + 1);
    if (openAt === -1 || gt === -1 || closeAt === -1) return "";
    return body
      .slice(gt + 1, closeAt)
      .replace(/^<!\[CDATA\[/, "")
      .replace(/\]\]>$/, "");
  };
  return Array.from(xml.matchAll(/<item>([\s\S]*?)<\/item>/g), ([, body]) => ({
    title: text(body!, "title"),
    link: text(body!, "link"),
    guid: text(body!, "guid"),
    description: text(body!, "description"),
  }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  if (fixtureRoot) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

describe("feed routes smoke", () => {
  // Importing the five route graphs is the expensive part of this file; do it
  // once outside the per-test budget so the assertions keep the default timeout.
  beforeAll(async () => {
    await loadRoutes();
  }, 60_000);

  it("advertised .xml feed routes emit RSS with channel metadata and namespaced guids", async () => {
    const loaded = await loadRoutes();
    const cases: Array<{ route: RssRouteModule; title: string; guidPrefix?: string; expectItems?: boolean }> = [
      { route: loaded.blog, title: "Pharos Blog", guidPrefix: "pharos:blog:", expectItems: true },
      { route: loaded.digest, title: "Pharos Digest" },
      { route: loaded.methodology, title: "Pharos Methodology Changelog", expectItems: true },
      { route: loaded.cemetery, title: "Pharos Cemetery", guidPrefix: "pharos:cemetery:", expectItems: true },
    ];

    for (const { route, title, guidPrefix, expectItems } of cases) {
      const res = await route.GET();
      const xml = await res.text();
      expect(res.headers.get("Content-Type")).toContain("application/rss+xml");
      expect(xml).toContain("<?xml");
      expect(xml).toContain('<rss version="2.0"');
      expect(xml).toContain("<channel>");
      expect(xml).toContain("<atom:link");
      expect(xml).toContain(`<title>${title}</title>`);
      if (guidPrefix) expect(xml).toContain(guidPrefix);
      if (expectItems) expect(xml).toContain("<item>");
    }
  });

  it("depeg route emits the seeded events archive", async () => {
    const { depeg } = await loadRoutes();
    const res = await depeg.GET();
    const xml = await res.text();
    expect(xml).toContain("<title>Pharos Depeg Events</title>");
    expect(xml).toContain("<channel>");
    // data/depeg-events/ carries a committed seed (newest window + the
    // grow-only archive set); CI sync refreshes it at build. The route
    // empty-channel branch still exists for the case where the file becomes [].
    const seeded = readDepegEventSnapshot({ missing: "throw" });
    const newest = selectStaticDepegEventPages(seeded)[0];
    expect(newest).toBeDefined();
    expect(xml).toContain("<item>");
    expect(xml).toContain(`pharos:depeg-event:${newest.slug}`);
    expect(xml).toContain(`https://pharos.watch/depeg/${newest.slug}/`);
    // Legacy stablecoinId-based guids must never resurface.
    expect(xml).not.toContain("pharos:depeg-event:usdc-circle-");
  });

  it("depeg route tolerates a missing prebuild events file", async () => {
    const mod = await fixtureRouteModule();
    const res = await mod.GET();
    expect(await res.text()).not.toContain("<item>");
  });

  it("depeg route throws on malformed events JSON", async () => {
    const mod = await fixtureRouteModule();
    writeShard("{not json");
    await expect(mod.GET()).rejects.toThrow(/Failed to parse .*depeg-events.*\.json as JSON/);
  });

  it("depeg route throws on non-array events JSON", async () => {
    const mod = await fixtureRouteModule();
    writeShard(JSON.stringify({ events: [] }));
    await expect(mod.GET()).rejects.toThrow(/contain an array of depeg events/);
  });

  it("depeg route throws on invalid event rows", async () => {
    const mod = await fixtureRouteModule();
    writeShard(JSON.stringify([makeDepegEvent({ slug: "" })]));
    await expect(mod.GET()).rejects.toThrow(/Invalid depeg feed event data/);
  });

  it("depeg feed emits exactly the newest 100 events in descending order with status and links", async () => {
    const mod = await fixtureRouteModule();
    const epochBase = 1_800_000_000;
    // 101 deliberately unsorted events: newest (i=100) first in the input is
    // the truncation trap; the route must sort, not trust input order.
    const events = Array.from({ length: 101 }, (_, i) =>
      makeDepegEvent({
        id: i,
        slug: `scx-event-${String(i).padStart(3, "0")}`,
        symbol: "SCX",
        // i=1 stays under the 500 bps static-page threshold: it must fall
        // back to the stablecoin history anchor instead of an event page.
        peakDeviationBps: i === 1 ? -499 : -(600 + i),
        direction: i % 2 === 0 ? "below" : "above",
        startedAt: epochBase + i * 60,
        endedAt: i % 3 === 0 ? null : epochBase + i * 60 + 3_600,
      }),
    ).reverse();
    writeShard(JSON.stringify(events));

    const res = await mod.GET();
    const items = parseItems(await res.text());

    expect(items).toHaveLength(100);
    // Newest 100 in strict descending order; the oldest fixture event (i=0)
    // is truncated away.
    expect(items.map((item) => item.guid)).toEqual(
      Array.from({ length: 100 }, (_, rank) => `pharos:depeg-event:scx-event-${String(100 - rank).padStart(3, "0")}`),
    );
    expect(items.map((item) => item.guid)).not.toContain("pharos:depeg-event:scx-event-000");
    // Newest (i=100, below, resolved) and runner-up (i=99, above, active)
    // carry direction, magnitude, and resolution status.
    expect(items[0]!.link).toBe("https://pharos.watch/depeg/scx-event-100/");
    expect(items[0]!.title).toBe("SCX depeg -700 bps");
    expect(items[0]!.description).toBe("Resolved below peg by 700 bps starting 2027-01-15.");
    expect(items[1]!.title).toBe("SCX depeg +699 bps");
    expect(items[1]!.description).toBe("Active above peg by 699 bps starting 2027-01-15.");
    // Sub-threshold events link to the stablecoin history anchor instead.
    expect(items[99]!.guid).toBe("pharos:depeg-event:scx-event-001");
    expect(items[99]!.link).toContain("usdc-circle");
    expect(items[99]!.link.endsWith("#depeg-history")).toBe(true);
  });
});
