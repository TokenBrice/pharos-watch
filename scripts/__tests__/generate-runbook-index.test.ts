import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocOwnershipRegistry, DocReference } from "../lib/doc-ownership-registry.mts";
import {
  END_MARKER,
  collectRunbookIndex,
  renderRunbookIndex,
  main,
  START_MARKER,
} from "../maintenance/generate-runbook-index";
import { createTempRepoTracker } from "./helpers/test-state";

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
  it("renders selector and required runbook metadata once across repeated reading modes", () => {
    const registry = registryWith();
    const mapping = registry.mappings![0];
    mapping.reading = [{ sources: ["worker/**"], local: [procedure], contract: [procedure],
      required: [{ ...procedure, path: "docs/runbooks/required.md", runbook: { label: "Required recovery", kind: "symptom" } }] }];
    mapping.required = [procedure];
    const entries = collectRunbookIndex(registry);
    expect(entries).toHaveLength(2);
    expect(renderRunbookIndex(entries)).toContain("| procedure | [Reviewed operator task](./runbooks/opaque-name.md) |");
    expect(renderRunbookIndex(entries)).toContain("| symptom | [Required recovery](./runbooks/required.md) |");
    mapping.reading[0].contract = [{ ...procedure, runbook: { label: "Conflicting label", kind: "procedure" } }];
    expect(() => collectRunbookIndex(registry)).toThrow("Duplicate runbook index metadata");
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
});
