import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocOwnershipRegistry, DocReference } from "../lib/doc-ownership-registry.mts";
import {
  END_MARKER,
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
