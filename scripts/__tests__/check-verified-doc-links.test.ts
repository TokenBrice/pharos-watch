import { afterEach, describe, expect, it } from "vitest";

import { collectNavigationBlockViolations } from "../ci/check-verified-doc-links.ts";
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
