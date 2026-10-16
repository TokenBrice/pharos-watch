import { describe, expect, it } from "vitest";

import {
  POST_DEPLOY_ACCEPTANCE_OUTCOMES,
  summarizePostDeployAcceptance,
} from "../lib/post-deploy-acceptance.mts";

describe("post-deploy acceptance outcomes", () => {
  it.each([
    ["passed", "pending", "pending"],
    ["failed", "pending", "failed"],
    ["pending", "failed", "failed"],
  ] as const)("summarizes %s plus %s as %s", (first, second, outcome) => {
    expect(summarizePostDeployAcceptance([
      { id: "pages-shell", outcome: first },
      { id: "worker-health", outcome: second },
    ]).outcome).toBe(outcome);
  });

  it("rejects invalid outcomes with the responsible probe identity", () => {
    expect(() => summarizePostDeployAcceptance([
      { id: "pages-shell", outcome: "failed" },
      // Exercise malformed runtime input despite the typed producer contract.
      { id: "worker-health", outcome: "invalid" as "passed" },
    ])).toThrow(/worker-health.*invalid outcome/);
  });

  it("makes a failed smoke probe dominate other outcomes", () => {
    expect(
      summarizePostDeployAcceptance([
        { id: "pages-shell", outcome: "failed" },
        { id: "worker-health", outcome: "passed" },
      ]),
    ).toMatchObject({ outcome: "failed" });
  });

  it("passes only when every selected probe passed", () => {
    expect(
      summarizePostDeployAcceptance([
        { id: "pages-shell", outcome: "passed" },
        { id: "worker-health", outcome: "passed" },
      ]),
    ).toMatchObject({ outcome: "passed" });
    expect(POST_DEPLOY_ACCEPTANCE_OUTCOMES).toEqual(["passed", "failed", "pending"]);
  });
});
