import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMethodologyChangelogMarkdown, buildMethodologyIndexMarkdown } from "../lib/methodology-to-markdown";
import {
  iterateDigestRoutes,
  iterateDocRoutes,
  iterateStablecoinRoutes,
  renderChangelogIndex,
  renderDigestDetail,
  renderDocMarkdown,
  renderDocsIndexMarkdown,
  renderStablecoinDetail,
} from "../lib/markdown-renderers";
import { writeMarkdownRoute } from "../maintenance/generate-markdown-exports";
import { changelogs } from "../../src/data/changelogs";
import digests from "../../data/digests.json";
import { PUBLIC_DOCS } from "@shared/lib/public-docs";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { makeCoverageCoin as coin } from "./helpers/coverage-coin";

afterEach(() => { vi.restoreAllMocks(); });


describe("writeMarkdownRoute", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pharos-md-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes markdown at <outDir><path>/index.md", () => {
    writeMarkdownRoute(tmpDir, {
      path: "/stablecoin/usdt-tether/",
      body: "# USDT\n\nBody content.\n",
    });

    const expected = join(tmpDir, "stablecoin", "usdt-tether", "index.md");
    expect(existsSync(expected)).toBe(true);
    expect(readFileSync(expected, "utf-8")).toBe("# USDT\n\nBody content.\n");
  });

  it("rejects paths not ending with slash", () => {
    expect(() =>
      writeMarkdownRoute(tmpDir, { path: "/docs/architecture", body: "x" }),
    ).toThrow(/trailing slash/i);
  });

  it("rejects paths containing traversal segments", () => {
    expect(() =>
      writeMarkdownRoute(tmpDir, { path: "/docs/../etc/", body: "x" }),
    ).toThrow(/path traversal/i);
  });
});

describe("methodology markdown", () => {
  it("produces front matter and section headings for /methodology/", () => {
    const md = buildMethodologyIndexMarkdown();
    expect(md).toMatch(/^---\ntitle: "Methodology/);
    expect(md).toContain("## Pricing Pipeline Methodology");
    expect(md).toContain("## Safety Scores Grading Methodology");
    expect(md).toContain('canonical: "https://pharos.watch/methodology/"');
  });

  it("renders changelog pages with version headings", () => {
    const md = buildMethodologyChangelogMarkdown("scoring");
    expect(md).toMatch(/^---\ntitle: "Safety Scores Changelog/);
    expect(md).toMatch(/## v\d+\.\d+/);
    expect(md).toContain('canonical: "https://pharos.watch/methodology/scoring-changelog/"');
  });
});


describe("stablecoin markdown", () => {
  it.each(["pre-launch", "quarantined", "delisted"] as const)("does not advertise active monitoring for %s", (status) => {
    const fixture = coin({ id: "inactive-fixture", status });
    if (status !== "pre-launch") fixture.listingStatusReview = {
      reason: "Explicit fixture listing reason.", changedAt: "2026-09-01",
    };
    vi.spyOn(TRACKED_META_BY_ID, "get").mockReturnValue(fixture);
    const md = renderStablecoinDetail(fixture.id, {});
    expect(md).toContain(`**Status:** ${status}`);
    expect(md).not.toContain("Live price, supply, peg, liquidity, and flow data are served by the Pharos API");
    expect(md).not.toContain("https://api.pharos.watch/api/stablecoin/");
    if (status === "pre-launch") expect(md).toContain("not available until launch");
    else {
      expect(md).toContain("Explicit fixture listing reason.");
      expect(md).toContain("historical reference");
    }
  });

  it("rejects unknown stablecoin identities", () => {
    expect(() => renderStablecoinDetail("unknown-fixture", {})).toThrow("Unknown stablecoin id: unknown-fixture");
  });

  it("renders USDT with front matter and contracts table", () => {
    const md = renderStablecoinDetail("usdt-tether");
    expect(md).toMatch(/^---\ntitle: "Tether \(USDT\) Stablecoin Analytics"/);
    expect(md).toContain('canonical: "https://pharos.watch/stablecoin/usdt-tether/"');
    expect(md).toContain("**Peg:** US Dollar");
    expect(md).toContain("## Contracts");
    expect(md).toContain("ethereum");
    expect(md).toContain("0xdac17f958d2ee523a2206206994597c13d831ec7");
  });

  it("falls back gracefully when summaries are missing", () => {
    const md = renderStablecoinDetail("xsgd-straitsx", {});
    expect(md).toContain("XSGD");
    expect(md).not.toMatch(/undefined/);
  });

  it("prints the unresolved fallback for registered claim tokens instead of raw placeholders", () => {
    const md = renderStablecoinDetail("xsgd-straitsx", {
      "xsgd-straitsx": {
        title: "Summary",
        text: "Holds a {{grade}} grade.",
        updatedAt: "2026-09-01",
        claimTokens: [{ token: "grade", placeholder: "{{grade}}", source: "report-card.grade", factsAsOf: "2026-09-01" }],
      },
    });
    expect(md).toContain("Holds a N/A grade.");
    expect(md).not.toContain("{{grade}}");
  });

  it("iterates unique routes with matching profiles for a small registry", () => {
    const fixtures = new Map(["first-fixture", "second-fixture"].map((id) => [id, coin({ id, name: id })]));
    vi.spyOn(TRACKED_META_BY_ID, "entries").mockImplementation(() => fixtures.entries());
    vi.spyOn(TRACKED_META_BY_ID, "get").mockImplementation((id) => fixtures.get(id));
    const routes = [...iterateStablecoinRoutes()];
    expect(routes.map((route) => route.path)).toEqual(["/stablecoin/first-fixture/", "/stablecoin/second-fixture/"]);
    for (const route of routes) expect(route.body).toContain(`canonical: "https://pharos.watch${route.path}"`);
  });
});

describe("changelog and digest markdown", () => {
  it("emits one changelog heading per entry", () => {
    const md = renderChangelogIndex(changelogs);
    expect(md).toMatch(/^---\ntitle: "Changelog: What's New on Pharos"/);
    expect(md).toContain('canonical: "https://pharos.watch/changelog/"');
    expect(md.match(/^## /gm)).toHaveLength(changelogs.length);
  });

  it("renders digest detail pages", () => {
    const latest = digests[0] as Parameters<typeof renderDigestDetail>[0];
    const md = renderDigestDetail(latest);
    expect(md).toContain(`canonical: "https://pharos.watch/digest/${latest.date}/"`);
    expect(md).toContain("## Executive Summary");
    expect(md).toContain(latest.text.slice(0, 30));
  });

  it("integrates the digest corpus without duplicate routes or mismatched bodies", () => {
    const paths = new Set<string>();
    for (const route of iterateDigestRoutes()) {
      expect(paths.has(route.path)).toBe(false);
      paths.add(route.path);
      expect(route.body).toContain(`canonical: "https://pharos.watch${route.path}"`);
    }
    expect([...paths]).toEqual(digests.map((digest) => `/digest/${digest.date}/`));
  });
});

describe("docs markdown", () => {
  it("prepends front matter to public docs", () => {
    const apiDoc = PUBLIC_DOCS.find((doc) => doc.slug === "api-reference");
    expect(apiDoc).toBeDefined();
    const md = renderDocMarkdown(apiDoc!);
    expect(md).toMatch(/^---\ntitle: "API Reference/);
    expect(md).toContain('canonical: "https://pharos.watch/docs/api-reference/"');
    expect(md).toContain("# Pharos API Reference");
  });

  it("renders the docs index with one route per public doc plus index", () => {
    const md = renderDocsIndexMarkdown();
    expect(md).toContain('canonical: "https://pharos.watch/docs/"');
    expect(md).toContain("# Documentation");
    const apiDoc = PUBLIC_DOCS.find((doc) => doc.slug === "api-reference")!;
    vi.spyOn(PUBLIC_DOCS, Symbol.iterator).mockImplementation(() => [apiDoc][Symbol.iterator]());
    const routes = [...iterateDocRoutes()];
    expect(routes.map((route) => route.path)).toEqual(["/docs/", "/docs/api-reference/"]);
    for (const route of routes) expect(route.body).toContain(`canonical: "https://pharos.watch${route.path}"`);
  });
});
