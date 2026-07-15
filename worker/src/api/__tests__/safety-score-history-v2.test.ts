import { describe, expect, it } from "vitest";
import { SafetyScoreHistoryV2ResponseSchema } from "@shared/types/report-cards";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { handleSafetyScoreHistoryV2 } from "../safety-score-history-v2";

const DIGEST = "a".repeat(64);
const BASE_INPUT_GENERATION_ID = `report-cards-input:v1:${"b".repeat(64)}`;

describe("handleSafetyScoreHistoryV2", () => {
  it("returns non-comparable V9 boundary rows with full identity", async () => {
    const db = mockD1([
      {
        match: "FROM safety_score_history_v2",
        rows: [
          {
            history_id: "v9-boundary",
            stablecoin_id: "usdc-circle",
            recorded_at: 300,
            model: "v9",
            identity_schema_version: 1,
            methodology_version: "9.0",
            policy_id: "v9-rc-1",
            policy_digest: DIGEST,
            evaluation_build_digest: "c".repeat(64),
            base_input_generation_id: BASE_INPUT_GENERATION_ID,
            model_publication_generation_id: "safety-score-v9:300",
            transition_kind: "methodology-boundary-baseline",
            grade: "A",
            score: 88,
            prev_grade: null,
            prev_score: null,
          },
        ],
      },
      { match: "cron_runs", rows: [] },
    ]);

    const response = await handleSafetyScoreHistoryV2(
      db,
      new URL("https://x/api/safety-score-history-v2?stablecoin=usdc-circle"),
    );

    expect(response.status).toBe(200);
    const body = SafetyScoreHistoryV2ResponseSchema.parse(await response.json());
    expect(body).toMatchObject({
      schemaVersion: 2,
      history: [
        {
          transitionKind: "methodology-boundary-baseline",
          safetyScoreIdentity: {
            model: "v9",
            policyId: "v9-rc-1",
            policyDigest: DIGEST,
          },
        },
      ],
    });
  });

  it("requires a stablecoin selector", async () => {
    const response = await handleSafetyScoreHistoryV2(mockD1([]), new URL("https://x/api/safety-score-history-v2"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Missing ?stablecoin= parameter" });
  });
});
