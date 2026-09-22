import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SafetyScoreHistoryV2ResponseSchema } from "@shared/types/safety-score-history";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { registerStablecoinParameterContract } from "../../test-helpers/__shared/endpoint-contracts";
import { handleSafetyScoreHistoryV2 } from "../safety-score-history-v2";

const DIGEST = "a".repeat(64);
const BASE_INPUT_GENERATION_ID = `report-cards-input:v1:${"b".repeat(64)}`;
const EVALUATION_BUILD_DIGEST = "c".repeat(64);

function v9BoundaryRow() {
  return {
    history_id: "v9-boundary",
    stablecoin_id: "usdc-circle",
    recorded_at: 300,
    model: "v9" as const,
    identity_schema_version: 1,
    methodology_version: "9.0",
    policy_id: "v9-rc-1",
    policy_digest: DIGEST,
    evaluation_build_digest: EVALUATION_BUILD_DIGEST,
    base_input_generation_id: BASE_INPUT_GENERATION_ID,
    model_publication_generation_id: "safety-score-v9:300",
    transition_kind: "methodology-boundary-baseline" as const,
    grade: "A" as const,
    score: 88,
    prev_grade: null,
    prev_score: null,
  };
}

describe("handleSafetyScoreHistoryV2", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns non-comparable V9 boundary rows with full identity", async () => {
    const db = mockD1([
      {
        match: "FROM safety_score_history_v2",
        rows: [v9BoundaryRow()],
      },
      { match: "cron_runs", rows: [] },
    ], { requireMatch: true });

    const response = await handleSafetyScoreHistoryV2(
      db,
      new URL("https://x/api/safety-score-history-v2?stablecoin=usdc-circle"),
    );

    const body = SafetyScoreHistoryV2ResponseSchema.parse(await readJsonResponse(response, 200));
    expect(body).toMatchObject({
      schemaVersion: 2,
      history: [
        {
          transitionKind: "methodology-boundary-baseline",
          safetyScoreIdentity: {
            model: "v9",
            schemaVersion: 1,
            methodologyVersion: "9.0",
            policyId: "v9-rc-1",
            policyDigest: DIGEST,
            evaluationBuildDigest: EVALUATION_BUILD_DIGEST,
            baseInputGenerationId: BASE_INPUT_GENERATION_ID,
            publicationGenerationId: "safety-score-v9:300",
          },
        },
      ],
    });
  });

  it("maps V8 identities without V9 policy fields and preserves organic predecessors", async () => {
    const db = mockD1([
      {
        match: "FROM safety_score_history_v2",
        rows: [{
          ...v9BoundaryRow(),
          history_id: "v8-organic",
          recorded_at: 200,
          model: "v8" as const,
          methodology_version: "8.17",
          policy_id: null,
          policy_digest: null,
          evaluation_build_digest: "d".repeat(64),
          model_publication_generation_id: "report-cards:8.17:200",
          transition_kind: "organic-grade-change" as const,
          grade: "A-" as const,
          score: 81,
          prev_grade: "B+" as const,
          prev_score: 77,
        }],
      },
      { match: "cron_runs", rows: [] },
    ], { requireMatch: true });

    const response = await handleSafetyScoreHistoryV2(
      db,
      new URL("https://x/api/safety-score-history-v2?stablecoin=usdc-circle"),
    );

    const body = SafetyScoreHistoryV2ResponseSchema.parse(await readJsonResponse(response, 200));
    expect(body.history).toEqual([
      {
        date: 200,
        grade: "A-",
        score: 81,
        prevGrade: "B+",
        prevScore: 77,
        transitionKind: "organic-grade-change",
        safetyScoreIdentity: {
          model: "v8",
          schemaVersion: 1,
          methodologyVersion: "8.17",
          evaluationBuildDigest: "d".repeat(64),
          baseInputGenerationId: BASE_INPUT_GENERATION_ID,
          publicationGenerationId: "report-cards:8.17:200",
        },
      },
    ]);
  });

  it("omits a malformed row while returning valid rows and the malformed count", async () => {
    const db = mockD1([
      {
        match: "FROM safety_score_history_v2",
        rows: [
          { ...v9BoundaryRow(), history_id: "malformed", recorded_at: 200, model: "v8" as const },
          v9BoundaryRow(),
        ],
      },
      { match: "cron_runs", rows: [] },
    ], { requireMatch: true });

    const response = await handleSafetyScoreHistoryV2(
      db,
      new URL("https://x/api/safety-score-history-v2?stablecoin=usdc-circle"),
    );
    const body = SafetyScoreHistoryV2ResponseSchema.parse(await readJsonResponse(response, 200));

    expect(body.history).toHaveLength(1);
    expect(body.history[0]?.safetyScoreIdentity.model).toBe("v9");
    expect(body.malformedRows).toBe(1);
  });

  it("returns 503 when persisted rows exist but none are valid", async () => {
    const db = mockD1([
      {
        match: "FROM safety_score_history_v2",
        rows: [{ ...v9BoundaryRow(), model: "v8" as const }],
      },
    ], { requireMatch: true });

    const response = await handleSafetyScoreHistoryV2(
      db,
      new URL("https://x/api/safety-score-history-v2?stablecoin=usdc-circle"),
    );

    await expect(readJsonResponse(response, 503)).resolves.toMatchObject({
      error: "Safety score history is temporarily unavailable",
    });
  });

  it("does not disguise an unrelated read failure as the all-malformed 503", async () => {
    const db = mockD1([
      { match: "FROM safety_score_history_v2", rows: [], throwError: new Error("D1_ERROR: internal error") },
    ]);

    await expect(handleSafetyScoreHistoryV2(
      db,
      new URL("https://x/api/safety-score-history-v2?stablecoin=usdc-circle"),
    )).rejects.toThrow("D1_ERROR");
  });

  it("returns an empty history with a current freshness fallback", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T12:00:00Z"));
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      { match: "FROM safety_score_history_v2", rows: [] },
      { match: "cron_runs", rows: [] },
    ], { requireMatch: true });

    const response = await handleSafetyScoreHistoryV2(
      db,
      new URL("https://x/api/safety-score-history-v2?stablecoin=usdc-circle"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ schemaVersion: 2, history: [], malformedRows: 0 });
    expect(response.headers.get("X-Data-Age")).toBe("0");
    expect(db.getHistory().find((entry) => entry.sql.includes("FROM safety_score_history_v2"))?.binds).toEqual([
      "usdc-circle",
      now - 365 * 86_400,
    ]);
  });

  it.each([
    ["unknown stablecoin", "?stablecoin=unknown-fixture", 404, "Unknown stablecoin"],
    ["malformed days", "?stablecoin=usdc-circle&days=abc", 400, "Invalid days: must be a number"],
    ["out-of-range days", "?stablecoin=usdc-circle&days=99999", 400, "Invalid days: must be between 1 and 3650"],
  ])("rejects %s before database work", async (_name, query, status, message) => {
    const db = mockD1([], { requireMatch: true });
    const response = await handleSafetyScoreHistoryV2(
      db,
      new URL(`https://x/api/safety-score-history-v2${query}`),
    );

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: message });
    expect(db.getHistory()).toEqual([]);
  });

  registerStablecoinParameterContract({
    name: "safety score history v2",
    path: "/api/safety-score-history-v2",
    invoke: handleSafetyScoreHistoryV2,
    cases: [{ kind: "missing" }],
  });
});
