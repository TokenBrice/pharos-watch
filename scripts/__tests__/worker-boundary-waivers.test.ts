import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("worker boundary waivers", () => {
  it("keeps the cross-layer waiver set minimal and documented", () => {
    const checker = readFileSync(resolve(process.cwd(), "scripts/check-worker-import-boundary.mjs"), "utf8");
    const frozenInvariantCheck = readFileSync(resolve(process.cwd(), "scripts/check-frozen-invariants.ts"), "utf8");
    const waiverFiles = [...checker.matchAll(/file:\s+"([^"]+)"/g)].map((match) => match[1]);

    expect(waiverFiles).toEqual(["scripts/check-frozen-invariants.ts"]);
    expect(checker).toContain("frozen-invariants-lifecycle-registry-check");
    expect(frozenInvariantCheck).toContain("Boundary waiver: frozen-invariants-lifecycle-registry-check");
  });
});
