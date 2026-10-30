import { afterEach, describe, expect, it } from "vitest";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import {
  SAFETY_SCORE_V9_DEPLOYMENT_SUPPLY_CENSUS_MODEL,
  type SafetyScoreV9DeploymentSupplyCensus,
  type V9DeploymentSupplyCensusRow,
} from "@shared/types/safety-score-v9-deployment-supply-census";
import {
  SAFETY_SCORE_V9_DEPLOYMENT_SUPPLY_CENSUS_GENERATION_CACHE_KEY,
  SAFETY_SCORE_V9_DEPLOYMENT_SUPPLY_CENSUS_MAX_AGE_SEC,
  createSafetyScoreV9DeploymentSupplyCensusGeneration,
  readSafetyScoreV9DeploymentSupplyCensus,
  serializeSafetyScoreV9DeploymentSupplyCensusGeneration,
  writeSafetyScoreV9DeploymentSupplyCensusGeneration,
} from "../safety-score-v9/deployment-supply-census-store";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

const CLOCK = 1_800_000_000;
const BASE_INPUT_GENERATION_ID = `report-cards-input:v1:${"d".repeat(64)}`;
const REGISTRY_FINGERPRINT = "e".repeat(64);
const RUNTIME_CODE_SHA256 = "a".repeat(64);
const BLOCK_HASH = `0x${"b".repeat(64)}`;
const TOKEN_ADDRESS = `0x${"c".repeat(40)}`;

function censusRow(overrides: Partial<V9DeploymentSupplyCensusRow> = {}): V9DeploymentSupplyCensusRow {
  return {
    routeId: `ethereum:${TOKEN_ADDRESS}`,
    chainId: "ethereum",
    tokenAddress: TOKEN_ADDRESS,
    readKind: "evm-total-supply",
    pin: {
      kind: "evm-header",
      blockNumber: 20_000_000,
      blockHash: BLOCK_HASH,
      blockTimeSec: CLOCK - 60,
      runtimeCodeSha256: RUNTIME_CODE_SHA256,
    },
    decimals: 6,
    totalSupplyRaw: "1000000",
    referencePriceUsd: 1,
    referencePriceObservedAtSec: CLOCK - 30,
    supplyUsdUpper: 1,
    shareUpper: 0.000001,
    evidenceKind: "upper-bound",
    ...overrides,
  };
}

function censusPacket(
  overrides: Partial<SafetyScoreV9DeploymentSupplyCensus> = {},
): SafetyScoreV9DeploymentSupplyCensus {
  const supply = V9_CANDIDATE_POLICY_V1.policy.semantic.supplyAttribution;
  return {
    model: SAFETY_SCORE_V9_DEPLOYMENT_SUPPLY_CENSUS_MODEL,
    observedAtSec: CLOCK,
    deployments: [censusRow()],
    conservation: {
      aggregateSupplyUsd: 1_000_000,
      measuredSupplyUsd: 1,
      measuredShareSum: 0.000001,
      relativeTolerance: supply.conservationRelativeTolerance,
      absoluteToleranceUsd: supply.conservationAbsoluteToleranceUsd,
      rosterComplete: true,
      conserved: true,
    },
    rejected: [],
    ...overrides,
  };
}

function censusGeneration(
  input: {
    capturedAtSec?: number;
    censusById?: Record<string, SafetyScoreV9DeploymentSupplyCensus>;
  } = {},
) {
  return createSafetyScoreV9DeploymentSupplyCensusGeneration({
    schemaVersion: 1,
    kind: "safety-score-v9-deployment-supply-census-generation",
    sourceBaseInputGenerationId: BASE_INPUT_GENERATION_ID,
    registryFingerprint: REGISTRY_FINGERPRINT,
    capturedAtSec: input.capturedAtSec ?? CLOCK,
    censusById: input.censusById ?? { "usdc-circle": censusPacket() },
  });
}

describe("deployment supply census generation store", () => {
  it("round-trips one cohort generation through its cache row", async () => {
    const { sqlite, db } = fixtures.open();
    const created = censusGeneration();

    const written = await writeSafetyScoreV9DeploymentSupplyCensusGeneration(db, created);
    expect(written).toMatchObject({
      generationId: created.generationId,
      capturedAtSec: CLOCK,
      assetIds: ["usdc-circle"],
      written: true,
      skippedBecauseNewer: false,
    });
    expect(written.storedBytes).toBeGreaterThan(0);
    expect(sqlite.prepare("SELECT updated_at FROM cache WHERE key = ?").get(
      SAFETY_SCORE_V9_DEPLOYMENT_SUPPLY_CENSUS_GENERATION_CACHE_KEY,
    )).toEqual({ updated_at: CLOCK });

    const read = await readSafetyScoreV9DeploymentSupplyCensus(db, { clockSec: CLOCK });
    expect(read).toMatchObject({
      state: "ok",
      generationId: created.generationId,
      capturedAtSec: CLOCK,
      registryFingerprint: created.registryFingerprint,
      sourceBaseInputGenerationId: created.sourceBaseInputGenerationId,
      maxAgeSec: SAFETY_SCORE_V9_DEPLOYMENT_SUPPLY_CENSUS_MAX_AGE_SEC,
      byId: { "usdc-circle": censusPacket() },
      excluded: [],
    });
  });

  it("returns missing, never an empty census, before any generation is stored", async () => {
    const { db } = fixtures.open();
    expect(await readSafetyScoreV9DeploymentSupplyCensus(db, { clockSec: CLOCK })).toMatchObject({
      state: "missing",
      generationId: null,
      registryFingerprint: null,
      sourceBaseInputGenerationId: null,
      byId: {},
      excluded: [],
    });
  });

  it("refuses a non-integer read clock instead of serving bounds", async () => {
    const { db } = fixtures.open();
    await writeSafetyScoreV9DeploymentSupplyCensusGeneration(db, censusGeneration());
    await expect(readSafetyScoreV9DeploymentSupplyCensus(db, { clockSec: Number.NaN }))
      .rejects.toThrow("nonnegative integer clock");
    await expect(readSafetyScoreV9DeploymentSupplyCensus(db, { clockSec: 1.5 }))
      .rejects.toThrow("nonnegative integer clock");
  });

  it("serves a bound through the chain-supply ceiling and omits it afterwards without re-dating", async () => {
    const { db } = fixtures.open();
    const observedAtSec = CLOCK;
    await writeSafetyScoreV9DeploymentSupplyCensusGeneration(db, censusGeneration({
      capturedAtSec: observedAtSec + V9_CANDIDATE_POLICY_V1.policy.semantic.supplyAttribution.observationMaxAgeSec,
      censusById: {
        "usdc-circle": censusPacket({ observedAtSec }),
        "usdt-tether": censusPacket({ observedAtSec }),
      },
    }));

    const atCeiling = await readSafetyScoreV9DeploymentSupplyCensus(db, {
      clockSec: observedAtSec + SAFETY_SCORE_V9_DEPLOYMENT_SUPPLY_CENSUS_MAX_AGE_SEC,
    });
    expect(atCeiling.state).toBe("ok");
    expect(atCeiling.byId["usdc-circle"]?.observedAtSec).toBe(observedAtSec);

    const expired = await readSafetyScoreV9DeploymentSupplyCensus(db, {
      clockSec: observedAtSec + SAFETY_SCORE_V9_DEPLOYMENT_SUPPLY_CENSUS_MAX_AGE_SEC + 1,
    });
    expect(expired.byId).toEqual({});
    expect(expired.excluded).toEqual([
      { assetId: "usdc-circle", reason: "observation-stale" },
      { assetId: "usdt-tether", reason: "observation-stale" },
    ]);
  });

  it("rejects a malformed or tampered stored row instead of serving an empty census", async () => {
    const { sqlite, db } = fixtures.open();
    const key = SAFETY_SCORE_V9_DEPLOYMENT_SUPPLY_CENSUS_GENERATION_CACHE_KEY;
    const insert = sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)");

    insert.run(key, "{not-json", CLOCK);
    expect(await readSafetyScoreV9DeploymentSupplyCensus(db, { clockSec: CLOCK })).toMatchObject({
      state: "invalid",
      generationId: null,
      byId: {},
    });

    const created = censusGeneration();
    const tampered = JSON.parse(serializeSafetyScoreV9DeploymentSupplyCensusGeneration(created)) as Record<string, unknown>;
    tampered.capturedAtSec = CLOCK + 1;
    sqlite.prepare("UPDATE cache SET value = ? WHERE key = ?").run(JSON.stringify(tampered), key);
    expect(await readSafetyScoreV9DeploymentSupplyCensus(db, { clockSec: CLOCK + 2 })).toMatchObject({
      state: "invalid",
      byId: {},
    });
  });

  it("refuses packets that postdate the generation clock or are already stale at capture", () => {
    expect(() => censusGeneration({ capturedAtSec: CLOCK - 1 })).toThrow();
    expect(() => censusGeneration({ capturedAtSec: CLOCK + 1_801 })).toThrow();
    expect(censusGeneration({ capturedAtSec: CLOCK + 1_800 }).censusById["usdc-circle"]?.observedAtSec)
      .toBe(CLOCK);
  });

  it("rejects a packet whose deployment row lost its pinned header", () => {
    const row = censusRow();
    expect(() => censusGeneration({
      censusById: {
        "usdc-circle": censusPacket({ deployments: [{ ...row, pin: undefined } as never] }),
      },
    })).toThrow();
  });

  it("rejects a packet that misstates its own row conservation", () => {
    const declared = censusPacket();
    expect(() => censusGeneration({
      censusById: {
        "usdc-circle": censusPacket({
          conservation: { ...declared.conservation, measuredSupplyUsd: declared.conservation.measuredSupplyUsd + 1 },
        }),
      },
    })).toThrow();
    expect(() => censusGeneration({
      censusById: {
        "usdc-circle": censusPacket({
          rejected: [{ routeId: null, code: "census-rejected:roster-incomplete" }],
        }),
      },
    })).toThrow();
  });

  it("replaces the cohort wholesale and lets no older clock regress the stored generation", async () => {
    const { db } = fixtures.open();
    const first = censusGeneration({
      censusById: { "usdc-circle": censusPacket(), "usdt-tether": censusPacket() },
    });
    await writeSafetyScoreV9DeploymentSupplyCensusGeneration(db, first);

    const second = censusGeneration({
      capturedAtSec: CLOCK + 60,
      censusById: { "usdc-circle": censusPacket({ observedAtSec: CLOCK + 60 }) },
    });
    expect((await writeSafetyScoreV9DeploymentSupplyCensusGeneration(db, second)).written).toBe(true);

    const afterSecond = await readSafetyScoreV9DeploymentSupplyCensus(db, { clockSec: CLOCK + 60 });
    expect(Object.keys(afterSecond.byId)).toEqual(["usdc-circle"]);
    expect(afterSecond.generationId).toBe(second.generationId);

    const stale = await writeSafetyScoreV9DeploymentSupplyCensusGeneration(db, first);
    expect(stale).toMatchObject({ written: false, skippedBecauseNewer: true });
    expect((await readSafetyScoreV9DeploymentSupplyCensus(db, { clockSec: CLOCK + 60 })).generationId)
      .toBe(second.generationId);
  });
});
