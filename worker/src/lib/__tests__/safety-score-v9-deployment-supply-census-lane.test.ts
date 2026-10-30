import { describe, expect, it } from "vitest";
import { runDeploymentSupplyCensusShadow } from "../../cron/sync-v9-supply-attribution";

const CLOCK = 1_793_355_466;

function source(projection: boolean) {
  return {
    schemaVersion: 1 as const,
    kind: "safety-score-v9-supply-attribution-source" as const,
    baseInputGenerationId: `report-cards-input:v1:${"a".repeat(64)}`,
    sourceGeneration: "fixture-source",
    registryFingerprint: "b".repeat(64),
    clockSec: CLOCK,
    activeAssetIds: ["witry-brix"],
    aggregateCirculatingById: {},
    chainCirculatingById: {},
    navPriceById: {},
    ...(projection ? {
      censusProjection: {
        activeAssetIds: [] as string[],
        aggregateCirculatingById: {},
        chainCirculatingById: {},
        navPriceById: {},
        pegReferenceById: {},
      },
    } : {}),
  };
}

describe("deployment supply census lane", () => {
  it("skips by name when the prepared source carries no census projection", async () => {
    const carry: { value: null } = { value: null };
    const outcome = await runDeploymentSupplyCensusShadow({
      db: {} as D1Database,
      fixedInput: source(false) as never,
      chainRpcs: new Map([["ethereum", {
        chainId: "ethereum", chainName: "Ethereum", type: "evm" as const, endpoints: [], explorerUrl: "",
      }]]),
      executionWindow: { slotStartedAtSec: CLOCK, deadlineMs: Date.now() + 120_000, minimumRemainingMs: 60_000 },
      carry,
    });
    // The attribution allowlist is never a census population: the lane reports
    // the missing population data instead of an empty cohort.
    expect(outcome).toMatchObject({
      status: "skipped",
      reason: "deployment-supply-census-projection-missing",
      cohortAssetIds: [],
      estimatedRequests: 0,
    });
    expect(carry.value).toBeNull();
  });
});
