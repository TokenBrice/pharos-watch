import { describe, expect, it } from "vitest";
import {
  NEW_ASSET_GATE_OVERRIDE_LABEL,
  NEW_ASSET_OPEN_QUESTION_LIMIT,
  NewAssetAdmissionReceiptSchema,
  classifyNewAssetGateCandidates,
  evaluateNewAssetEvidencePacket,
  isPerCoinAssetPath,
  parseCoinAdmissionSnapshot,
  type NewAssetGateCandidate,
  type NewAssetGateReport,
} from "../ci/check-new-asset-evidence-packet";

const REGISTRY_FINGERPRINT = "a".repeat(64);
const CAPTURE_ID = "20261029T1814Z";
const CAPTURE_CLOCK_SEC = 1_793_294_244;

type FixtureBucket = "open" | "issuer" | "documentation";

interface QuestionFixture {
  questionKey: string;
  bucket: FixtureBucket;
  inherited?: boolean;
  obligations?: number;
  codes?: Array<{ code: string; obligations?: number; documentation?: boolean }>;
}

function receiptJson({
  assetId = "newcoin-test",
  registryFingerprint = REGISTRY_FINGERPRINT,
  questions,
  card = {},
}: {
  assetId?: string;
  registryFingerprint?: string;
  questions: QuestionFixture[];
  card?: Record<string, unknown>;
}): string {
  const open = questions.filter((question) => question.bucket === "open");
  return JSON.stringify({
    schemaVersion: 1,
    kind: "safety-score-v9-new-asset-admission-receipt",
    assetId,
    captureId: CAPTURE_ID,
    captureClockSec: CAPTURE_CLOCK_SEC,
    registryFingerprint,
    card: {
      id: assetId,
      openQuestionsCarried: open.length,
      inheritedOpenQuestionsCarried: open.filter((question) => question.inherited === true).length,
      openObligationsCarried: open.reduce((total, question) => total + (question.obligations ?? 1), 0),
      documentationObligationsCarried: questions.reduce(
        (total, question) => total +
          (question.codes ?? []).filter((code) => code.documentation === true)
            .reduce((datumTotal, code) => datumTotal + (code.obligations ?? 1), 0),
        0,
      ),
      ...card,
    },
    questions: questions.map((question) => ({
      questionKey: question.questionKey,
      bucket: question.bucket,
      inherited: question.inherited === true,
      obligations: question.obligations ?? 1,
      codes: (question.codes ?? [{ code: "unresolved-control-identity" }]).map((code) => ({
        code: code.code,
        obligations: code.obligations ?? 1,
        documentation: code.documentation === true,
      })),
    })),
  });
}

function candidate(assetId = "newcoin-test", origin: "listing" | "promotion" = "listing"): NewAssetGateCandidate {
  return { assetId, path: `shared/data/stablecoins/coins/${assetId}.json`, origin };
}

function openQuestions(count: number, prefix = "newcoin-test"): QuestionFixture[] {
  return Array.from({ length: count }, (_, index) => ({
    questionKey: `${prefix}|component|datum-${index}`,
    bucket: "open" as const,
    codes: [{ code: "unresolved-control-identity" }],
  }));
}

function evaluate(receipt: string | null, { override = false, assetId = "newcoin-test" } = {}) {
  return evaluateNewAssetEvidencePacket({
    candidates: [candidate(assetId)],
    registryFingerprint: REGISTRY_FINGERPRINT,
    override,
    readReceipt: () => receipt,
  });
}

function failKinds(report: NewAssetGateReport): string[] {
  return [...new Set(report.failures.map((failure) => failure.kind))].sort();
}

describe("new-asset evidence packet gate", () => {
  it("fails a synthetic listing that would publish more than six open questions", () => {
    const report = evaluate(receiptJson({ questions: openQuestions(NEW_ASSET_OPEN_QUESTION_LIMIT + 1) }));

    expect(failKinds(report)).toEqual(["open-question-limit"]);
    expect(report.failures[0]?.message).toContain("7 open questions");
    expect(report.failures[0]?.message).toContain("newcoin-test|component|datum-6");
    expect(report.passed).toEqual([]);
  });

  it("admits exactly the limit and rejects the next question", () => {
    expect(failKinds(evaluate(receiptJson({ questions: openQuestions(NEW_ASSET_OPEN_QUESTION_LIMIT) })))).toEqual([]);
    expect(failKinds(evaluate(receiptJson({ questions: openQuestions(NEW_ASSET_OPEN_QUESTION_LIMIT + 1) }))))
      .toEqual(["open-question-limit"]);
  });

  it("passes the same addition under the owner override label and records the override", () => {
    const report = evaluate(
      receiptJson({ questions: openQuestions(NEW_ASSET_OPEN_QUESTION_LIMIT + 3) }),
      { override: true },
    );

    expect(report.failures).toEqual([]);
    expect(report.passed).toHaveLength(1);
    expect(report.passed[0]).toMatchObject({ assetId: "newcoin-test", openQuestions: 9, overridden: true });
    expect(report.warnings.join("\n")).toContain(NEW_ASSET_GATE_OVERRIDE_LABEL);
  });

  it("does not fail a documentation-class mint datum but fails a counted one, with or without the override", () => {
    const documentationMint = evaluate(receiptJson({
      questions: [{
        questionKey: "newcoin-test|control|control:mint:supervision",
        bucket: "documentation",
        codes: [{ code: "missing-mint-authority", documentation: true }],
      }],
    }));
    expect(documentationMint.failures).toEqual([]);
    expect(documentationMint.passed).toHaveLength(1);

    const countedMint = receiptJson({
      questions: [{
        questionKey: "newcoin-test|control|control:mint",
        bucket: "open",
        codes: [{ code: "missing-mint-authority" }],
      }],
    });
    for (const override of [false, true]) {
      const report = evaluate(countedMint, { override });
      expect(failKinds(report)).toEqual(["missing-mint-authority"]);
      expect(report.failures[0]?.message).toContain("no override");
    }
  });

  it("counts only questions rooted at the asset, not questions inherited from a parent", () => {
    const inherited = openQuestions(5, "parent-coin").map((question) => ({ ...question, inherited: true }));
    const report = evaluate(receiptJson({ questions: [...openQuestions(2), ...inherited] }));

    expect(report.failures).toEqual([]);
    expect(report.passed[0]).toMatchObject({ openQuestions: 2, inheritedOpenQuestions: 5, overridden: false });
  });

  it("rejects a missing, stale, mismatched, malformed or self-contradicting receipt", () => {
    const valid = receiptJson({ questions: openQuestions(1) });

    expect(failKinds(evaluate(null))).toEqual(["missing-receipt"]);
    expect(failKinds(evaluate(receiptJson({
      registryFingerprint: "b".repeat(64),
      questions: openQuestions(1),
    })))).toEqual(["stale-receipt"]);
    expect(failKinds(evaluate(receiptJson({ assetId: "another-coin", questions: openQuestions(1) })))).toEqual([
      "mismatched-receipt",
    ]);
    expect(failKinds(evaluate("{not json"))).toEqual(["invalid-receipt"]);
    expect(failKinds(evaluate(receiptJson({
      questions: openQuestions(2),
      card: { openQuestionsCarried: 1 },
    })))).toEqual(["invalid-receipt"]);
    expect(failKinds(evaluate(valid))).toEqual([]);
  });

  it("binds the receipt's published card row to its own question list", () => {
    const inconsistent = JSON.parse(receiptJson({
      questions: [{ ...openQuestions(1)[0]!, codes: [{ code: "missing-mint-authority" }] }],
      card: { documentationObligationsCarried: 1 },
    })) as unknown;
    expect(NewAssetAdmissionReceiptSchema.safeParse(inconsistent).success).toBe(false);
    expect(NewAssetAdmissionReceiptSchema.safeParse(JSON.parse(receiptJson({ questions: openQuestions(1) }))).success).toBe(true);
  });
});

describe("new-asset gate candidate detection", () => {
  const coin = (id: string, status?: "active" | "pre-launch" | "frozen") => ({ id, status });

  it("gates an added active asset and a pre-launch promotion, and leaves existing assets untouched", () => {
    const result = classifyNewAssetGateCandidates({
      addedPaths: [
        "shared/data/stablecoins/coins/new-active.json",
        "shared/data/stablecoins/coins/new-stub.json",
      ],
      modifiedPaths: [
        "shared/data/stablecoins/coins/promoted-coin.json",
        "shared/data/stablecoins/coins/existing-coin.json",
        "shared/data/stablecoins/coins/still-stub.json",
      ],
      readHeadCoin: (path) => {
        if (path.endsWith("new-active.json")) return coin("new-active");
        if (path.endsWith("new-stub.json")) return coin("new-stub", "pre-launch");
        if (path.endsWith("promoted-coin.json")) return coin("promoted-coin");
        if (path.endsWith("existing-coin.json")) return coin("existing-coin");
        return coin("still-stub", "pre-launch");
      },
      readBaseCoin: (path) => {
        if (path.endsWith("promoted-coin.json")) return coin("promoted-coin", "pre-launch");
        if (path.endsWith("existing-coin.json")) return coin("existing-coin");
        return coin("still-stub", "pre-launch");
      },
    });

    expect(result.candidates).toEqual([
      { assetId: "new-active", path: "shared/data/stablecoins/coins/new-active.json", origin: "listing" },
      { assetId: "promoted-coin", path: "shared/data/stablecoins/coins/promoted-coin.json", origin: "promotion" },
    ]);
    expect(result.skipped).toEqual([
      { path: "shared/data/stablecoins/coins/new-stub.json", reason: "not-a-listing (pre-launch)" },
      { path: "shared/data/stablecoins/coins/existing-coin.json", reason: "existing-asset" },
      { path: "shared/data/stablecoins/coins/still-stub.json", reason: "not-a-promotion (pre-launch)" },
    ]);
  });

  it("never gates a PR with no addition or promotion", () => {
    const result = classifyNewAssetGateCandidates({
      addedPaths: [],
      modifiedPaths: ["shared/data/stablecoins/coins/existing-coin.json"],
      readHeadCoin: () => coin("existing-coin"),
      readBaseCoin: () => coin("existing-coin"),
    });

    expect(result.candidates).toEqual([]);
    expect(result.skipped).toEqual([
      { path: "shared/data/stablecoins/coins/existing-coin.json", reason: "existing-asset" },
    ]);
    expect(evaluateNewAssetEvidencePacket({
      candidates: result.candidates,
      registryFingerprint: REGISTRY_FINGERPRINT,
      override: false,
      readReceipt: () => null,
    })).toEqual({ candidates: [], passed: [], failures: [], warnings: [] });
  });

  it("reads only the admission fields and treats a malformed coin file as unreadable", () => {
    expect(parseCoinAdmissionSnapshot('{"id":"usdc-circle","name":"USD Coin"}')).toEqual({
      id: "usdc-circle",
      status: undefined,
    });
    expect(parseCoinAdmissionSnapshot('{"id":"stub","status":"pre-launch"}')).toEqual({
      id: "stub",
      status: "pre-launch",
    });
    expect(parseCoinAdmissionSnapshot('{"status":"active"}')).toBeNull();
    expect(parseCoinAdmissionSnapshot('{"id":"coin","status":"paused"}')).toBeNull();
    expect(parseCoinAdmissionSnapshot("not json")).toBeNull();
  });

  it("recognises only direct per-coin asset files", () => {
    expect(isPerCoinAssetPath("shared/data/stablecoins/coins/usdc-circle.json")).toBe(true);
    expect(isPerCoinAssetPath("shared/data/stablecoins/coins/domains/usdc-circle.json")).toBe(false);
    expect(isPerCoinAssetPath("shared/data/stablecoins/domains/reserves/usdc-circle.json")).toBe(false);
    expect(isPerCoinAssetPath("shared/data/stablecoins/canonical-order.json")).toBe(false);
  });
});
