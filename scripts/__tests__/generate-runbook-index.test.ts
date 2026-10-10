import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getVerifiedDocFiles } from "../lib/doc-files.mts";
import type { DocOwnershipRegistry, DocReference } from "../lib/doc-ownership-registry.mts";
import { GENERATED_ARTIFACT_REGISTRY } from "../lib/automation-registry.mjs";
import {
  assertRunbookIndexComplete,
  collectRunbookIndex,
  END_MARKER,
  main,
  renderRunbookIndex,
  replaceRunbookIndex,
  START_MARKER,
} from "../maintenance/generate-runbook-index";
import { createTempRepoTracker } from "./helpers/test-state";

const root = resolve(import.meta.dirname, "../..");
const roots = createTempRepoTracker("runbook-index");
afterEach(() => { roots.cleanup(); vi.restoreAllMocks(); });

function registryWith(...references: DocReference[]): DocOwnershipRegistry {
  return { mappings: [{ id: "existing-owner", label: "Existing owner", risk: "low", sources: ["docs/runbooks/**"], docs: references }] };
}

const procedure: DocReference = {
  path: "docs/runbooks/opaque-name.md",
  runbook: { label: "Reviewed operator task", kind: "procedure" },
};

describe("runbook index generator", () => {
  it("covers every verified runbook and incident-response page with curated ownership metadata", () => {
    const registry = JSON.parse(readFileSync(resolve(root, "docs/doc-ownership.json"), "utf8")) as DocOwnershipRegistry;
    const entries = collectRunbookIndex(registry);
    const verified = getVerifiedDocFiles(root).map((path) => relative(root, path));
    expect(entries.length).toBeGreaterThan(0);
    expect(() => assertRunbookIndexComplete(entries, verified)).not.toThrow();
    expect(new Set(entries.map((entry) => entry.path)).size).toBe(entries.length);
  });

  it("uses curated applicability and labels rather than filenames, retaining bounded anchors", () => {
    const entries = collectRunbookIndex(registryWith({ ...procedure, anchor: "operator-contract" }));
    const rendered = renderRunbookIndex(entries);
    expect(rendered).toContain("| procedure | [Reviewed operator task](./runbooks/opaque-name.md#operator-contract) |");
    expect(rendered).not.toContain("[Opaque Name]");
  });

  it("collects existing background references and sorts independently of mapping order", () => {
    const registry = registryWith(procedure);
    registry.mappings![0].background = [{ path: "docs/incident-response/example.md", runbook: { label: "Observed failure", kind: "symptom" } }];
    expect(collectRunbookIndex(registry).map((entry) => entry.runbook.kind)).toEqual(["symptom", "procedure"]);
  });

  it("rejects missing corpus labels and stale labels", () => {
    const entries = collectRunbookIndex(registryWith(procedure));
    expect(() => assertRunbookIndexComplete(entries, ["docs/incident-response/missing.md", "docs/README.md"]))
      .toThrow("Missing labels: docs/incident-response/missing.md\nStale labels: docs/runbooks/opaque-name.md");
  });

  it("rejects duplicate and invalid curated metadata", () => {
    expect(() => collectRunbookIndex(registryWith(procedure, procedure))).toThrow("Duplicate runbook index metadata");
    expect(() => collectRunbookIndex(registryWith({ ...procedure, path: "docs/process/example.md" })))
      .toThrow("Invalid runbook index metadata");
    expect(() => collectRunbookIndex(registryWith({ ...procedure, runbook: { label: " ", kind: "procedure" } })))
      .toThrow("Invalid runbook index metadata");
    expect(() => collectRunbookIndex(registryWith({ ...procedure, runbook: { label: "Label", kind: "unsafe" as "procedure" } })))
      .toThrow("Invalid runbook index metadata");
  });

  it("replaces only one complete generated block and preserves surrounding prose", () => {
    expect(replaceRunbookIndex(`before\n${START_MARKER}\nold\n${END_MARKER}\nafter`, "new block"))
      .toBe("before\nnew block\nafter");
    for (const doc of ["no markers", `${END_MARKER}\n${START_MARKER}`, `${START_MARKER}\n${START_MARKER}\n${END_MARKER}`]) {
      expect(() => replaceRunbookIndex(doc, "new")).toThrow("Expected exactly one valid runbook-index block");
    }
  });

  it("writes its owned output and check mode detects drift without rewriting", () => {
    const fixture = roots.makeRoot();
    roots.writeText(fixture, "docs/doc-ownership.json", JSON.stringify(registryWith(procedure)));
    roots.writeText(fixture, procedure.path, "# Reviewed operator task\n");
    roots.writeText(fixture, "docs/README.md", `before\n${START_MARKER}\n${END_MARKER}\nafter\n`);
    vi.spyOn(console, "log").mockImplementation(() => {});
    main([], fixture);
    const generated = readFileSync(resolve(fixture, "docs/README.md"), "utf8");
    expect(generated).toContain("Reviewed operator task");
    expect(() => main(["--check"], fixture)).not.toThrow();
    roots.writeText(fixture, "docs/README.md", generated.replace("Reviewed operator task", "stale"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("stale-output exit"); });
    expect(() => main(["--check"], fixture)).toThrow("stale-output exit");
    expect(readFileSync(resolve(fixture, "docs/README.md"), "utf8")).toContain("[stale]");
  });

  it("registers deterministic check and write modes with the single README output", () => {
    const entry = GENERATED_ARTIFACT_REGISTRY.find((artifact) => artifact.id === "runbook-index");
    expect(entry).toMatchObject({
      buildLifecycle: "maintenance-only",
      checkCommand: "node --import tsx scripts/maintenance/generate-runbook-index.ts --check",
      command: "node --import tsx scripts/maintenance/generate-runbook-index.ts",
      outputPaths: ["docs/README.md"],
      reproducibility: "deterministic",
    });
    expect(entry?.sourcePaths).toEqual(expect.arrayContaining(["docs/doc-ownership.json", "docs/runbooks/**", "docs/incident-response/**"]));
  });
});
