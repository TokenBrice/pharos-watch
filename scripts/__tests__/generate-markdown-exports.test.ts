/* eslint-disable security/detect-non-literal-fs-filename -- tests read temporary files and checked-in fixtures only. */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
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
import { writeMarkdownRoute } from "../generate-markdown-exports";
import { changelogs } from "../../src/data/changelogs";
import digests from "../../data/digests.json";
import { PUBLIC_DOCS } from "../../shared/lib/public-docs";
import { TRACKED_STABLECOINS } from "../../shared/lib/stablecoins";

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

  it("iterates one route per tracked stablecoin", () => {
    expect(Array.from(iterateStablecoinRoutes())).toHaveLength(TRACKED_STABLECOINS.length);
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

  it("iterates one route per digest", () => {
    expect(Array.from(iterateDigestRoutes())).toHaveLength(digests.length);
  });
});

describe("docs markdown", () => {
  it("prepends front matter to public docs", () => {
    const md = renderDocMarkdown(PUBLIC_DOCS[0]);
    expect(md).toMatch(/^---\ntitle: "Architecture/);
    expect(md).toContain('canonical: "https://pharos.watch/docs/architecture/"');
    expect(md).toContain("# Architecture");
  });

  it("renders the docs index with one route per public doc plus index", () => {
    const md = renderDocsIndexMarkdown();
    expect(md).toContain('canonical: "https://pharos.watch/docs/"');
    expect(md).toContain("# Documentation");
    expect(Array.from(iterateDocRoutes())).toHaveLength(PUBLIC_DOCS.length + 1);
  });
});
