import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { METHODOLOGY_CHANGELOG_REGISTRY } from "@shared/lib/methodology-versions/registry";
import { DEPEG_CLOSURE_LABELS } from "@shared/lib/classification";

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

// Cache ordinary route imports; reset modules only for isolated fixture imports.
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

// One temp root: depeg GET re-reads the shard after each fixture write.
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

function parseItems(xml: string): Array<{ title: string; link: string; guid: string; description: string; pubDate: string }> {
  const text = (body: string, tag: string) => {
    const open = body.indexOf(`<${tag}`);
    const start = body.indexOf(">", open) + 1;
    const end = body.indexOf(`</${tag}>`, start);
    return (open < 0 || !start || end < 0 ? "" : body.slice(start, end))
      .replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
  };
  return Array.from(xml.matchAll(/<item>([\s\S]*?)<\/item>/g), ([, body]) => ({
    title: text(body!, "title"),
    link: text(body!, "link"),
    guid: text(body!, "guid"),
    description: text(body!, "description"),
    pubDate: text(body!, "pubDate"),
  }));
}

function parseLastBuildDate(xml: string): string {
  return xml.match(/<lastBuildDate>([^<]*)<\/lastBuildDate>/)?.[1] ?? "";
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
  // Load the route graphs once outside the per-test timeout.
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

  it("describes every registered methodology dataset in registry order", async () => {
    const loaded = await loadRoutes();
    const xml = await (await loaded.methodology.GET()).text();
    expect(xml).toContain(
      `Versioned methodology updates from pharos.watch — ${METHODOLOGY_CHANGELOG_REGISTRY.map(({ feedLabel }) => feedLabel).join(", ")}.`,
    );
  });

  it("keeps live methodology dates descending and bounded by the build clock", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = Math.max(...METHODOLOGY_CHANGELOG_REGISTRY.flatMap(({ entries }) =>
      entries.map(({ date }) => Date.parse(`${date}T00:00:00Z`)))) + 12 * 3_600_000;
    vi.setSystemTime(now);
    try {
      const loaded = await loadRoutes();
      const xml = await (await loaded.methodology.GET()).text();
      const items = parseItems(xml);
      const lastBuildDate = parseLastBuildDate(xml);
      const pubDateMs = items.map(({ pubDate }) => Date.parse(pubDate));

      expect(items.length).toBeGreaterThan(0);
      expect(Math.max(...pubDateMs)).toBeLessThanOrEqual(now);
      expect(pubDateMs).toEqual([...pubDateMs].sort((left, right) => right - left));
      expect(Date.parse(lastBuildDate)).toBeLessThanOrEqual(now);
      expect(lastBuildDate).not.toBe(items[0]!.pubDate);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pins authored chronology and the build clock despite future activation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-03T12:00:00Z"));
    vi.resetModules();
    vi.doMock("@shared/lib/methodology-versions/registry", () => ({ METHODOLOGY_CHANGELOG_REGISTRY: [{
      feedLabel: "Example", feedKey: "example", publicPath: "/methodology/example/",
      entries: [
        { version: "1.0", title: "Older", date: "2026-01-01", effectiveAt: Date.UTC(2027, 0, 1) / 1_000, summary: "Older release", impact: [] },
        { version: "2.0", title: "Newer", date: "2026-01-02", effectiveAt: Date.UTC(2026, 0, 2) / 1_000, summary: "Newer release", impact: [] },
      ],
    }] }));
    try {
      const route = await import("../methodology.xml/route");
      const xml = await (await route.GET()).text();
      const items = parseItems(xml);
      expect(items.map(({ guid }) => guid)).toEqual(["pharos:methodology:example:2.0", "pharos:methodology:example:1.0"]);
      expect(items.map(({ pubDate }) => pubDate)).toEqual(["Fri, 02 Jan 2026 00:00:00 GMT", "Thu, 01 Jan 2026 00:00:00 GMT"]);
      expect(parseLastBuildDate(xml)).toBe("Sat, 03 Jan 2026 12:00:00 GMT");
    } finally {
      vi.doUnmock("@shared/lib/methodology-versions/registry");
      vi.resetModules();
      vi.useRealTimers();
    }
  });

  it("depeg route tolerates a missing prebuild events file", async () => {
    const mod = await fixtureRouteModule();
    const res = await mod.GET();
    expect(await res.text()).not.toContain("<item>");
  });

  it.each([
    ["malformed events JSON", "{not json", /Failed to parse .*depeg-events.*\.json as JSON/],
    ["invalid event rows", JSON.stringify([makeDepegEvent({ slug: "" })]), /Invalid depeg feed event data/],
  ] as const)("depeg route throws on %s", async (_, raw, error) => {
    const mod = await fixtureRouteModule();
    writeShard(raw);
    await expect(mod.GET()).rejects.toThrow(error);
  });

  it("depeg feed emits exactly the newest 100 events in descending order with status and links", async () => {
    const mod = await fixtureRouteModule();
    const epochBase = 1_800_000_000;
    // Unsorted input must be sorted before truncation.
    const events = Array.from({ length: 101 }, (_, i) =>
      makeDepegEvent({
        id: i,
        slug: `scx-event-${String(i).padStart(3, "0")}`,
        symbol: "SCX",
        // Sub-threshold events use the profile history anchor.
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
    // The oldest event is truncated away.
    expect(items.map((item) => item.guid)).toEqual(
      Array.from({ length: 100 }, (_, rank) => `pharos:depeg-event:scx-event-${String(100 - rank).padStart(3, "0")}`),
    );
    expect(items.map((item) => item.guid)).not.toContain("pharos:depeg-event:scx-event-000");
    // Recorded peaks and closure status never imply a current price.
    expect(items[0]!.link).toBe("https://pharos.watch/depeg/scx-event-100/");
    expect(items[0]!.title).toBe("SCX depeg -700 bps");
    expect(items[0]!.description).toBe("Resolved; peaked at 700 bps below peg starting 2027-01-15.");
    expect(items[1]!.title).toBe("SCX depeg +699 bps");
    expect(items[1]!.description).toBe(`${DEPEG_CLOSURE_LABELS.open}; peaked at 699 bps above peg starting 2027-01-15.`);
    expect(items.every((item) => !item.description.includes("Active"))).toBe(true);
    // Sub-threshold events link to the stablecoin history anchor instead.
    expect(items[99]!.guid).toBe("pharos:depeg-event:scx-event-001");
    expect(items[99]!.link).toContain("usdc-circle");
    expect(items[99]!.link.endsWith("#depeg-history")).toBe(true);
  });

  it("depeg feed quarantines disputed audit verdicts without consuming feed slots", async () => {
    const mod = await fixtureRouteModule();
    const epochBase = 1_800_000_000;
    const confirmed = Array.from({ length: 101 }, (_, i) =>
      makeDepegEvent({
        id: i,
        slug: `confirmed-${String(i).padStart(3, "0")}`,
        startedAt: epochBase + i * 60,
        endedAt: epochBase + i * 60 + 3_600,
      }),
    );
    const disputed = makeDepegEvent({
      id: 999,
      slug: "disputed-newest",
      startedAt: epochBase + 10_000,
      endedAt: epochBase + 13_600,
      provenance: { auditVerdict: "disputed" },
    });
    writeShard(JSON.stringify([...confirmed, disputed]));

    const items = parseItems(await (await mod.GET()).text());

    expect(items).toHaveLength(100);
    expect(items.map((item) => item.guid)).not.toContain("pharos:depeg-event:disputed-newest");
    expect(items[0]!.guid).toBe("pharos:depeg-event:confirmed-100");
  });

  it("depeg feed reserves resolved status for recovered closures", async () => {
    const mod = await fixtureRouteModule();
    const cases = [
      { closeReason: "recovered-primary", recoveryPrice: 1, status: "Resolved" },
      { closeReason: "recovered-dex", recoveryPrice: 1, status: "Resolved" },
      { closeReason: "recovered-native", recoveryPrice: null, status: "Resolved" },
      { closeReason: null, recoveryPrice: 1, status: "Resolved" },
      { closeReason: "coverage-lost-supply", recoveryPrice: null, status: "Closed", detail: "coverage lost" },
      { closeReason: "superseded-direction", recoveryPrice: null, status: "Closed", detail: "direction change" },
      { closeReason: "orphan-tracking-removed", recoveryPrice: null, status: "Closed", detail: "removed from tracking" },
      { closeReason: null, recoveryPrice: null, status: "Closed", detail: "unknown terminal state" },
      { closeReason: null, recoveryPrice: null, endedAt: null, status: DEPEG_CLOSURE_LABELS.open },
    ];
    writeShard(JSON.stringify(cases.map(({ status: _status, detail: _detail, ...closure }, index) =>
      makeDepegEvent({ id: index + 1, slug: `closure-${index}`, ...closure }),
    )));
    const items = parseItems(await (await mod.GET()).text());

    for (const [index, { status, detail }] of cases.entries()) {
      const item = items.find(({ guid }) => guid === `pharos:depeg-event:closure-${index}`)!;
      expect(item.description.startsWith(status)).toBe(true);
      if (detail) {
        expect(item.description).toContain(detail);
        expect(item.description).toContain("recovery not confirmed");
        expect(item.description).not.toContain("Resolved");
      }
    }
  });
});
