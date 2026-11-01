import { describe, expect, it } from "vitest";
import { getProbePaths } from "@shared/lib/api-endpoints";

import {
  POST_DEPLOY_ACCEPTANCE_OUTCOMES,
  POST_DEPLOY_ROUTE_SWEEP_CONCURRENCY,
  POST_DEPLOY_ROUTE_SWEEP_DEADLINE_MS,
  POST_DEPLOY_ROUTE_SWEEP_PATHS,
  POST_DEPLOY_ROUTE_SWEEP_TIMEOUT_MS,
  selectPostDeployProbes,
  summarizePostDeployAcceptance,
  summarizePostDeployRouteSweep,
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

describe("post-deploy route sweep", () => {
  it("sweeps exactly the public status-probe registry with its representative parameters", () => {
    expect([...POST_DEPLOY_ROUTE_SWEEP_PATHS]).toEqual(getProbePaths("public"));
    expect(POST_DEPLOY_ROUTE_SWEEP_CONCURRENCY).toBeLessThanOrEqual(4);
    expect(POST_DEPLOY_ROUTE_SWEEP_DEADLINE_MS + POST_DEPLOY_ROUTE_SWEEP_TIMEOUT_MS).toBeLessThan(120_000);
  });

  it("selects the sweep only for a deployed Worker", () => {
    expect(selectPostDeployProbes({ pagesDeployed: true }).map((probe) => probe.id)).toEqual(["pages-shell"]);
    expect(selectPostDeployProbes({ workerDeployed: true }).map((probe) => probe.id)).toEqual([
      "worker-health",
      "worker-route-sweep",
    ]);
  });

  it("passes a sweep whose routes answer below 500", () => {
    const result = summarizePostDeployRouteSweep(
      POST_DEPLOY_ROUTE_SWEEP_PATHS.map((path) => ({ path, status: path === "/api/telegram-pulse" ? 404 : 200 })),
    );
    expect(result.outcome).toBe("passed");
    expect(result.failures).toEqual([]);
    expect(result.detail).toContain(`${POST_DEPLOY_ROUTE_SWEEP_PATHS.length}/${POST_DEPLOY_ROUTE_SWEEP_PATHS.length}`);
  });

  it("fails a 5xx, an auth rejection, a transport failure and a route that never ran", () => {
    const probes: { path: string; status: number; error?: string }[] =
      POST_DEPLOY_ROUTE_SWEEP_PATHS.map((path) => ({ path, status: 200 }));
    probes[0] = { path: probes[0]!.path, status: 503 };
    probes[1] = { path: probes[1]!.path, status: 401 };
    probes[2] = { path: probes[2]!.path, status: 0, error: "offline" };
    probes.splice(3, 1);
    const result = summarizePostDeployRouteSweep(probes);
    expect(result.outcome).toBe("failed");
    expect(result.failures.map((failure) => failure.reason)).toEqual([
      "http-5xx",
      "auth-rejected",
      "transport-error",
      "sweep-not-run",
    ]);
    expect(result.detail).toContain("503");
  });
});
