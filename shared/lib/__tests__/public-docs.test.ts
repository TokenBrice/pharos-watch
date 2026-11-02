
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

/** Code spans/fences and URLs are published verbatim; internal-vocabulary redaction applies to the rest. */
const PROTECTED_SEGMENT = /```[\s\S]*?```|`[^`\n]*`|https?:\/\/[^\s)<>]+/g;

function withoutProtectedSegments(markdown: string): string {
  return markdown.replace(PROTECTED_SEGMENT, "");
}

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
      expect(withoutProtectedSegments(rendered)).not.toMatch(/agents\/|AGENTS\.md|\.claude|TODO|FIXME|runbook/i);
    }
  });

  it("never rewrites link destinations, code spans, or fenced blocks", () => {
    for (const { body } of DOC_SOURCES) {
      const rendered = preparePublicDocMarkdown(body, { absoluteLinks: true });
      expect(rendered).not.toMatch(/\]\([^)\n]*\s[^)\n]*\)/);
      for (const url of body.match(/https?:\/\/[^\s)<>]+/g) ?? []) {
        expect(rendered).toContain(url);
      }
      for (const span of body.match(/`[^`\n]*`/g) ?? []) {
        expect(rendered).toContain(span);
      }
      expect(rendered).not.toMatch(/^#{1,6}.*\b(\w+) \1\b/im);
    }
  });
});
