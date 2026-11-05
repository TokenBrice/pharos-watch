import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildMethodologyChangelogMarkdown, buildMethodologyIndexMarkdown } from "../lib/methodology-to-markdown";
import {
  iterateStablecoinRoutes,
  renderChangelogIndex,
  renderStablecoinDetail,
} from "../lib/markdown-renderers";
import { writeMarkdownRoute } from "../maintenance/generate-markdown-exports";
import { MARKDOWN_FIXTURE_RELEASE } from "../lib/markdown-fixture-release";
import { buildStablecoinFaqItems } from "../../src/components/stablecoin-detail/static-seo-content";
import { ContractDeployments } from "../../src/components/stablecoin-detail/contract-deployments";
import { getCurrentRedemptionConfig } from "../../src/lib/redemption-review-currency";
import { changelogs } from "../../src/data/changelogs";
import { CHANGELOG_MONTH_ARCHIVES, RECENT_CHANGELOGS } from "../../src/lib/changelog-history";
import { getListedDefinitions } from "../../src/lib/definitions";
import { METHODOLOGY_INDEX_SECTION_CONTENT } from "../../src/lib/methodology-content";
import { REDEMPTION_BACKSTOP_CONFIGS } from "@shared/lib/redemption-backstop-configs";
import { V9_REVIEW_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/evidence";
import { METHODOLOGY_HISTORY_ARCHIVES } from "@shared/lib/methodology-versions/archives";

import { CHAIN_META } from "@shared/types/chain-identity";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { StablecoinAiSummary, StablecoinMeta } from "@shared/types";
import { makeCoverageCoin as coin } from "./helpers/coverage-coin";

// Contract parity only needs text rows.
vi.mock("next/image", () => ({ default: () => null }));

const claimedSummary: StablecoinAiSummary = {
  title: "Summary", text: "Holds a {{grade}} grade.", updatedAt: "2026-09-01",
  claimTokens: [{ token: "grade", placeholder: "{{grade}}", source: "report-card.grade", factsAsOf: "2026-09-01" }],
};

afterEach(() => { vi.restoreAllMocks(); });

/** Extract a heading and its body, stopping at the next peer or parent heading. */
function markdownSection(markdown: string, heading: string): string {
  const start = markdown.indexOf(heading);
  if (start < 0) return "";
  const offset = start + heading.length;
  const next = markdown.slice(offset).search(heading.startsWith("###") ? /\n##{2,3} / : /\n## /);
  return markdown.slice(start, next < 0 ? undefined : offset + next);
}

/** HTML and Markdown must expose every exact chain/address pair. */
function expectContractParity(meta: StablecoinMeta) {
  const contracts = meta.contracts ?? [];
  const markdown = renderStablecoinDetail(meta.id, {});
  const markdownRows = markdownSection(markdown, "## Contracts")
    .split("\n")
    .filter((line) => line.startsWith("| ") && !line.startsWith("| Chain") && !line.startsWith("| ---"));
  const markdownPairs = markdownRows.map((row) => {
    const match = row.match(/^\| ([^|]+) \| `([^`]+)` \|/);
    expect(match, row).not.toBeNull();
    return `${match![1]}|${match![2]}`;
  });
  expect(markdownPairs.sort()).toEqual(contracts.map((c) => `${c.chain}|${c.address}`).sort());
  expect(new Set(markdownPairs).size).toBe(contracts.length);

  const html = renderToStaticMarkup(
    createElement(ContractDeployments, { coinId: meta.id, contracts }),
  );
  const list = html.slice(html.indexOf("<ul"), html.indexOf("</ul>") + "</ul>".length);
  const htmlRows = [...list.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map(([, text]) => text);
  expect(htmlRows.sort()).toEqual(contracts.map((c) => `${CHAIN_META[c.chain]?.name ?? c.chain} ${c.address}`).sort());
}


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
    expect(md).not.toContain("## Public snapshots");
    if (status === "pre-launch") expect(md).toContain("not available until launch");
    else {
      expect(md).toContain("Explicit fixture listing reason.");
      expect(md).toContain("historical reference");
    }
  });

  it("states a launched pre-launch row as live with unavailable data, not awaiting launch", () => {
    const fixture = coin({ id: "launched-fixture", status: "pre-launch" });
    fixture.launchPhase = "launched";
    fixture.listingStatusReview = { reason: "No admitted price lane yet.", changedAt: "2026-10-20", reviewBy: "2026-12-19" };
    vi.spyOn(TRACKED_META_BY_ID, "get").mockReturnValue(fixture);
    const md = renderStablecoinDetail(fixture.id, {});
    expect(md).toContain("has launched, but Pharos has not yet admitted a price and supply source. No admitted price lane yet.");
    expect(md).toContain("unavailable, not zero");
    expect(md).not.toContain("not available until launch");
    expect(md).not.toContain("## Public snapshots");
  });

  it("withholds registered live claims instead of asserting unavailable grades", () => {
    const md = renderStablecoinDetail("xsgd-straitsx", { "xsgd-straitsx": claimedSummary });
    expect(md).toContain("The current Safety Score and live assessment are available on the interactive page.");
    expect(md).not.toContain("Holds a N/A grade.");
    expect(md).not.toContain("{{grade}}");
  });

  it.each(["usdt-tether", "usdc-circle"] as const)("puts Quick answers and reviewed Sources before Contracts for %s", (id) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(`${REDEMPTION_BACKSTOP_CONFIGS[id].reviewedAt}T12:00:00Z`));
      const tracked = TRACKED_META_BY_ID.get(id)!;
      const md = renderStablecoinDetail(id, {});
      expect(md.indexOf("## Quick answers")).toBeLessThan(md.indexOf("## Sources"));
      expect(md.indexOf("## Sources")).toBeLessThan(md.indexOf("## Contracts"));

      expectContractParity(tracked);

      const reserveSources = markdownSection(md, "### Reserve sources");
      const links = [
        ...(tracked.reserveReview?.sources ?? []),
        ...(tracked.proofOfReserves?.latestReport?.sources ?? []),
        { url: tracked.proofOfReserves!.url, label: "Reserve source" },
      ];
      for (const { url, label } of links.filter((link, i) => links.findIndex(({ url }) => url === link.url) === i)) {
        expect(reserveSources.split(`(<${url}>)`).length - 1).toBe(1);
        expect(reserveSources).toContain(label);
      }

      const redemptionSources = markdownSection(md, "### Redemption sources");
      const docs = getCurrentRedemptionConfig(id)?.docs ?? [];
      expect(docs.length).toBeGreaterThan(0);
      for (const doc of docs) expect(redemptionSources).toContain(doc.url);

      // Facts stay the shared HTML/FAQ builder's, not a second Markdown copy.
      for (const item of buildStablecoinFaqItems(tracked)) expect(md).toContain(item.answer);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a same-chain pair and a native denomination in HTML/Markdown parity", () => {
    const fixture = coin({ id: "contract-parity-fixture" });
    fixture.contracts = [
      { chain: "base", address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", decimals: 18 },
      { chain: "base", address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", decimals: 6 },
      { chain: "kava", address: "factory/inj1abc:denom/inj1def", decimals: null, kind: "native-denom" },
    ] as NonNullable<StablecoinMeta["contracts"]>;
    vi.spyOn(TRACKED_META_BY_ID, "get").mockReturnValue(fixture);

    expectContractParity(fixture);
  });

  it("renders a deduplicated Sources module only when reviewed links exist", () => {    const fixture = coin({ id: "sources-fixture" });
    vi.spyOn(TRACKED_META_BY_ID, "get").mockReturnValue(fixture);
    const withoutSources = renderStablecoinDetail(fixture.id, {});
    expect(withoutSources).not.toContain("## Sources");
    expect(withoutSources).not.toContain("### Reserve sources");

    fixture.reserveReview = {
      sources: [
        { label: "Reserve review [draft]", url: "https://example.com/report#page-2" },
        { label: "Repeated reserve review", url: "https://example.com/report#page-2" },
        { label: "Back\\slash (parentheses) [brackets]\nnewline", url: "https://example.com/report?x=1&y=<2>" },
      ],
    } as unknown as NonNullable<StablecoinMeta["reserveReview"]>;
    fixture.contracts = [{ chain: "ethereum", address: "0xfixture", decimals: 6 }];

    const md = renderStablecoinDetail(fixture.id, {});
    const sources = markdownSection(md, "## Sources");
    expect(sources).toContain("- [Reserve review \\[draft\\]](<https://example.com/report#page-2>)");
    expect(sources).not.toContain("Repeated reserve review");
    expect(sources.match(/https:\/\/example\.com\/report#page-2/g)).toHaveLength(1);
    expect(sources).toContain(
      "- [Back\\\\slash (parentheses) \\[brackets\\] newline](<https://example.com/report?x=1&y=%3C2%3E>)",
    );
    expect(sources).not.toContain("### Redemption sources");
    expect(md.indexOf("## Sources")).toBeLessThan(md.indexOf("## Contracts"));
  });

  it.each([
    ["examination", "Examination"],
    ["audit", "Audit"],
    ["unknown", "Independent Report"],
    [null, "Independent Report"],
  ] as const)("renders the reviewed %s engagement in the Markdown backing answer", (method, label) => {
    const latestReport = method
      ? {
          periodEnd: "2026-08-31",
          publishedAt: "2026-09-05",
          assuranceMethod: method,
          scope: "assets-and-liabilities" as const,
          liabilityReconciliation: "full" as const,
          reviewer: "test",
          confidence: "verified" as const,
          sources: [{ label: "Report", url: "https://example.com/report" }],
        }
      : undefined;
    const fixture = coin({ id: `assurance-${method ?? "absent"}` });
    fixture.proofOfReserves = {
      type: "independent-audit",
      url: "https://example.com/reserves",
      provider: "Example Auditor",
      ...(latestReport ? { latestReport } : {}),
    } as StablecoinMeta["proofOfReserves"];
    vi.spyOn(TRACKED_META_BY_ID, "get").mockReturnValue(fixture);

    const md = renderStablecoinDetail(fixture.id, {}, MARKDOWN_FIXTURE_RELEASE);
    const backingAnswer = buildStablecoinFaqItems(fixture, MARKDOWN_FIXTURE_RELEASE)[2].answer;
    if (method) expect(backingAnswer).toContain("latest period ending Aug 31, 2026");
    expect(backingAnswer).not.toContain(MARKDOWN_FIXTURE_RELEASE.snapshotDate);
    expect(backingAnswer).toContain(`Reserve evidence: ${label} by Example Auditor`);
    // Markdown inherits the same shared answer instead of a second formatter.
    expect(md).toContain(backingAnswer);
    expect(md).not.toContain("Independent Audit");
  });

  it("exports reviewed redemption sources only while the route is current", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const reviewed = Date.parse(`${REDEMPTION_BACKSTOP_CONFIGS["usdt-tether"].reviewedAt}T00:00:00Z`);
      vi.setSystemTime(reviewed);
      const current = renderStablecoinDetail("usdt-tether", {});
      expect(current).toContain("### Redemption sources");
      expect(current).toContain("### How do you redeem USDT?");

      vi.setSystemTime(reviewed + (V9_REVIEW_EVIDENCE_MAX_AGE_SEC + 1) * 1_000);
      const expired = renderStablecoinDetail("usdt-tether", {});
      expect(expired).not.toContain("### Redemption sources");
      expect(expired).not.toContain("How do you redeem USDT?");
      // The reserve evidence is reviewed catalog data, not an ageing route.
      expect(expired).toContain("### Reserve sources");
      expect(expired).not.toContain("https://api.pharos.watch/api/stablecoin/");
    } finally {
      vi.useRealTimers();
    }
  });

  it("points the dated snapshot handoff at generated files and latest rewrites", async () => {
    const actual = await vi.importActual<typeof import("../../src/lib/datasets/public-dataset-current")>(
      "../../src/lib/datasets/public-dataset-current",
    );
    const md = renderStablecoinDetail("usdt-tether", {});
    expect(md).toContain('canonical: "https://pharos.watch/stablecoin/usdt-tether/"');
    expect(md).not.toContain("https://api.pharos.watch/api/stablecoin/");
    const redirects = readFileSync(new URL("../../public/_redirects", import.meta.url), "utf8");
    for (const topic of ["top-stablecoins", "scores-latest", "depeg-history"]) {
      const dated = `/datasets/${topic}/${actual.PUBLIC_DATASET_CURRENT_DATE}.json`;
      expect(md).toContain(`https://pharos.watch${dated}`);
      expect(existsSync(new URL(`../../public${dated}`, import.meta.url))).toBe(true);
      expect(redirects).toContain(`/datasets/${topic}/latest.json ${dated} 200`);
    }
  });

  it("keeps archived wording while sharing the bounded snapshot handoff", () => {
    const frozen = coin({ id: "frozen-snapshot-fixture", status: "frozen" });
    vi.spyOn(TRACKED_META_BY_ID, "get").mockReturnValue(frozen);
    const md = renderStablecoinDetail(frozen.id, {});
    expect(md).toContain("frozen Pharos archive");
    expect(md).toContain("## Public snapshots");
    expect(md).not.toContain("Live price, supply, peg, liquidity, and flow data are served by the Pharos API");
    expect(md).not.toContain("currently monitored");
    expect(md).not.toContain("https://api.pharos.watch/api/stablecoin/");
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

describe("fixed Markdown renderer examples", () => {
  const expected = (name: string) => readFileSync(new URL(`./fixtures/markdown/${name}.md`, import.meta.url), "utf8");

  it("pins changelog archive bytes for a fixed week", () => {
    expect(renderChangelogIndex([{
      dateRange: { from: "2026-01-05", to: "2026-01-11" }, headline: "A fixed release.",
      summary: [{ label: "Exports", description: "Markdown examples.", tag: "feature" }],
      stats: { totalCommits: 1 }, commits: [{ hash: "abcdef0", message: "Add exports" }],
    }], "/changelog/2026-01/")).toBe(expected("changelog-index"));
  });

  it("pins synthetic profile bytes and grade order", () => {
    const fixture = coin({ id: "fixture-dollar", name: "Fixture Dollar", symbol: "FIX",
      contracts: [{ chain: "ethereum", address: "0xfixture", decimals: 6 }],
    });
    vi.spyOn(TRACKED_META_BY_ID, "get").mockReturnValue(fixture);
    const release = { ...MARKDOWN_FIXTURE_RELEASE,
      assessments: { [fixture.id]: MARKDOWN_FIXTURE_RELEASE.assessments["usdt-tether"] } };
    expect(renderStablecoinDetail(fixture.id, { [fixture.id]: claimedSummary }, release)).toBe(expected("stablecoin-usdt-tether"));
  });

  it("pins isolated methodology sections and definitions", async () => {
    vi.resetModules();
    vi.doMock("../../src/lib/methodology-content", () => ({
      METHODOLOGY_INDEX_SECTION_CONTENT: [{ markdown: "## Example\n\nFixed methodology.\n" }, { markdown: "## Scope\n\nFixed scope.\n" }],
    }));
    vi.doMock("../../src/lib/definitions", () => ({
      getListedDefinitions: () => [{ term: "Example", text: "A fixed definition." }, { term: "Scope", text: "A fixed boundary." }],
    }));
    try {
      const { buildMethodologyIndexMarkdown: render } = await import("../lib/methodology-to-markdown");
      expect(render()).toBe(expected("methodology-index"));
    } finally {
      vi.doUnmock("../../src/lib/methodology-content");
      vi.doUnmock("../../src/lib/definitions");
      vi.resetModules();
    }
  });
});

describe("public llms index", () => {
  it("lists the compliance page and both snapshot datasets with their scope", () => {
    const llms = readFileSync(new URL("../../public/llms.txt", import.meta.url), "utf8");
    expect(llms).toContain(
      "- [Compliance](https://pharos.watch/compliance/): MiCA and GENIUS Act status, applicability, pathway and disclosure evidence from reviewed records.",
    );
    expect(llms).toContain(
      "- [Safety Scores dataset (JSON)](https://pharos.watch/datasets/scores-latest/latest.json): Dated release snapshot of grades and score fields; source dates and scope are recorded in the file.",
    );
    expect(llms).toContain(
      "- [Depeg history dataset (JSON)](https://pharos.watch/datasets/depeg-history/latest.json): Retrospective depeg-event snapshot with source dates and historical coverage; current depegs are shown on the Depeg Tracker.",
    );
  });
});

describe("partitioned history Markdown", () => {
  it("includes live methodology sections, definitions and canonical front matter", () => {
    const md = buildMethodologyIndexMarkdown();
    expect(md).toMatch(/^---\ntitle: "Methodology:/);
    expect(md).toContain('canonical: "https://pharos.watch/methodology/"');
    for (const section of METHODOLOGY_INDEX_SECTION_CONTENT) expect(md).toContain(section.markdown.trimEnd());
    for (const def of getListedDefinitions()) expect(md).toContain(`- **${def.term}**: ${def.text}`);
  });

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
