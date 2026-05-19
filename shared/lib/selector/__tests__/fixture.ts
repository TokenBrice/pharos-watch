/**
 * Synthetic fixture loader. Hand-written `MergedRow` array used by every
 * engine test. The shape is kept deliberately small (~20 coins) so tests
 * stay fast and the fixture diff is human-readable.
 */
import fixtureJson from "../__fixtures__/active-universe.json";
import type {
  DatasetMetadata,
  MergedRow,
  SelectorData,
  SelectorInput,
} from "../types";

export const FIXTURE_ROWS = fixtureJson as unknown as MergedRow[];

export function buildFixtureData(): SelectorData {
  const rows = new Map<string, MergedRow>();
  for (const row of FIXTURE_ROWS) {
    rows.set(row.id, row);
  }
  return { rows };
}

export const FIXTURE_DATASET: DatasetMetadata = {
  timestamp: 1_700_000_000_000,
  datasetHash: "test-dataset-hash",
  methodologyVersions: {
    safetyScore: "safety-v1.0",
    pegScoreAndDews: "peg-dews-v1.0",
    yieldIntelligence: "yield-v1.0",
    bluechipAlignment: "bluechip-v1.0",
    exclusionFilters: "selector-v1.0",
  },
};

export function makeInput(overrides: Partial<SelectorInput> = {}): SelectorInput {
  return {
    profile: "treasury",
    pegCurrency: "USD",
    horizon: "1to6m",
    depegTolerance: "tight",
    composability: "moderate",
    exitSpeed: "any",
    minApy: null,
    yieldNativeOnly: false,
    decentralization: "any",
    custodyOk: "any",
    ...overrides,
  };
}
