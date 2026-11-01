export const POST_DEPLOY_ACCEPTANCE_OUTCOMES = Object.freeze(["passed", "failed", "pending"] as const);

export type PostDeployAcceptanceOutcome = (typeof POST_DEPLOY_ACCEPTANCE_OUTCOMES)[number];

/**
 * The Worker route sweep replays the status self-check's public probe registry
 * (`getProbePaths("public")`, including its representative dynamic parameters)
 * through the public API origin. It is duplicated here because the acceptance
 * entrypoint runs dependency-free; `post-deploy-acceptance.test.ts` asserts it
 * stays byte-identical to the registry.
 */
export const POST_DEPLOY_ROUTE_SWEEP_PATHS = Object.freeze([
  "/api/stablecoins",
  "/api/stablecoin/pyusd-paypal",
  "/api/stablecoin-summary/usdt-tether",
  "/api/stablecoin-reserves/iusd-infinifi",
  "/api/stablecoin-charts",
  "/api/peg-summary",
  "/api/health",
  "/api/public-status-history",
  "/api/blacklist",
  "/api/blacklist-summary",
  "/api/depeg-events",
  "/api/events",
  "/api/usds-status",
  "/api/bluechip-ratings",
  "/api/dex-liquidity",
  "/api/dex-liquidity-history?stablecoin=usdt-tether",
  "/api/supply-history?stablecoin=usdt-tether",
  "/api/daily-digest",
  "/api/digest-archive",
  "/api/snapshots/index",
  "/api/yield-rankings",
  "/api/yield-adapter-manifest",
  "/api/yield-history?stablecoin=usdt-tether",
  "/api/safety-score-history?stablecoin=usdt-tether",
  "/api/safety-score-history-v2?stablecoin=usdt-tether&days=3650",
  "/api/stability-index",
  "/api/report-cards/v9",
  "/api/safety-grades",
  "/api/dependency-graph/v1",
  "/api/dependency-scenarios/v1",
  "/api/depeg-resolver",
  "/api/depeg-resolver-review",
  "/api/redemption-backstops",
  "/api/mint-burn-flows",
  "/api/mint-burn-events?stablecoin=usdt-tether",
  "/api/stress-signals",
  "/api/chains",
  "/api/non-usd-share?days=90",
  "/api/telegram-pulse",
]);

/** Keep the sweep below the six-connection Worker budget and under two minutes. */
export const POST_DEPLOY_ROUTE_SWEEP_CONCURRENCY = 4;
export const POST_DEPLOY_ROUTE_SWEEP_TIMEOUT_MS = 10_000;
export const POST_DEPLOY_ROUTE_SWEEP_DEADLINE_MS = 105_000;

export interface PostDeployRouteProbe {
  path: string;
  status: number;
  error?: string;
  retriedAfter5xx?: boolean;
}

/**
 * `http-5xx`, transport and auth failures fail acceptance. `rate-limited`
 * (429) is unknown evidence: it neither passes nor fails the release by itself.
 */
export type PostDeployRouteSweepFailureReason =
  | "http-5xx"
  | "transport-error"
  | "auth-rejected"
  | "rate-limited"
  | "sweep-not-run";

export interface PostDeployRouteSweepFailure {
  path: string;
  status: number;
  reason: PostDeployRouteSweepFailureReason;
}

export function classifyPostDeployRouteProbe(probe: PostDeployRouteProbe): PostDeployRouteSweepFailure | null {
  if (probe.status === 0) {
    return {
      path: probe.path,
      status: probe.status,
      reason: probe.error === "sweep-deadline-exceeded" ? "sweep-not-run" : "transport-error",
    };
  }
  if (probe.status === 401 || probe.status === 403) {
    return { path: probe.path, status: probe.status, reason: "auth-rejected" };
  }
  if (probe.status === 429) {
    return { path: probe.path, status: probe.status, reason: "rate-limited" };
  }
  if (probe.status >= 500 && probe.status <= 599) {
    return { path: probe.path, status: probe.status, reason: "http-5xx" };
  }
  return null;
}

/**
 * A route that was never requested inside the sweep deadline is unknown, not
 * healthy, so it fails acceptance and names the missing observation.
 */
export function summarizePostDeployRouteSweep(probes: readonly PostDeployRouteProbe[]): {
  outcome: PostDeployAcceptanceOutcome;
  failures: PostDeployRouteSweepFailure[];
  detail: string;
} {
  const failures = probes
    .map(classifyPostDeployRouteProbe)
    .filter((failure): failure is PostDeployRouteSweepFailure => failure != null);
  const byPath = new Map(probes.map((probe) => [probe.path, probe]));
  for (const path of POST_DEPLOY_ROUTE_SWEEP_PATHS) {
    if (!byPath.has(path)) {
      failures.push({ path, status: 0, reason: "sweep-not-run" });
    }
  }
  const hardFailures = failures.filter((failure) => failure.reason !== "rate-limited");
  const retried = probes.filter((probe) => probe.retriedAfter5xx).length;
  const retryNote = retried > 0 ? ` (${retried} route${retried === 1 ? "" : "s"} retried once after a 5xx)` : "";
  const listed = failures.slice(0, 8)
    .map((failure) => `${failure.path} (${failure.reason}, HTTP ${failure.status})`).join("; ")
    + (failures.length > 8 ? `; +${failures.length - 8} more` : "");
  const detail = failures.length === 0
    ? `${probes.length}/${POST_DEPLOY_ROUTE_SWEEP_PATHS.length} public GET routes answered without a persistent 5xx${retryNote}.`
    : hardFailures.length > 0
      ? `${failures.length}/${POST_DEPLOY_ROUTE_SWEEP_PATHS.length} public GET routes failed or were unverified${retryNote}: ${listed}`
      : `${failures.length}/${POST_DEPLOY_ROUTE_SWEEP_PATHS.length} public GET routes were rate-limited (unknown, not failed)${retryNote}: ${listed}`;
  return {
    outcome: hardFailures.length > 0 ? "failed" : failures.length > 0 ? "pending" : "passed",
    failures,
    detail,
  };
}

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
    probes.push({
      id: "worker-route-sweep",
      kind: "smoke",
      surface: "worker",
      description: "GET every public status-probe route once (one 5xx retry); a persistent 5xx fails the release; a 429 is unknown.",
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
