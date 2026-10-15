import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEAD_STABLECOINS } from "@shared/lib/dead-stablecoins";
import {
  ACTIVE_STABLECOINS, FROZEN_STABLECOINS, TRACKED_SOURCE_COINS,
} from "@shared/lib/stablecoins/registry";
import {
  SAFETY_SCORE_V9_ACTIVE_ASSET_IDS, SAFETY_SCORE_V9_ACTIVE_META_BY_ID,
  SAFETY_SCORE_V9_CATALOG_COUNT, SAFETY_SCORE_V9_REGISTRY_FINGERPRINT,
  SAFETY_SCORE_V9_SCORING_ROWS,
} from "@shared/lib/stablecoins/safety-score-v9-registry";
import { computeReportCardsRegistryFingerprint } from "@shared/lib/report-cards-fixed-input-identity";
import { SAFETY_SCORE_V9_SCORING_FIELDS } from "@shared/types/safety-score-v9-scoring-catalog";
import { fingerprintReportCardRegistryRows } from "../lib/report-card-registry-fingerprint";
import { GENERATED_ARTIFACT_REGISTRY } from "../lib/automation-registry.mjs";
import { selectChangedGeneratedArtifactIds } from "../ci/select-generated-artifacts.mts";
import {
  buildSafetyScoreV9ScoringCatalog, projectSafetyScoreV9ScoringMeta,
  runSafetyScoreV9ScoringCatalogGenerator,
} from "../maintenance/generate-safety-score-v9-scoring-catalog";

const FIELDS = [
  "id", "status", "variantOf", "variantKind", "wrapperOperator", "parentBackingInheritance",
  "archetypeOverride", "mechanismArchetype", "mechanismArchetypeReview", "implementationLaunchDate",
  "launchDate", "reserves", "reserveReview", "custodyProfile", "liveReservesConfig", "dependencies",
  "dependencyReview", "custodyModel", "proofOfReserves", "genius", "mintAuthority", "oracleRisk",
  "bridgeRouteRisk", "blacklistabilityReview", "contracts", "detailProvider", "llamaId", "tradedContracts",
  "flags", "pegReferenceId",
] as const;

const hasOwn = (value: object, field: PropertyKey) => Object.prototype.hasOwnProperty.call(value, field);

describe("Safety Score V9 scoring catalog generation", () => {
  it("retains every scoring field and complete nested value for every active asset", () => {
    expect(SAFETY_SCORE_V9_SCORING_FIELDS).toEqual(FIELDS);
    expect(SAFETY_SCORE_V9_SCORING_ROWS).toHaveLength(ACTIVE_STABLECOINS.length);
    for (const source of ACTIVE_STABLECOINS) {
      const projected = SAFETY_SCORE_V9_ACTIVE_META_BY_ID.get(source.id)!;
      expect(Object.keys(projected).sort(), source.id).toEqual(FIELDS.filter(field => hasOwn(source, field)).sort());
      for (const field of FIELDS) {
        expect(hasOwn(projected, field), `${source.id}.${field} presence`).toBe(hasOwn(source, field));
        expect(projected[field], `${source.id}.${field}`).toEqual(source[field]);
      }
      expect(Object.isFrozen(projected)).toBe(true);
      if (projected.flags) expect(Object.isFrozen(projected.flags)).toBe(true);
    }
  });

  it("preserves canonical active census/order, all-tracked count and full-source fingerprint", () => {
    const expectedIds = ACTIVE_STABLECOINS.map(coin => coin.id);
    expect(SAFETY_SCORE_V9_ACTIVE_ASSET_IDS).toEqual(expectedIds);
    expect([...SAFETY_SCORE_V9_ACTIVE_META_BY_ID.keys()]).toEqual(expectedIds);
    expect(SAFETY_SCORE_V9_SCORING_ROWS.map(coin => coin.id)).toEqual(expectedIds);
    expect(SAFETY_SCORE_V9_CATALOG_COUNT).toBe(TRACKED_SOURCE_COINS.length);
    const fullFingerprint = fingerprintReportCardRegistryRows({
      activeStablecoins: ACTIVE_STABLECOINS, frozenStablecoins: FROZEN_STABLECOINS, deadStablecoins: DEAD_STABLECOINS,
    });
    expect(SAFETY_SCORE_V9_REGISTRY_FINGERPRINT).toBe(fullFingerprint);
    expect(SAFETY_SCORE_V9_REGISTRY_FINGERPRINT).toBe(computeReportCardsRegistryFingerprint());
    const generated = buildSafetyScoreV9ScoringCatalog();
    expect(generated).toEqual({ schemaVersion: 1, registryFingerprint: fullFingerprint,
      catalogCount: TRACKED_SOURCE_COINS.length, activeAssetIds: expectedIds, rows: SAFETY_SCORE_V9_SCORING_ROWS });
    expect(JSON.stringify(buildSafetyScoreV9ScoringCatalog())).toBe(JSON.stringify(generated));
  });

  it("ships the scoring artifact as compact JSON without adding a runtime decoder", () => {
    const source = readFileSync(new URL("../../shared/data/stablecoins/coins.safety-score-v9.generated.json", import.meta.url), "utf8");
    expect(source).toBe(`${JSON.stringify(buildSafetyScoreV9ScoringCatalog())}\n`);
  });

  it("strips suspended feeds exactly as the full registry does, without admitting inactive rows", () => {
    let suspendedActiveRows = 0;
    for (const source of TRACKED_SOURCE_COINS) {
      const row = SAFETY_SCORE_V9_ACTIVE_META_BY_ID.get(source.id);
      if (!ACTIVE_STABLECOINS.some(coin => coin.id === source.id)) {
        expect(row).toBeUndefined();
      } else if (source.liveReservesConfig?.suspended) {
        suspendedActiveRows++;
        expect(row).toBeDefined();
        expect(hasOwn(row!, "liveReservesConfig")).toBe(false);
      }
    }
    expect(suspendedActiveRows).toBeGreaterThan(0);
  });

  it("preserves absent versus null versus explicit empty values rather than filling defaults", () => {
    const source = { id: "presence-fixture", reserves: [], dependencies: [] };
    Reflect.set(source, "custodyProfile", null);
    const row = projectSafetyScoreV9ScoringMeta(source);
    expect(hasOwn(row, "flags")).toBe(false);
    expect(hasOwn(row, "pegReferenceId")).toBe(false);
    expect(hasOwn(row, "custodyProfile")).toBe(true);
    expect(row.custodyProfile).toBeNull();
    expect(row.reserves).toEqual([]);
    expect(row.dependencies).toEqual([]);
    expect(JSON.parse(JSON.stringify(row))).toEqual({ id: source.id, reserves: [], dependencies: [], custodyProfile: null });
  });

  it.each([
    { args: ["--unknown"] }, { args: ["position"] }, { args: ["--check=true"] }, { args: ["--check", "--check"] },
  ])(
    "rejects invalid CLI arguments before generation: $args", ({ args }) => {
      expect(() => runSafetyScoreV9ScoringCatalogGenerator(args)).toThrow();
    },
  );

  it("orders bootstrap after catalog and before evaluator identity and routes all owning sources", () => {
    const artifact = GENERATED_ARTIFACT_REGISTRY.find(row => row.id === "safety-score-v9-scoring-catalog")!;
    expect(artifact).toMatchObject({ buildLifecycle: "compile-input", bootstrap: true, checkable: true,
      reproducibility: "deterministic", phase: 1, dependsOn: ["stablecoin-catalog"] });
    const evaluator = GENERATED_ARTIFACT_REGISTRY.find(row => row.id === "safety-score-v9-evaluation-build")!;
    expect(evaluator.dependsOn).toContain(artifact.id);
    expect(evaluator.phase).toBeGreaterThan(artifact.phase);
    for (const source of [
      "shared/data/stablecoins/coins/usdc-circle.json",
      "shared/data/stablecoins/domains/reserves/usdc-circle.json",
      "shared/data/stablecoins/canonical-order.json", "shared/data/dead-stablecoins.json",
      "shared/lib/stablecoins/status.ts", "shared/lib/stablecoins/registry-indexes.ts",
      "scripts/lib/report-card-registry-fingerprint.ts", "shared/types/safety-score-v9-scoring-catalog.ts",
      "scripts/maintenance/generate-safety-score-v9-scoring-catalog.ts",
    ]) {
      const selected = selectChangedGeneratedArtifactIds([source]);
      expect(selected, source).toContain(artifact.id);
      expect(selected, source).toContain(evaluator.id);
    }
  });
});
