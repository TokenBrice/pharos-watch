import { describe, expect, it, vi } from "vitest";
import { checkDocsGeneratedArtifacts, selectDocsGeneratedArtifactIds } from "../ci/check-docs-generated-artifacts.mts";

describe("docs-only generated artifact completeness", () => {
  it("selects llms-txt through registry ownership for top-level input docs", () => {
    expect(selectDocsGeneratedArtifactIds(["docs/testing.md"])).toEqual(["llms-txt"]);
    expect(selectDocsGeneratedArtifactIds(["docs/testing.md", "README.md"])).toEqual(["llms-txt"]);
    // Public docs select Pages/static checks instead of the internal-docs shortcut.
    expect(selectDocsGeneratedArtifactIds(["docs/api-reference.md", "README.md"])).toEqual([]);
    expect(selectDocsGeneratedArtifactIds(["docs/process/agent-start-here.md"])).toEqual([]);
    expect(selectDocsGeneratedArtifactIds(["README.md"])).toEqual([]);
    // Mixed source changes retain the static artifact owner, not a duplicate docs check.
    expect(selectDocsGeneratedArtifactIds(["docs/testing.md", "src/app/page.tsx"])).toEqual([]);
  });

  it("runs the affected artifact's completeness check and preserves its failure", async () => {
    const runArtifacts = vi.fn(async () => ({ status: 1, failedCmd: "llms-txt" }));
    const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PR_BASE_SHA: "base", PR_HEAD_SHA: "head" };
    expect(await checkDocsGeneratedArtifacts({ changedFiles: ["docs/testing.md"], env, runArtifacts })).toBe(1);
    expect(runArtifacts).toHaveBeenCalledWith({ argv: ["--check", "--only=llms-txt"], env });
  });

  it("does not claim or execute artifact freshness for docs without owned inputs", async () => {
    const runArtifacts = vi.fn(async () => ({ status: 0, failedCmd: null }));
    expect(await checkDocsGeneratedArtifacts({ changedFiles: ["docs/process/agent-start-here.md"], runArtifacts })).toBe(0);
    expect(runArtifacts).not.toHaveBeenCalled();
  });
});
