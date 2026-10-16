import { describe, expect, it } from "vitest";
import {
  buildSafetyScoreV9BaselineExtensionFromNormalizedInput,
  type V9ExtensionRegistryMeta,
} from "../safety-score-v9/extension";
import { normalizeSafetyScoreV9CompilerInput } from "../safety-score-v9/native-input";
import { makeV9TwoAssetFixedInput } from "../../test-helpers/v9-fixed-input";

const CLOCK_SEC = Date.UTC(2026, 9, 10, 12) / 1_000;
const AS_OF_DATE_SEC = Date.UTC(2026, 9, 10) / 1_000;

function compileLaunchDate(
  alpha: Partial<V9ExtensionRegistryMeta>,
  beta: Partial<V9ExtensionRegistryMeta> = {},
  gamma: Partial<V9ExtensionRegistryMeta> = {},
) {
  const fixedInput = normalizeSafetyScoreV9CompilerInput(makeV9TwoAssetFixedInput({ clockSec: CLOCK_SEC }));
  const metaById = new Map<string, V9ExtensionRegistryMeta>([
    ["alpha", { id: "alpha", mechanismArchetype: "tbill", launchDate: "2020-01-01", ...alpha }],
    ["beta", { id: "beta", mechanismArchetype: "tbill", launchDate: "2019-01-01", ...beta }],
    ["gamma", { id: "gamma", mechanismArchetype: "tbill", launchDate: "2018-01-01", ...gamma }],
  ]);
  const extension = buildSafetyScoreV9BaselineExtensionFromNormalizedInput(fixedInput, { metaById });
  const asset = extension.assets.find((row) => row.assetId === "alpha");
  expect(asset).toBeDefined();
  return asset!.launchedAtSec;
}

describe("production implementation-age compilation", () => {
  it.each([
    ["2025-H1", "2025-06-30"],
    ["2025-H2", "2025-12-31"],
  ])("resolves half-year implementation date %s to its inclusive end", (date, expected) => {
    expect(compileLaunchDate({ implementationLaunchDate: date })).toBe(Date.parse(`${expected}T00:00:00Z`) / 1_000);
  });

  it.each(["2026", "2026-10", "2026-Q4", "2026-H2"])(
    "clamps future fuzzy period %s to the fixed scoring UTC date",
    (date) => {
      expect(compileLaunchDate({ implementationLaunchDate: date })).toBe(AS_OF_DATE_SEC);
    },
  );

  it("uses a newer required parent implementation layer rather than the older child", () => {
    expect(compileLaunchDate(
      { implementationLaunchDate: "2021-02-01", variantOf: "beta", variantKind: "pure-wrapper" },
      { implementationLaunchDate: "2025-08-19" },
    )).toBe(Date.UTC(2025, 7, 19) / 1_000);
  });

  it("walks the full variant chain and retains the newest layer rather than the final parent", () => {
    expect(compileLaunchDate(
      { variantOf: "beta", variantKind: "pure-wrapper" },
      { implementationLaunchDate: "2025-08-19", variantOf: "gamma", variantKind: "pure-wrapper" },
      { implementationLaunchDate: "2022-04-01" },
    )).toBe(Date.UTC(2025, 7, 19) / 1_000);
    expect(compileLaunchDate(
      { variantOf: "beta", variantKind: "pure-wrapper" },
      { variantOf: "gamma", variantKind: "pure-wrapper" },
      { implementationLaunchDate: "2025-H1" },
    )).toBe(Date.UTC(2025, 5, 30) / 1_000);
  });

  it("terminates a variant cycle and uses the newest visited implementation layer", () => {
    expect(compileLaunchDate(
      { variantOf: "beta", variantKind: "pure-wrapper" },
      { implementationLaunchDate: "2025-08-19", variantOf: "alpha", variantKind: "pure-wrapper" },
    )).toBe(Date.UTC(2025, 7, 19) / 1_000);
  });

  it("keeps a newer child layer and falls back to launchDate when no implementation date is authored", () => {
    expect(compileLaunchDate(
      { launchDate: "2025-09-01", variantOf: "beta", variantKind: "pure-wrapper" },
      { implementationLaunchDate: "2022-04-01" },
    )).toBe(Date.UTC(2025, 8, 1) / 1_000);
  });

  it("keeps missing and invalid launch dates unavailable", () => {
    expect(compileLaunchDate({ launchDate: undefined })).toBeNull();
    expect(compileLaunchDate({ implementationLaunchDate: "invalid" })).toBeNull();
  });
});
