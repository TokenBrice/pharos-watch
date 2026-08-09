import { describe, expect, it } from "vitest";

import {
  POST_DEPLOY_ACCEPTANCE_OUTCOMES,
  selectPostDeployProbes,
  summarizePostDeployAcceptance,
} from "../lib/post-deploy-acceptance.mjs";

describe("post-deploy acceptance probe selection", () => {
  it("selects only the Pages shell smoke for a Pages release", () => {
    expect(selectPostDeployProbes({ pagesDeployed: true })).toEqual([
      expect.objectContaining({ id: "pages-shell", kind: "smoke", surface: "pages" }),
    ]);
  });

  it("selects only the Worker health smoke for a Worker release", () => {
    expect(selectPostDeployProbes({ workerDeployed: true })).toEqual([
      expect.objectContaining({ id: "worker-health", kind: "smoke", surface: "worker" }),
    ]);
  });

  it("combines the surface-specific probes for a combined release", () => {
    expect(selectPostDeployProbes({ pagesDeployed: true, workerDeployed: true }).map((probe) => probe.id)).toEqual([
      "pages-shell",
      "worker-health",
    ]);
  });

  it("stays pending when no surface completed deployment", () => {
    expect(selectPostDeployProbes()).toEqual([]);
    expect(summarizePostDeployAcceptance([])).toMatchObject({ outcome: "pending" });
  });
});

describe("post-deploy acceptance outcomes", () => {
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
