import { describe, expect, it } from "vitest";

import { runDocSyncChecks } from "../lib/doc-sync/checks";

describe("doc sync", () => {
  it("keeps the curated docs aligned with the source-of-truth values", () => {
    expect(runDocSyncChecks()).toEqual([]);
  });
});
