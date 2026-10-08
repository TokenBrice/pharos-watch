import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertPinnedRuntime } from "../lib/runtime-guard.mts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixtureRoot(pin = "24.16.0"): string {
  const root = mkdtempSync(join(tmpdir(), "pharos-runtime-"));
  roots.push(root);
  writeFileSync(join(root, ".nvmrc"), `${pin}\n`);
  return root;
}

describe("pinned readiness runtime", () => {
  it("accepts the exact Node pin and any npm 11 patch", () => {
    expect(() => assertPinnedRuntime({ node: "v24.16.0", npm: "11.99.2" }, fixtureRoot())).not.toThrow();
  });

  it.each(["26.10.0", "24.16.1", "25.0.0"])("rejects Node %s before readiness", (node) => {
    expect(() => assertPinnedRuntime({ node, npm: "11.13.0" }, fixtureRoot()))
      .toThrow(/Node 24\.16\.0 exactly.*mise settings add idiomatic_version_file_enable_tools node && mise install/);
  });

  it.each(["12.2.0", "10.9.0", "unknown"])("rejects npm %s with provisioning guidance", (npm) => {
    expect(() => assertPinnedRuntime({ node: "24.16.0", npm }, fixtureRoot()))
      .toThrow(/npm 11\.x.*mise.*mise install/);
  });

  it("reads the Node authority from the checkout rather than a duplicated constant", () => {
    expect(() => assertPinnedRuntime({ node: "24.16.0", npm: "11.13.0" }, fixtureRoot("24.17.0")))
      .toThrow(/requires Node 24\.17\.0 exactly/);
  });
});
