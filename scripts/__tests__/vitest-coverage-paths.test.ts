import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import config from "../../vitest.config";

const { isMatch } = createRequire(import.meta.url)("picomatch");
const root = resolve(import.meta.dirname, "../..").replaceAll("\\", "/");
const ignore = config.test!.coverage!.exclude!;
const included = (file: string) => isMatch(file, "**", { contains: true, dot: true, ignore });

describe("coverage exclusions in nested worktrees", () => {
  it("retains source beneath ancestor scratch/worktree directories", () => {
    expect(included(`${root}/worker/src/lib/mint-burn-publication.ts`)).toBe(true);
    expect(included("/tmp/agents/review/worktrees/checkout/worker/src/lib/mint-burn-publication.ts")).toBe(true);
  });

  it("still excludes repository scratch, build output and dependencies", () => {
    for (const directory of ["agents", ".claude", ".next", "out", "coverage", "node_modules"]) {
      expect(included(`${root}/${directory}/fixture.ts`), directory).toBe(false);
    }
  });
});
