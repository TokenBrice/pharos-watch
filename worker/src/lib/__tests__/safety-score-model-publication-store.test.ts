import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { describe, expect, it } from "vitest";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import {
  SafetyScorePublicationManifestSchema,
  safetyScoreModelCacheKey,
  safetyScorePublicationFence,
  validateSafetyScoreModelCacheValue,
  type SafetyScoreModelFamilyPointer,
} from "../safety-score-model-publication";
import {
  buildSafetyScoreV8ModelFamily,
  loadSafetyScorePublicationManifest,
  publishSafetyScoreV8ModelFamily,
  transitionSafetyScorePublicationState,
  type SafetyScoreV8FamilyPayloads,
} from "../safety-score-model-publication-store";

const MIGRATION_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../migrations/0200_safety_score_v9_shadow_history.sql",
);
const MIGRATION = readFileSync(MIGRATION_PATH, "utf8");
const digest = (character: string) => character.repeat(64);
const BASE_GENERATION = `report-cards-input:v1:${digest("a")}`;
const METHODOLOGY = "8.17";
const BUILD_DIGEST = digest("b");

function createTestDatabase(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE cache (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    ${MIGRATION}
  `);
  return { sqlite, db: createSqliteD1(sqlite) };
}

function fullPayload(generationId: string, publishedAtSec: number) {
  const reportCards = {
    cards: [],
    methodology: {
      version: METHODOLOGY,
      weights: {
        pegStability: 0,
        liquidity: 0.3,
        resilience: 0.2,
        decentralization: 0.15,
        dependencyRisk: 0.25,
      },
      pegMultiplierExponent: 0.4,
      thresholds: [],
    },
    dependencyGraph: { edges: [] },
    updatedAt: publishedAtSec,
    publication: {
      generationId,
      methodologyVersion: METHODOLOGY,
      expectedCount: 0,
      scoredCount: 0,
      notRatedCount: 0,
      notRatedIds: [],
    },
  };
  return JSON.stringify({ generation: 3, methodologyVersion: METHODOLOGY, payload: reportCards });
}

function payloads(generationId: string, publishedAtSec: number): SafetyScoreV8FamilyPayloads {
  return {
    full: { key: "report-cards:snapshot", value: fullPayload(generationId, publishedAtSec) },
    compact: {
      key: "report_card_cache",
      value: JSON.stringify({ generation: 6, methodologyVersion: METHODOLOGY, payload: { scores: {} } }),
    },
    alert: {
      key: "alert:safety-source-cache",
      value: JSON.stringify({ generation: "v8", methodologyVersion: METHODOLOGY, snapshot: {} }),
    },
    fixedInput: {
      key: "report-cards:fixed-input:exact",
      value: JSON.stringify({ schemaVersion: 1, kind: "fixture-fixed-input", generationId }),
    },
  };
}

function publishInput(db: D1Database, sequence = 1) {
  const publishedAtSec = 100 + sequence;
  const generationId = `report-cards:${METHODOLOGY}:${publishedAtSec}`;
  return {
    db,
    generationId,
    baseInputGenerationId:
      sequence === 1 ? BASE_GENERATION : `report-cards-input:v1:${digest(String(sequence))}`,
    publishedAtSec,
    methodologyVersion: METHODOLOGY,
    evaluationBuildDigest: BUILD_DIGEST,
    payloads: payloads(generationId, publishedAtSec),
  };
}

describe("Safety Score model publication store", () => {
  it("wraps the existing V8 full-cache contract in a strict model-keyed family", () => {
    const input = publishInput({} as D1Database);
    const built = buildSafetyScoreV8ModelFamily({
      ...input,
      familyGeneration: 1,
      publicationEpoch: 0,
    });
    const full = built.envelopes.find((envelope) => envelope.artifactKind === "full")!;

    expect(full.payloadJson).toBe(input.payloads.full.value);
    expect(validateSafetyScoreModelCacheValue(stableJsonStringifyV1(full), built.family)).toMatchObject({
      ok: true,
      envelope: { model: "v8", artifactKind: "full" },
    });
  });

  it("atomically initializes, refreshes, and deduplicates the active V8 family", async () => {
    const { sqlite, db } = createTestDatabase();
    const firstInput = publishInput(db, 1);
    const first = await publishSafetyScoreV8ModelFamily(firstInput);

    expect(first).toMatchObject({ status: "published", activeAliasesAdvanced: true });
    expect(first.manifest.selection).toMatchObject({
      state: "v8-active-v9-shadow",
      activeModel: "v8",
      transitionEpoch: 0,
    });
    expect(first.family.familyGeneration).toBe(1);
    expect(sqlite.prepare("SELECT value FROM cache WHERE key = ?").get("report-cards:snapshot")).toEqual({
      value: firstInput.payloads.full.value,
    });
    expect(
      sqlite
        .prepare("SELECT COUNT(*) AS count FROM cache WHERE key LIKE 'safety-score:v8:%'")
        .get(),
    ).toEqual({ count: 4 });

    const unchanged = await publishSafetyScoreV8ModelFamily(firstInput);
    expect(unchanged).toMatchObject({ status: "unchanged", activeAliasesAdvanced: false });

    const secondInput = publishInput(db, 2);
    const second = await publishSafetyScoreV8ModelFamily(secondInput);
    expect(second).toMatchObject({ status: "published", activeAliasesAdvanced: true });
    expect(second.family.familyGeneration).toBe(2);
    expect(sqlite.prepare("SELECT value FROM cache WHERE key = ?").get("report-cards:snapshot")).toEqual({
      value: secondInput.payloads.full.value,
    });
    expect((await loadSafetyScorePublicationManifest(db))?.selection.activeGenerationId).toBe(
      secondInput.generationId,
    );
  });

  it("blocks candidate activation and restores aliases from the retained V8 family", async () => {
    const { sqlite, db } = createTestDatabase();
    const input = publishInput(db, 1);
    const initialized = await publishSafetyScoreV8ModelFamily(input);
    const blocked = await transitionSafetyScorePublicationState({
      db,
      fence: safetyScorePublicationFence(initialized.manifest),
      targetState: "v9-active-v8-warm",
      nowSec: 200,
    });
    expect(blocked).toMatchObject({
      status: "blocked",
      reason: "candidate-contract-not-promotable",
    });

    const activeV9Family: SafetyScoreModelFamilyPointer = {
      model: "v9",
      generationId: "v9-active-fixture",
      familyGeneration: 1,
      publicationEpoch: 0,
      baseInputGenerationId: BASE_GENERATION,
      publishedAtSec: 150,
      identity: {
        model: "v9",
        lifecycle: "active",
        policyId: "safety-score-v9-release",
        policyDigest: digest("c"),
        evaluationBuildDigest: digest("d"),
      },
      artifacts: Object.fromEntries(
        (["full", "compact", "alert", "fixed-input"] as const).map((artifactKind) => [
          artifactKind === "fixed-input" ? "fixedInput" : artifactKind,
          {
            artifactKind,
            cacheKey: safetyScoreModelCacheKey("v9", artifactKind, "v9-active-fixture"),
            payloadDigest: digest(artifactKind === "full" ? "e" : artifactKind === "compact" ? "f" : "1"),
          },
        ]),
      ) as SafetyScoreModelFamilyPointer["artifacts"],
    };
    const activeManifest = SafetyScorePublicationManifestSchema.parse({
      ...initialized.manifest,
      selection: {
        ...initialized.manifest.selection,
        state: "v9-active-v8-warm",
        activeModel: "v9",
        activeGenerationId: activeV9Family.generationId,
        v9GenerationId: activeV9Family.generationId,
        transitionEpoch: 1,
        updatedAtSec: 200,
      },
      families: { v8: initialized.family, v9: activeV9Family },
      aliases: {
        full: {
          aliasKind: "full",
          aliasCacheKey: "report-cards:snapshot",
          targetCacheKey: activeV9Family.artifacts.full.cacheKey,
          model: "v9",
          generationId: activeV9Family.generationId,
          familyGeneration: 1,
          payloadDigest: activeV9Family.artifacts.full.payloadDigest,
        },
        compact: {
          aliasKind: "compact",
          aliasCacheKey: "report_card_cache",
          targetCacheKey: activeV9Family.artifacts.compact.cacheKey,
          model: "v9",
          generationId: activeV9Family.generationId,
          familyGeneration: 1,
          payloadDigest: activeV9Family.artifacts.compact.payloadDigest,
        },
        alert: {
          aliasKind: "alert",
          aliasCacheKey: "alert:safety-source-cache",
          targetCacheKey: activeV9Family.artifacts.alert.cacheKey,
          model: "v9",
          generationId: activeV9Family.generationId,
          familyGeneration: 1,
          payloadDigest: activeV9Family.artifacts.alert.payloadDigest,
        },
      },
    });
    const activeJson = stableJsonStringifyV1(activeManifest);
    sqlite
      .prepare(
        `UPDATE safety_score_publication_state SET
           transition_epoch = ?, state = ?, active_model = ?, active_generation_id = ?,
           manifest_json = ?, manifest_sha256 = ?, updated_at_sec = ?
         WHERE singleton_id = 1`,
      )
      .run(1, "v9-active-v8-warm", "v9", activeV9Family.generationId, activeJson, sha256Hex(activeJson), 200);
    sqlite.prepare("UPDATE cache SET value = ?, updated_at = ? WHERE key = ?").run(
      JSON.stringify({ model: "v9-fixture" }),
      200,
      "report-cards:snapshot",
    );

    const restored = await transitionSafetyScorePublicationState({
      db,
      fence: safetyScorePublicationFence(activeManifest),
      targetState: "v8-restored-v9-retained",
      nowSec: 201,
    });

    expect(restored).toMatchObject({
      status: "transitioned",
      manifest: { selection: { state: "v8-restored-v9-retained", activeModel: "v8", transitionEpoch: 2 } },
    });
    expect(sqlite.prepare("SELECT value FROM cache WHERE key = ?").get("report-cards:snapshot")).toEqual({
      value: input.payloads.full.value,
    });
  });
});
