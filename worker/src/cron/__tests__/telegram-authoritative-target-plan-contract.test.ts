import { describe, expect, it } from "vitest";
import {
  assertTelegramPlanMaterializationFitsD1Batch,
  parseTelegramTargetPlan,
  serializeTelegramTargetPlan,
  telegramPlanMaterializationBatchInvariant,
} from "../telegram-alert-target-plan-contract";
import {
  classifyTelegramPlanningOutcome,
  estimateTelegramTargetPlanCoordinatorBound,
} from "../telegram-alert-target-plans";
import { classifyTelegramTargetCounterBucket } from "../telegram-alert-job-target-outcomes";
import { emptyAlerts, type RoutedSubscriberAlert } from "../dispatch-telegram-routing";
import { parsePendingAlertProvenance } from "../../lib/telegram/pending-provenance";

function routed(): RoutedSubscriberAlert {
  const alerts = emptyAlerts();
  alerts.dews.push({
    stablecoinId: "usdc-circle",
    symbol: "USDC",
    oldBand: "CALM",
    newBand: "WARNING",
    score: 72,
    topSignals: [],
  });
  return {
    chatId: "42",
    lastActiveAt: 1_800_000_000,
    alerts,
    canonicalHtml: "<b>USDC</b> entered WARNING",
    chunks: ["<b>USDC</b> entered WARNING"],
    disableNotification: false,
    alertType: "dews",
    sourceEventId: "telegram-source:test:v1:contract",
    preferenceGeneration: 7,
    alertScope: [{ stablecoinId: "usdc-circle", family: "dews" }],
  };
}

describe("authoritative Telegram target plan contract", () => {
  it("bounds current and 5k manifest completion inside the risk TTL", () => {
    expect(estimateTelegramTargetPlanCoordinatorBound({
      subscriberCount: 800,
      targetCount: 800,
      maxSteps: 32,
    })).toEqual({ steps: 38, runs: 2 });
    expect(estimateTelegramTargetPlanCoordinatorBound({
      subscriberCount: 5_000,
      targetCount: 7_483,
      maxSteps: 32,
    })).toEqual({ steps: 281, runs: 9 });
  });

  it("round-trips a rendered plan and rejects digest corruption", async () => {
    const serialized = await serializeTelegramTargetPlan(routed(), 1_800_003_600);
    const parsed = await parseTelegramTargetPlan(serialized.payloadJson, serialized.payloadDigest);

    expect(parsed.kind).toBe("ok");
    if (parsed.kind === "ok") {
      expect(parsed.value.messages).toHaveLength(1);
      expect(parsed.value.preferenceGeneration).toBe(7);
      expect(parsed.value.itemKeys).toEqual(["dews:usdc-circle"]);
    }
    await expect(parseTelegramTargetPlan(`${serialized.payloadJson} `, serialized.payloadDigest))
      .resolves.toEqual({ kind: "invalid", reason: "target_plan_digest_mismatch" });
  });

  it("persists model identity with safety outbox plans and rejects unbound safety plans", async () => {
    const alerts = emptyAlerts();
    alerts.safety.push({
      stablecoinId: "usdc-circle",
      symbol: "USDC",
      oldGrade: "B",
      newGrade: "A",
      oldScore: 78,
      newScore: 91,
    });
    const safetyScoreIdentity = {
      model: "v9" as const,
      schemaVersion: 1 as const,
      methodologyVersion: "candidate-v9.0",
      policyId: "safety-score-v9",
      policyDigest: "a".repeat(64),
      evaluationBuildDigest: "b".repeat(64),
      baseInputGenerationId: `report-cards-input:v1:${"c".repeat(64)}`,
      publicationGenerationId: "report-cards:v9:1",
    };
    const safetyPlan: RoutedSubscriberAlert = {
      ...routed(),
      alerts,
      canonicalHtml: "<b>USDC</b> Safety B to A",
      chunks: ["<b>USDC</b> Safety B to A"],
      alertType: "safety",
      alertTypes: ["safety"],
      alertScope: [{ stablecoinId: "usdc-circle", family: "safety" }],
      safetyScoreIdentity,
    };

    const serialized = await serializeTelegramTargetPlan(safetyPlan, 1_800_003_600);
    expect(parsePendingAlertProvenance(serialized.payload.alertScopeJson)).toEqual({
      kind: "ok",
      value: {
        scope: [{ stablecoinId: "usdc-circle", family: "safety" }],
        safetyScoreIdentity,
      },
    });
    await expect(serializeTelegramTargetPlan(
      { ...safetyPlan, safetyScoreIdentity: undefined },
      1_800_003_600,
    )).rejects.toThrow("Safety Score identity");
  });

  it("keeps worst-case target and item materialization within one D1 batch", () => {
    const invariant = telegramPlanMaterializationBatchInvariant();
    expect(invariant.totalStatements).toBeLessThanOrEqual(invariant.batchLimit);
    expect(() => assertTelegramPlanMaterializationFitsD1Batch()).not.toThrow();
  });

  it("makes generation churn outcomes explicit without surprising historical opt-ins", () => {
    expect(classifyTelegramPlanningOutcome({
      initiallyEligible: true,
      currentEligible: true,
      generationChanged: true,
    })).toBe("target_planned");
    expect(classifyTelegramPlanningOutcome({
      initiallyEligible: true,
      currentEligible: false,
      generationChanged: true,
    })).toBe("preference_changed_ineligible");
    expect(classifyTelegramPlanningOutcome({
      initiallyEligible: false,
      currentEligible: true,
      generationChanged: true,
    })).toBe("eligible_after_event");
    expect(classifyTelegramPlanningOutcome({
      initiallyEligible: null,
      currentEligible: true,
      generationChanged: false,
    })).toBe("snapshot_missing");
  });

  it("assigns every target to exactly one counter bucket with final state precedence", () => {
    expect(classifyTelegramTargetCounterBucket({ status: "planned" })).toBe("planned");
    expect(classifyTelegramTargetCounterBucket({ status: "queued" })).toBe("enqueued");
    expect(classifyTelegramTargetCounterBucket({ status: "sent" })).toBe("accepted");
    expect(classifyTelegramTargetCounterBucket({ status: "failed" })).toBe("failed");
    expect(classifyTelegramTargetCounterBucket({ status: "expired" })).toBe("expired");
    expect(classifyTelegramTargetCounterBucket({ status: "queued", cancelledAt: 1 })).toBe("cancelled");
    expect(classifyTelegramTargetCounterBucket({
      status: "queued",
      finalDeliveryState: "execution_unknown",
      cancelledAt: 1,
    })).toBe("execution_unknown");
    expect(classifyTelegramTargetCounterBucket({
      status: "expired",
      finalDeliveryState: "accepted",
      effectState: "execution_unknown",
    })).toBe("accepted");
  });
});
