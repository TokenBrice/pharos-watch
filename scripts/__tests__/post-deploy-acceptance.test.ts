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

  it("selects Worker health plus a deferred cron observation for a Worker release", () => {
    expect(selectPostDeployProbes({ workerDeployed: true })).toEqual([
      expect.objectContaining({ id: "worker-health", kind: "smoke", surface: "worker" }),
      expect.objectContaining({ id: "worker-cron", kind: "cron", surface: "worker", deferred: true }),
    ]);
  });

  it("combines the surface-specific probes for a combined release", () => {
    expect(selectPostDeployProbes({ pagesDeployed: true, workerDeployed: true }).map((probe) => probe.id)).toEqual([
      "pages-shell",
      "worker-health",
      "worker-cron",
    ]);
  });
});

describe("post-deploy acceptance outcomes", () => {
  it("keeps a deferred cron observation explicitly pending", () => {
    expect(
      summarizePostDeployAcceptance([
        { id: "worker-health", outcome: "passed" },
        { id: "worker-cron", outcome: "pending" },
      ]),
    ).toMatchObject({ outcome: "pending" });
  });

  it("makes a failed smoke probe dominate pending observations", () => {
    expect(
      summarizePostDeployAcceptance([
        { id: "pages-shell", outcome: "failed" },
        { id: "worker-cron", outcome: "pending" },
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
