import { describe, expect, it, vi } from "vitest";
import { buildPrepareWorkspaceCommands, runPrepareWorkspace } from "../maintenance/prepare-workspace";

describe("local workspace preparation", () => {
  it("materializes local generated inputs without configuring Git hooks", () => {
    expect(buildPrepareWorkspaceCommands({})).toEqual([
      ["npm", ["run", "bootstrap:generated"]],
      ["npm", ["run", "bootstrap:generated:history"]],
    ]);
  });

  it("leaves bootstrap to CI unless ordinary bootstrap is explicitly forced", () => {
    expect(buildPrepareWorkspaceCommands({ GITHUB_ACTIONS: "true" })).toEqual([]);
    expect(buildPrepareWorkspaceCommands({ CI: "1", PHAROS_PREPARE_BOOTSTRAP: "1" })).toEqual([
      ["npm", ["run", "bootstrap:generated"]],
    ]);
  });

  it("stops before history generation when bootstrap fails", () => {
    const runCommand = vi.fn(() => ({ status: 1 }));
    expect(runPrepareWorkspace({ env: {}, runCommand })).toEqual({ status: 1 });
    expect(runCommand).toHaveBeenCalledTimes(1);
  });
});
