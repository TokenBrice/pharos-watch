import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  extractGeneratedImportSpecifiers,
  resolveGeneratedSpecifier,
  runBootstrapRehearsal,
} from "../maintenance/run-bootstrap-rehearsal";

describe("bootstrap rehearsal generated imports", () => {
  it.each([0, 1])("accepts concrete snapshot ownership and restores original bytes after bootstrap status %s", async (status) => {
    const root = mkdtempSync(join(tmpdir(), "bootstrap-rehearsal-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const directory = join(root, "src/generated/stablecoin-detail-snapshots");
    const original = join(directory, "original.json");
    try {
      execFileSync("git", ["init"], { cwd: root, stdio: "pipe" });
      writeFileSync(join(root, ".gitignore"), "src/generated/\n.cache/\n");
      mkdirSync(directory, { recursive: true });
      writeFileSync(original, "original snapshot bytes\n");
      writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { "bootstrap:generated": "node fixture.cjs" } }));
      writeFileSync(join(root, "fixture.cjs"), `
        const fs = require('node:fs');
        fs.mkdirSync('src/generated/stablecoin-detail-snapshots', { recursive: true });
        fs.writeFileSync('src/generated/stablecoin-detail-snapshots/new.json', 'generated');
        process.exit(${status});
      `);
      if (status === 0) await expect(runBootstrapRehearsal({ repoRoot: root, argv: [] })).resolves.toBe(0);
      else await expect(runBootstrapRehearsal({ repoRoot: root, argv: [] })).rejects.toThrow(/bootstrap:generated failed/);
      expect(readFileSync(original, "utf8")).toBe("original snapshot bytes\n");
      expect(existsSync(join(directory, "new.json"))).toBe(false);
      expect(existsSync(join(root, ".cache/bootstrap-rehearsal"))).toBe(false);
    } finally {
      log.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("extracts static generated imports and ignores dynamic imports and unrelated modules", () => {
    const source = `
      import current from "@/generated/public-dataset-current";
      import type { Record } from "../generated/records";
      export { metadata } from "../../src/generated/docs-metadata.json";
      import local from "./local";
      const lazy = import("@/generated/lazy");
    `;

    expect(extractGeneratedImportSpecifiers(source)).toEqual([
      "@/generated/public-dataset-current",
      "../generated/records",
      "../../src/generated/docs-metadata.json",
    ]);
  });

  it("uses importer context to recognize only relative imports that enter src/generated", () => {
    const repoRoot = "/repo";
    const source = `
      import generated from "../generated/example";
      import local from "./local";
    `;

    expect(extractGeneratedImportSpecifiers(source, {
      importingFile: "/repo/src/components/example.ts",
      repoRoot,
    })).toEqual(["../generated/example"]);
  });

  it("resolves aliases and extensionless relative specifiers across supported extensions", () => {
    const repoRoot = "/repo";
    const existing = new Set([
      "/repo/src/generated/catalog.tsx",
      "/repo/src/generated/metadata.json",
    ]);
    const existsImpl = (path: string) => existing.has(path);

    expect(resolveGeneratedSpecifier("@/generated/catalog", {
      existsImpl,
      importingFile: "/repo/src/app/page.tsx",
      repoRoot,
    })).toBe("/repo/src/generated/catalog.tsx");
    expect(resolveGeneratedSpecifier("../generated/metadata.json", {
      existsImpl,
      importingFile: "/repo/src/components/card.tsx",
      repoRoot,
    })).toBe("/repo/src/generated/metadata.json");
  });

  it("returns null when a generated target does not exist or escapes src/generated", () => {
    const options = {
      existsImpl: () => false,
      importingFile: resolve("/repo/src/app/page.tsx"),
      repoRoot: "/repo",
    };

    expect(resolveGeneratedSpecifier("@/generated/missing", options)).toBeNull();
    expect(resolveGeneratedSpecifier("../lib/not-generated", options)).toBeNull();
  });
});
