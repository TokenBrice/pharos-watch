import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const checkerPath = resolve(process.cwd(), "scripts/ci/check-worker-import-boundary.ts");
const docPath = resolve(process.cwd(), "docs/process/boundary-waivers.md");
const frozenInvariantPath = resolve(process.cwd(), "scripts/ci/check-frozen-invariants.ts");

function parseWaivers(checkerSource: string): { id: string; file: string }[] {
  const ids = [...checkerSource.matchAll(/id:\s+"([^"]+)"/g)].map((match) => match[1]);
  const files = [...checkerSource.matchAll(/file:\s+"([^"]+)"/g)].map((match) => match[1]);
  expect(ids.length).toBe(files.length);
  return ids.map((id, index) => ({ id, file: files[index] }));
}

function parseMaxWaivers(checkerSource: string): number {
  const match = checkerSource.match(/MAX_BOUNDARY_WAIVERS\s*=\s*(\d+)/);
  expect(match).not.toBeNull();
  return Number(match![1]);
}

describe("worker boundary waivers", () => {
  const checker = readFileSync(checkerPath, "utf8");
  const doc = readFileSync(docPath, "utf8");
  const frozenInvariantCheck = readFileSync(frozenInvariantPath, "utf8");
  const waivers = parseWaivers(checker);
  const maxWaivers = parseMaxWaivers(checker);

  it("keeps the cross-layer waiver set capped at the documented maximum", () => {
    expect(waivers.length).toBeLessThanOrEqual(maxWaivers);
  });

  it("matches the published frozen-invariant waiver fingerprint", () => {
    expect(waivers).toEqual([
      { id: "frozen-invariants-lifecycle-registry-check", file: "scripts/ci/check-frozen-invariants.ts" },
    ]);
    expect(frozenInvariantCheck).toContain("Boundary waiver: frozen-invariants-lifecycle-registry-check");
  });

  it("documents every waiver in docs/process/boundary-waivers.md", () => {
    for (const waiver of waivers) {
      expect(doc, `waiver id missing from boundary-waivers.md: ${waiver.id}`).toContain(waiver.id);
      expect(doc, `waiver file missing from boundary-waivers.md: ${waiver.file}`).toContain(waiver.file);
    }
  });

  it("documents the cap in boundary-waivers.md", () => {
    expect(doc).toMatch(/MAX_BOUNDARY_WAIVERS\s*=\s*1/);
  });
});
