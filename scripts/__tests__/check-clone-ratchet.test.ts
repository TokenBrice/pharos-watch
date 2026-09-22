import { describe, expect, it } from "vitest";

import { checkCloneRatchet } from "../ci/check-clone-ratchet.ts";
import { withTempRepo } from "./helpers/test-state";

const BASELINE_PATH = "scripts/lib/clone-ratchet-baseline.json";

function writable() {
  let value = "";
  return {
    stream: { write: (chunk: string) => (value += chunk) },
    text: () => value,
  };
}

function runAgainst(baseline: Record<string, number>) {
  return withTempRepo("clone-ratchet", {
    "src/kept.ts": "export const kept = 1;\n",
    [BASELINE_PATH]: `${JSON.stringify(baseline, null, 2)}\n`,
  }, (cwd) => {
    const stdout = writable();
    const stderr = writable();
    const status = checkCloneRatchet({
      roots: ["src"],
      baselinePath: BASELINE_PATH,
      cwd,
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    return { status, stderr: stderr.text() };
  });
}

describe("clone ratchet stale baseline reporting", () => {
  it("names baseline paths that left the tree without failing the run", () => {
    const { status, stderr } = runAgainst({ "src/kept.ts": 14, "src/deleted.ts": 20, "worker/src/gone.ts": 12 });

    expect(status).toBe(0);
    expect(stderr).toContain("staleBaseline: 2 baseline path(s)");
    expect(stderr).toContain("src/deleted.ts");
    expect(stderr).toContain("worker/src/gone.ts");
    expect(stderr).not.toContain("src/kept.ts");
  });

  it("stays silent when every baseline path still exists", () => {
    const { status, stderr } = runAgainst({ "src/kept.ts": 14 });

    expect(status).toBe(0);
    expect(stderr).toBe("");
  });
});
