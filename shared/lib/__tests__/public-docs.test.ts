
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLIC_DOCS, preparePublicDocMarkdown } from "../public-docs";

const DOCS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs");
const DOC_SOURCES = PUBLIC_DOCS.map((doc) => ({
  doc,
  body: readFileSync(join(DOCS_DIR, doc.source), "utf-8"),
}));

describe("PUBLIC_DOCS registry", () => {
  it("publishes the Blacklist Tracker methodology with matching source and metadata", () => {
    expect(PUBLIC_DOCS.find((doc) => doc.slug === "blacklist-tracker")).toEqual({
      source: "blacklist-tracker.md",
      slug: "blacklist-tracker",
      title: "Blacklist Tracker",
      summary:
        "Blacklist Tracker methodology for stablecoin freezes, releases, wipes, event coverage, frozen-balance valuation, and direct versus upstream exposure.",
      group: "methodology",
    });
  });

  it("rewrites or removes non-public relative links before publication", () => {
    for (const { body } of DOC_SOURCES) {
      const rendered = preparePublicDocMarkdown(body, { absoluteLinks: true });
      expect(rendered).not.toMatch(/\]\((?:\.\.?\/|[^:/)#]+\.md)/);
      expect(rendered).not.toMatch(/agents\/|AGENTS\.md|\.claude|TODO|FIXME|runbook/i);
    }
  });
});
