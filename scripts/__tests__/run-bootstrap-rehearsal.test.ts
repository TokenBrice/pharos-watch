import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  extractGeneratedImportSpecifiers,
  resolveGeneratedSpecifier,
} from "../maintenance/run-bootstrap-rehearsal";

describe("bootstrap rehearsal generated imports", () => {
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
