import { describe, expect, it } from "vitest";

import { hasVitestOption, withCiVitestArgs } from "../lib/vitest-ci-args.mjs";

describe("hasVitestOption", () => {
  it("detects inline and split Vitest options", () => {
    expect(hasVitestOption(["run", "--silent=passed-only"], "--silent")).toBe(true);
    expect(hasVitestOption(["run", "--silent", "true"], "--silent")).toBe(true);
    expect(hasVitestOption(["run", "--reporter", "dot"], "--reporter")).toBe(true);
    expect(hasVitestOption(["run", "--reporter=dot"], "--reporter")).toBe(true);
    expect(hasVitestOption(["run"], "--silent")).toBe(false);
  });
});

describe("withCiVitestArgs", () => {
  it("adds passed-only silence in CI", () => {
    expect(withCiVitestArgs(["run"], { CI: "true" })).toEqual(["run", "--silent=passed-only"]);
  });

  it("preserves explicit silent options", () => {
    expect(withCiVitestArgs(["run", "--silent=false"], { CI: "true" })).toEqual(["run", "--silent=false"]);
  });

  it("does not change local runs or explicit opt-outs", () => {
    expect(withCiVitestArgs(["run"], { CI: "" })).toEqual(["run"]);
    expect(withCiVitestArgs(["run"], { CI: "true", PHAROS_CI_VITEST_COMPACT: "0" })).toEqual(["run"]);
  });
});
