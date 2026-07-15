/* eslint-disable security/detect-non-literal-fs-filename -- tests read checked-in public docs from the repository root only. */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOC_GROUPS, PUBLIC_DOCS, preparePublicDocMarkdown } from "../public-docs";

const DOCS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs");

describe("PUBLIC_DOCS registry", () => {
  it("contains the reviewed initial public set", () => {
    expect(PUBLIC_DOCS.length).toBe(21);
  });

  it("points every entry at an existing single-file markdown source", () => {
    for (const doc of PUBLIC_DOCS) {
      expect(doc.source).toMatch(/^[a-z0-9-]+\.md$/);
      expect(doc.source).not.toContain("..");
      expect(doc.source).not.toContain("/");
      expect(doc.source).not.toContain("\\");
      expect(existsSync(join(DOCS_DIR, doc.source))).toBe(true);
    }
  });

  it("keeps slugs unique and URL-safe", () => {
    const slugs = PUBLIC_DOCS.map((doc) => doc.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) {
      expect(slug).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("uses known groups and H1-led source files", () => {
    for (const doc of PUBLIC_DOCS) {
      expect(DOC_GROUPS).toContain(doc.group);
      const body = readFileSync(join(DOCS_DIR, doc.source), "utf-8");
      expect(body.trim()).toMatch(/^#\s+/);
    }
  });

  it("rewrites or removes non-public relative links before publication", () => {
    for (const doc of PUBLIC_DOCS) {
      const body = readFileSync(join(DOCS_DIR, doc.source), "utf-8");
      const rendered = preparePublicDocMarkdown(body, { absoluteLinks: true, source: doc.source });
      expect(rendered).not.toMatch(/\]\((?:\.\.?\/|[^:/)#]+\.md)/);
      expect(rendered).not.toMatch(/agents\/|AGENTS\.md|\.claude|TODO|FIXME|runbook/i);
      if (doc.source === "api-reference.md") {
        expect(rendered).not.toContain("## Admin Auth And Idempotency");
        expect(rendered).toContain("## Public Endpoints");
        expect(rendered).toContain("### `GET /api/stablecoins`");
        expect(rendered).not.toContain("## Admin Endpoints");
      }
    }
  });
});
