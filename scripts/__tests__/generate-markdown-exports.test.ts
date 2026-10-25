import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMethodologyChangelogMarkdown, buildMethodologyIndexMarkdown } from "../lib/methodology-to-markdown";
import {
  iterateStablecoinRoutes,
  renderChangelogIndex,
  renderStablecoinDetail,
} from "../lib/markdown-renderers";
import { writeMarkdownRoute } from "../maintenance/generate-markdown-exports";
import { changelogs } from "../../src/data/changelogs";
import { CHANGELOG_MONTH_ARCHIVES, RECENT_CHANGELOGS } from "../../src/lib/changelog-history";
import { METHODOLOGY_HISTORY_ARCHIVES } from "@shared/lib/methodology-versions/archives";

import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { makeCoverageCoin as coin } from "./helpers/coverage-coin";

// Pin the release grade and date so the byte fixture does not move with each data refresh.
vi.mock("../../src/lib/datasets/public-dataset-current", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/datasets/public-dataset-current")>()),
  PUBLIC_DATASET_CURRENT_DATE: "2026-10-22",
}));
vi.mock("../../src/lib/safety-grade-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/safety-grade-snapshot")>()),
  getSnapshotSafetyAssessment: (id: string) => (id === "usdt-tether" ? { grade: "A", score: 83, bucket: "safe" } : null),
  formatSnapshotSafetyScoreLabel: (id: string) => (id === "usdt-tether" ? "Safety Score A (83/100) as of 2026-10-22" : null),
}));

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

  it("withholds registered live claims instead of asserting unavailable grades", () => {
    const md = renderStablecoinDetail("xsgd-straitsx", {
      "xsgd-straitsx": {
        title: "Summary",
        text: "Holds a {{grade}} grade.",
        updatedAt: "2026-09-01",
        claimTokens: [{ token: "grade", placeholder: "{{grade}}", source: "report-card.grade", factsAsOf: "2026-09-01" }],
      },
    });
    expect(md).toContain("The current Safety Score and live assessment are available on the interactive page.");
    expect(md).not.toContain("Holds a N/A grade.");
    expect(md).not.toContain("{{grade}}");
  });

  it("leads the overview with the dated release grade and appends the profile quick answers", () => {
    const md = renderStablecoinDetail("usdt-tether", {
      "usdt-tether": {
        title: "Summary",
        text: "Holds a {{grade}} grade.",
        updatedAt: "2026-09-01",
        claimTokens: [{ token: "grade", placeholder: "{{grade}}", source: "report-card.grade", factsAsOf: "2026-09-01" }],
      },
    });
    expect(md).toContain(
      "## Overview\n\nUSDT held Safety Score A (83/100) as of 2026-10-22 in Pharos's scores-latest release dataset. "
      + "The current Safety Score and live assessment are available on the interactive page.",
    );
    expect(md).toContain("## Quick answers\n\n### What is Tether (USDT)?");
    expect(md).toContain("### Is USDT safe?\n\nAs of Oct 22, 2026, Pharos grades USDT A (83/100) on its Safety Score.");
    expect(md.indexOf("## Quick answers")).toBeLessThan(md.indexOf("## Live Data"));
  });

  it("omits the grade for unrated coins and quick answers for pre-launch profiles", () => {
    const fixture = coin({ id: "pre-launch-fixture", status: "pre-launch" });
    vi.spyOn(TRACKED_META_BY_ID, "get").mockReturnValue(fixture);
    const md = renderStablecoinDetail(fixture.id, {});
    expect(md).not.toContain("## Overview");
    expect(md).not.toContain("## Quick answers");
  });

  it("retains glossary labels without exporting internal markup", () => {
    const md = renderStablecoinDetail("xsgd-straitsx", {
      "xsgd-straitsx": {
        title: "Summary",
        text: "Holders use {{term:redemption}}redemption{{/term}} at par.",
        updatedAt: "2026-09-01",
      },
    });
    expect(md).toContain("Holders use redemption at par.");
    expect(md).not.toContain("{{");
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
    ["changelog-index.md", () => renderChangelogIndex()],
    ["methodology-index.md", () => buildMethodologyIndexMarkdown()],
    ["stablecoin-usdt-tether.md", () => renderStablecoinDetail("usdt-tether")],
  ] as const)("preserves exported bytes for %s", (name, render) => {
    expect(render()).toBe(readFileSync(new URL(`./fixtures/markdown/${name}`, import.meta.url), "utf8"));
  });
});

describe("partitioned history Markdown", () => {
  it("links every monthly archive while limiting full release bodies to recent weeks", () => {
    const markdown = renderChangelogIndex();
    for (const archive of CHANGELOG_MONTH_ARCHIVES) expect(markdown).toContain(`https://pharos.watch${archive.path}`);
    for (const entry of RECENT_CHANGELOGS) expect(markdown).toContain(entry.summary[0].description);
    const oldest = changelogs.at(-1)!;
    expect(markdown).not.toContain(oldest.summary[0].description);
    const archive = CHANGELOG_MONTH_ARCHIVES.at(-1)!;
    const body = renderChangelogIndex(archive.entries, archive.path);
    expect(body).toContain(`canonical: "https://pharos.watch${archive.path}"`);
    expect(body).toContain(oldest.summary[0].description);
  });

  it("exports every methodology archive with its own canonical and complete structured body", () => {
    for (const archive of METHODOLOGY_HISTORY_ARCHIVES) {
      const markdown = buildMethodologyChangelogMarkdown(archive.changelog.markdownKey, archive.archive);
      expect(markdown).toContain(`canonical: "https://pharos.watch${archive.path}"`);
      for (const entry of archive.entries) {
        expect(markdown).toContain(entry.summary);
        expect(markdown).toContain(entry.title);
        for (const impact of entry.impact) expect(markdown).toContain(impact);
        for (const sha of entry.commits) expect(markdown).toContain(sha);
      }
    }
    expect(() => buildMethodologyChangelogMarkdown("scoring", "v999")).toThrow("Unknown methodology archive");
  });
});
