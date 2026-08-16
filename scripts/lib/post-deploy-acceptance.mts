export const POST_DEPLOY_ACCEPTANCE_OUTCOMES = Object.freeze(["passed", "failed", "pending"] as const);

export type PostDeployAcceptanceOutcome = (typeof POST_DEPLOY_ACCEPTANCE_OUTCOMES)[number];

export interface PostDeployProbe {
  id: string;
  kind: "smoke";
  surface: "pages" | "worker";
  description: string;
}

export interface PostDeployProbeResult {
  id?: string;
  outcome: PostDeployAcceptanceOutcome;
}

/**
 * Choose probes only for surfaces that finished deployment successfully. Cron
 * acceptance is deliberately absent: this short post-deploy job cannot wait for
 * and correlate a future scheduled run, so observing the first relevant
 * execution stays a human step (`npm run ops:watch-worker-cron`).
 */
export function selectPostDeployProbes({
  pagesDeployed = false,
  workerDeployed = false,
}: { pagesDeployed?: boolean; workerDeployed?: boolean } = {}): PostDeployProbe[] {
  const probes: PostDeployProbe[] = [];

  if (pagesDeployed) {
    probes.push({
      id: "pages-shell",
      kind: "smoke",
      surface: "pages",
      description: "Read the public Pages production shell.",
    });
  }

  if (workerDeployed) {
    probes.push({
      id: "worker-health",
      kind: "smoke",
      surface: "worker",
      description: "Read the public Worker health endpoint.",
    });
  }

  return probes;
}

export function summarizePostDeployAcceptance(
  probeResults: readonly PostDeployProbeResult[],
): { outcome: PostDeployAcceptanceOutcome; reason: string } {
  const results = Array.isArray(probeResults) ? probeResults : [];
  const invalid = results.find((result) => !POST_DEPLOY_ACCEPTANCE_OUTCOMES.includes(result?.outcome));
  if (invalid) {
    throw new Error("Post-deploy probe " + (invalid?.id ?? "unknown") + " has an invalid outcome.");
  }

  if (results.some((result) => result.outcome === "failed")) {
    return {
      outcome: "failed",
      reason: "At least one completed read-only smoke probe failed.",
    };
  }
  if (results.length === 0 || results.some((result) => result.outcome === "pending")) {
    return {
      outcome: "pending",
      reason:
        results.length === 0
          ? "No production surface completed deployment."
          : "At least one required operational observation has not occurred yet.",
    };
  }
  return {
    outcome: "passed",
    reason: "Every selected post-deploy probe passed.",
  };
}
