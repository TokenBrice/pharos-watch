import { describe, expect, it } from "vitest";

import {
  buildPrepareWorkspaceCommands,
  isCiEnvironment,
  runPrepareWorkspace,
} from "../maintenance/prepare-workspace.mjs";
import { testEnv } from "../test-utils/ci-script-test-helpers";

function commandTexts(commands: ReturnType<typeof buildPrepareWorkspaceCommands>) {
  return commands.map(([command, args]) => [command, ...args].join(" "));
}

describe("prepare-workspace", () => {
  it("runs bootstrap and hook setup for local installs", () => {
    expect(commandTexts(buildPrepareWorkspaceCommands(testEnv()))).toEqual([
      "npm run bootstrap:generated",
      "git config core.hooksPath .githooks",
    ]);
  });

  it("skips implicit bootstrap and hooks in CI", () => {
    expect(isCiEnvironment(testEnv({ CI: "true" }))).toBe(true);
    expect(buildPrepareWorkspaceCommands(testEnv({ CI: "true" }))).toEqual([]);
  });

  it("allows CI callers to force the bootstrap step explicitly", () => {
    expect(commandTexts(buildPrepareWorkspaceCommands(testEnv({ CI: "true", PHAROS_PREPARE_BOOTSTRAP: "1" })))).toEqual(
      ["npm run bootstrap:generated"],
    );
  });

  it("allows local callers to skip git hook setup", () => {
    expect(commandTexts(buildPrepareWorkspaceCommands(testEnv({ PHAROS_PREPARE_SKIP_GIT_HOOKS: "1" })))).toEqual([
      "npm run bootstrap:generated",
    ]);
  });

  it("stops on the first failing command", () => {
    const calls: string[] = [];
    const result = runPrepareWorkspace({
      env: testEnv(),
      runCommand: (command: string, args: string[]) => {
        calls.push([command, ...args].join(" "));
        return { status: calls.length === 1 ? 2 : 0 };
      },
    });

    expect(result.status).toBe(2);
    expect(calls).toEqual(["npm run bootstrap:generated"]);
  });
});
