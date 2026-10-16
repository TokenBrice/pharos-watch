import { afterEach, describe, expect, it } from "vitest";

import { collectAdrNavigationViolations, collectLinkViolations, collectNavigationBlockViolations } from "../ci/check-verified-doc-links.ts";
import { createTempRepoTracker } from "./helpers/test-state";

const { cleanup, makeRoot, writeText } = createTempRepoTracker("pharos-doc-navigation");

afterEach(cleanup);

describe("verified documentation navigation blocks", () => {
  it("rejects a 400-line fixture without a top navigation block", () => {
    const root = makeRoot();
    writeText(root, "docs/large.md", Array.from({ length: 400 }, (_, index) => `line ${index + 1}`).join("\n"));

    expect(collectNavigationBlockViolations([`${root}/docs/large.md`], root)).toEqual([
      "docs/large.md: docs at or above 400 lines or 50 KB must include a top `> **Agent navigation**` block (docs/README.md#documentation-rules)",
    ]);
  });

  it("accepts a qualifying fixture with the navigation block near the top", () => {
    const root = makeRoot();
    writeText(
      root,
      "docs/large.md",
      ["# Large Doc", "", "> **Agent navigation** — Overview · Details.", ...Array(397).fill("content")].join("\n"),
    );

    expect(collectNavigationBlockViolations([`${root}/docs/large.md`], root)).toEqual([]);
  });

  it("rejects a 50 KB fixture even when it has fewer than 400 lines", () => {
    const root = makeRoot();
    writeText(root, "docs/wide.md", `# Wide Doc\n\n${"x".repeat(50 * 1024)}`);

    expect(collectNavigationBlockViolations([`${root}/docs/wide.md`], root)).toEqual([
      "docs/wide.md: docs at or above 400 lines or 50 KB must include a top `> **Agent navigation**` block (docs/README.md#documentation-rules)",
    ]);
  });
});

describe("architectural decision quick-nav", () => {
  const quickNav = "Read an individual decision rather than the entire record collection:";

  it("rejects a heading missing from quick-nav even when linked elsewhere", () => {
    const content = [
      `${quickNav} [ADR-1](#adr-1).`,
      "#### ADR-1",
      "#### ADR-5",
      "A related decision: [ADR-5](#adr-5).",
    ].join("\n");
    expect(collectAdrNavigationViolations(content)).toEqual([
      "docs/architecture.md: ADR-5 heading is missing from the ADR quick-nav",
    ]);
  });

});

describe("rendered documentation links", () => {
  it("validates angle-delimited, titled and reference links against actual headings", () => {
    const root = makeRoot();
    writeText(root, "docs/target.md", "# A & B\n\n# A & B");
    writeText(root, "docs/source.md", '[one](<target.md#a--b> "Title")\n\n[two][ref]\n\n[ref]: target.md#a--b-1 "Title"');
    expect(collectLinkViolations([`${root}/docs/source.md`], root)).toEqual([]);
    writeText(root, "docs/source.md", "[bad](target.md#a-b)\n\n[missing][ref]\n\n[ref]: absent.md");
    const errors = collectLinkViolations([`${root}/docs/source.md`], root);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('missing heading anchor "#a-b"');
    expect(errors[1]).toContain("target file does not exist");
  });

});
