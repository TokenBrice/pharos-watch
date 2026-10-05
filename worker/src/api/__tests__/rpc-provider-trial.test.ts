import { describe, expect, it, vi } from "vitest";
import { buildRouteContext } from "../../handlers/http/context";
import { makeScheduledEnv } from "../../test-helpers/scheduled-runtime.test-support";
import type { FullRouteContext, StaticRouteDefinition } from "../../routes/shared";

const parity = vi.hoisted(() => ({
  loadRpcProviderTrialReport: vi.fn(),
  reportModuleLoaded: vi.fn(),
}));

vi.mock("../../lib/rpc-provider-parity/report", () => {
  parity.reportModuleLoaded();
  return { loadRpcProviderTrialReport: parity.loadRpcProviderTrialReport };
});

const DWELLIR_API_KEY = "dwellir-trial-key-must-not-leak";
const DWELLIR_MAX_CREDITS_PER_MONTH = "20000000";
/** What the `dwellirBudgetEnv` hydrator must hand the report loader. */
const DWELLIR_BUDGET_ENV = {
  DWELLIR_API_KEY,
  DWELLIR_MAX_CREDITS_PER_MONTH,
};

const env = makeScheduledEnv({
  DWELLIR_API_KEY,
  DWELLIR_MAX_CREDITS_PER_MONTH,
});

const EMPTY_LATENCY = { p50Ms: null, p95Ms: null, samples: 0 };
const METHOD_LATENCY = { p50Ms: 80, p95Ms: 160, samples: 6 };
const SERVED_METHOD = { attempts: 6, successes: 6, capabilityRefusals: 0, unknownRuns: 0, successRate: 1 };
const TRIAL_REPORT = {
  provider: "dwellir",
  generatedAtSec: 1_772_000_000,
  budget: {
    configured: true,
    usable: true,
    reason: "ok",
    window: "2026-09",
    usedCredits: 12_345,
    capCredits: 20_000_000,
    observedAtSec: 1_772_000_000,
  },
  circuit: { state: "closed", consecutiveFailures: 0, updatedAtSec: 1_771_999_000 },
  observation: {
    windowStartSec: 1_771_000_000,
    lastRunAtSec: 1_771_999_000,
    runsRetained: 6,
    chains: [
      {
        chainId: "base",
        dwellirHost: "api-base-mainnet-archive.n.dwellir.com",
        comparator: { operator: "alchemy", host: "base-mainnet.g.alchemy.com", source: "registry" },
        logsComparator: { operator: "alchemy", host: "base-mainnet.g.alchemy.com", source: "registry" },
        comparatorsByStep: {
          head: [{ operator: "alchemy", host: "base-mainnet.g.alchemy.com", source: "registry" }],
          state: [{ operator: "alchemy", host: "base-mainnet.g.alchemy.com", source: "registry" }],
          logs: [{ operator: "alchemy", host: "base-mainnet.g.alchemy.com", source: "registry" }],
          latest: [],
        },
        runs: 6,
        skips: { "no-comparator": 0, "no-dwellir-entry": 0, deadline: 0, aborted: 0, unknown: 0 },
        lastSkip: null,
        dwellirSuccessRate: 1,
        headLagBlocks: { p50: 0, p95: 1, samples: 6 },
        stateParity: { checked: 6, matched: 6, mismatched: 0, lastMismatch: null },
        logParity: { checked: 6, matched: 6, mismatched: 0, skippedReason: null },
        prunedLogProbe: null,
        latency: {
          dwellir: {
            firstTouch: { head: { p50Ms: 180, p95Ms: 420, samples: 6 }, state: EMPTY_LATENCY, logs: EMPTY_LATENCY, latest: EMPTY_LATENCY },
            warm: { head: METHOD_LATENCY, state: METHOD_LATENCY, logs: METHOD_LATENCY, latest: METHOD_LATENCY },
            warmRunMedian: METHOD_LATENCY,
          },
          comparator: {
            firstTouch: { head: { p50Ms: 140, p95Ms: 300, samples: 6 }, state: EMPTY_LATENCY, logs: EMPTY_LATENCY, latest: EMPTY_LATENCY },
            warm: { head: EMPTY_LATENCY, state: METHOD_LATENCY, logs: METHOD_LATENCY, latest: EMPTY_LATENCY },
            warmRunMedian: METHOD_LATENCY,
          },
        },
        availability: {
          dwellir: {
            head: { ...SERVED_METHOD, attempts: 12, successes: 12 }, state: SERVED_METHOD, logs: SERVED_METHOD,
            latest: SERVED_METHOD,
          },
          comparator: {
            head: SERVED_METHOD, state: SERVED_METHOD, logs: SERVED_METHOD,
            latest: { attempts: 0, successes: 0, capabilityRefusals: 0, unknownRuns: 6, successRate: null },
          },
        },
        latestFreshness: {
          fresh: 6, stale: 0, indeterminate: 0, unknown: 0, discriminatingFresh: 6, nonDiscriminatingFresh: 0,
          reasons: { "served-block-in-range": 6 }, maxNumericCalls: 4, blockTolerance: 3, lastStale: null,
        },
        errorClasses: {},
        comparatorErrorClasses: {},
        failedSteps: { dwellir: { head: 0, state: 0, logs: 0, latest: 0 }, comparator: { head: 0, state: 0, logs: 0, latest: 0 } },
        lastComparatorFailure: null,
        gate: { passed: false, failing: [
          "runs", "insufficient-head-attempts", "insufficient-state-attempts", "insufficient-log-attempts",
          "insufficient-latest-attempts", "insufficient-latest-freshness-checks", "insufficient-comparable-samples",
          "insufficient-state-checks", "insufficient-log-checks", "insufficient-warm-samples",
        ] },
        last: { atSec: 1_771_999_000, dwellirHead: 21_000_000, comparatorHead: 21_000_000, commonBlock: 21_000_000 },
      },
    ],
  },
  observationError: null,
};

const execCtx = {
  waitUntil: (_promise: Promise<unknown>) => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function findRoute(routes: readonly StaticRouteDefinition[], key: string): StaticRouteDefinition {
  const route = routes.find((candidate) => candidate.endpoint.key === key);
  if (!route) throw new Error(`Missing route ${key}`);
  return route;
}

/** Hydrate the context exactly as the live dispatcher does, from the declared dependencies. */
function makeContext(route: StaticRouteDefinition, trustedAdmin: boolean): FullRouteContext {
  const url = new URL(`https://ops-api.pharos.watch${route.endpoint.path}`);
  return buildRouteContext({
    request: new Request(url, { method: "GET" }),
    url,
    env,
    execCtx,
    trustedAdmin,
    routeDependencies: route.endpoint.routeDependencies ?? [],
  });
}

/**
 * Dynamic import on purpose: the lazy-import boundary is the behaviour under
 * test, so each case needs a fresh module graph (`vi.resetModules()`); a static
 * import would load the route table once per file and hide the observation.
 */
async function loadRoute(): Promise<StaticRouteDefinition> {
  vi.resetModules();
  parity.reportModuleLoaded.mockClear();
  parity.loadRpcProviderTrialReport.mockReset();
  const { ADMIN_STATIC_ROUTES } = await import("../../routes/admin-routes");
  return findRoute(ADMIN_STATIC_ROUTES, "rpc-provider-trial");
}

describe("GET /api/rpc-provider-trial", () => {
  it("fails closed without an admin credential before importing or running the report", async () => {
    const route = await loadRoute();

    const response = await route.handler(makeContext(route, false));

    expect(response.status).toBe(401);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    // The lazy handler import is what pulls the report module into the isolate.
    expect(parity.reportModuleLoaded).not.toHaveBeenCalled();
    expect(parity.loadRpcProviderTrialReport).not.toHaveBeenCalled();
  });

  it("serves the trial report as no-store JSON without echoing the Dwellir key", async () => {
    const route = await loadRoute();
    parity.loadRpcProviderTrialReport.mockResolvedValue(TRIAL_REPORT);

    const response = await route.handler(makeContext(route, true));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.text();
    expect(JSON.parse(body)).toEqual(TRIAL_REPORT);
    expect(body).not.toContain(DWELLIR_API_KEY);
    expect(parity.loadRpcProviderTrialReport).toHaveBeenCalledTimes(1);
    expect(parity.loadRpcProviderTrialReport).toHaveBeenCalledWith(
      env.DB,
      DWELLIR_BUDGET_ENV,
      expect.any(Number),
    );
  });

  it("still answers 200 when the observation window is unreadable", async () => {
    const route = await loadRoute();
    parity.loadRpcProviderTrialReport.mockResolvedValue({
      ...TRIAL_REPORT,
      observation: null,
      observationError: "samples-unreadable",
    });

    const response = await route.handler(makeContext(route, true));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      provider: "dwellir",
      observation: null,
      observationError: "samples-unreadable",
    });
  });
});
