import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMethodologyIndexMarkdown } from "../lib/methodology-to-markdown";
import {
  iterateStablecoinRoutes,
  renderChangelogIndex,
  renderStablecoinDetail,
} from "../lib/markdown-renderers";
import { writeMarkdownRoute } from "../maintenance/generate-markdown-exports";
import { changelogs } from "../../src/data/changelogs";

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

  it("rejects paths containing traversal segments", () => {
    expect(() =>
      writeMarkdownRoute(tmpDir, { path: "/docs/../etc/", body: "x" }),
    ).toThrow(/path traversal/i);
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

describe("authored Markdown export fixtures", () => {
  it.each([
    ["changelog-index.md", () => renderChangelogIndex(changelogs)],
    ["methodology-index.md", () => buildMethodologyIndexMarkdown()],
    ["stablecoin-usdt-tether.md", () => renderStablecoinDetail("usdt-tether")],
  ] as const)("preserves exported bytes for %s", (name, render) => {
    expect(render()).toBe(readFileSync(new URL(`./fixtures/markdown/${name}`, import.meta.url), "utf8"));
  });
});
