import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { REPORT_CARDS_BASE_INPUT_GENERATION_ID_PREFIX } from "@shared/lib/report-cards-base-input-identity";
import { SAFETY_SCORE_V9_ACTIVE_MAX_ASSETS, SAFETY_SCORE_V9_CATALOG_MAX_ASSETS } from "@shared/lib/safety-score-v9-capacity-limits";
import {
  NEW_ASSET_ADMISSION_CLOCK_MAX_AGE_SEC,
  NEW_ASSET_GATE_OVERRIDE_LABEL,
  NEW_ASSET_OPEN_QUESTION_LIMIT,
  NEW_ASSET_RECEIPT_DIR,
  NewAssetAdmissionReceiptSchema,
  PROSPECTIVE_ABSENT_RUNTIME_LANES,
  PROSPECTIVE_ADMISSION_INPUT_ID_PREFIX,
  classifyNewAssetGateCandidates,
  evaluateNewAssetEvidencePacket,
  isPerCoinAssetPath,
  parseCoinAdmissionSnapshot,
  type EvaluateNewAssetEvidencePacketInput,
  type NewAssetGateCandidate,
  type NewAssetGateReport,
} from "../ci/check-new-asset-evidence-packet";

const REGISTRY_FINGERPRINT = "a".repeat(64);
const EVALUATION_BUILD_DIGEST = "e".repeat(64);
const CAPTURE_ID = "20261029T1814Z";
const CAPTURE_CLOCK_SEC = 1_793_294_244;
const NOW_SEC = 1_795_440_000;
const PROSPECTIVE_INPUT_ID = `${PROSPECTIVE_ADMISSION_INPUT_ID_PREFIX}${"d".repeat(64)}`;

type FixtureBucket = "open" | "issuer" | "documentation";

interface QuestionFixture {
  questionKey: string;
  bucket: FixtureBucket;
  inherited?: boolean;
  obligations?: number;
  codes?: Array<{ code: string; obligations?: number; documentation?: boolean }>;
}

function buildCardAndQuestions(assetId: string, questions: QuestionFixture[], card: Record<string, unknown> = {}) {
  const open = questions.filter((question) => question.bucket === "open");
  return {
    card: {
      id: assetId,
      openBucketQuestionsCarried: open.length,
      inheritedOpenBucketQuestionsCarried: open.filter((question) => question.inherited === true).length,
      openBucketObligationsCarried: open.reduce((total, question) => total + (question.obligations ?? 1), 0),
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
  };
}

function receiptJson({
  schemaVersion = 3,
  assetId = "newcoin-test",
  registryFingerprint = REGISTRY_FINGERPRINT,
  evaluationBuildDigest = EVALUATION_BUILD_DIGEST,
  questions,
  card = {},
}: {
  schemaVersion?: 1 | 2 | 3;
  assetId?: string;
  registryFingerprint?: string;
  evaluationBuildDigest?: string;
  questions: QuestionFixture[];
  card?: Record<string, unknown>;
}): string {
  return JSON.stringify({
    schemaVersion,
    ...(schemaVersion === 3 ? { receiptMode: "production-capture" } : {}),
    kind: "safety-score-v9-new-asset-admission-receipt",
    assetId,
    captureId: CAPTURE_ID,
    captureClockSec: CAPTURE_CLOCK_SEC,
    registryFingerprint,
    ...(schemaVersion >= 2 ? { evaluationBuildDigest } : {}),
    ...buildCardAndQuestions(assetId, questions, card),
  });
}

function prospectiveReceiptJson({
  assetId = "newcoin-test",
  admissionClockSec = NOW_SEC - 3_600,
  observedAtSec = NOW_SEC - 7_200,
  retrievedAtSec = NOW_SEC - 3_600,
  evaluatedCohortIds = [assetId],
  registryFingerprint = REGISTRY_FINGERPRINT,
  evaluationBuildDigest = EVALUATION_BUILD_DIGEST,
  questions = openQuestions(2, assetId),
  card = {},
}: {
  assetId?: string;
  admissionClockSec?: number;
  observedAtSec?: number | null;
  retrievedAtSec?: number;
  evaluatedCohortIds?: string[];
  registryFingerprint?: string;
  evaluationBuildDigest?: string;
  questions?: QuestionFixture[];
  card?: Record<string, unknown>;
} = {}): string {
  return JSON.stringify({
    schemaVersion: 3,
    receiptMode: "prospective-offline",
    kind: "safety-score-v9-new-asset-admission-receipt",
    assetId,
    prospectiveInputId: PROSPECTIVE_INPUT_ID,
    admissionClockSec,
    evaluatedCohortIds,
    absentRuntimeLanes: [...PROSPECTIVE_ABSENT_RUNTIME_LANES],
    supplyObservation: {
      circulating: { peggedUSD: 1_500_000 },
      observedAtSec,
      url: "https://api.example/supply",
      field: "circulating.peggedUSD",
      retrievedAtSec,
    },
    registryFingerprint,
    evaluationBuildDigest,
    ...buildCardAndQuestions(assetId, questions, card),
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

function evaluate(
  receipt: string | null,
  {
    override = false,
    assetId = "newcoin-test",
    evaluationBuildDigest = EVALUATION_BUILD_DIGEST,
    activeAssetCount = SAFETY_SCORE_V9_ACTIVE_MAX_ASSETS,
    catalogAssetCount = SAFETY_SCORE_V9_CATALOG_MAX_ASSETS,
    nowSec = NOW_SEC,
    verifyProspectiveReceipt,
  }: {
    override?: boolean;
    assetId?: string;
    evaluationBuildDigest?: string;
    activeAssetCount?: number;
    catalogAssetCount?: number;
    nowSec?: number;
    verifyProspectiveReceipt?: EvaluateNewAssetEvidencePacketInput["verifyProspectiveReceipt"];
  } = {},
) {
  return evaluateNewAssetEvidencePacket({
    candidates: [candidate(assetId)],
    registryFingerprint: REGISTRY_FINGERPRINT,
    evaluationBuildDigest,
    activeAssetCount,
    catalogAssetCount,
    nowSec,
    override,
    readReceipt: () => receipt,
    ...(verifyProspectiveReceipt === undefined ? {} : { verifyProspectiveReceipt }),
  });
}

function failKinds(report: NewAssetGateReport): string[] {
  return [...new Set(report.failures.map((failure) => failure.kind))].sort();
}

describe("new-asset evidence packet gate", () => {
  it("accepts a base generation and the full canonical admission suffix", () => {
    const assetId = "isc-international-stable-currency";
    const captureId = `${REPORT_CARDS_BASE_INPUT_GENERATION_ID_PREFIX}${"a".repeat(64)}+admit:${assetId}`;
    const receipt = { ...JSON.parse(receiptJson({ assetId, questions: [] })), captureId };
    expect(evaluate(JSON.stringify(receipt), { assetId }).passed[0]?.captureId).toBe(captureId);
  });

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
      card: { openBucketQuestionsCarried: 1 },
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

  it("rejects a mismatched evaluationBuildDigest or historical v1/v2 receipt on a newly gated asset even under override", () => {
    const staleBuild = receiptJson({
      evaluationBuildDigest: "f".repeat(64),
      questions: openQuestions(1),
    });
    const legacyV1 = receiptJson({ schemaVersion: 1, questions: openQuestions(1) });
    const legacyV2 = receiptJson({ schemaVersion: 2, questions: openQuestions(1) });

    expect(NewAssetAdmissionReceiptSchema.safeParse(JSON.parse(legacyV1)).success).toBe(true);
    expect(NewAssetAdmissionReceiptSchema.safeParse(JSON.parse(legacyV2)).success).toBe(true);
    for (const override of [false, true]) {
      for (const receipt of [staleBuild, legacyV1, legacyV2]) {
        const report = evaluate(receipt, { override });
        expect(failKinds(report)).toEqual(["stale-evaluation-build"]);
        expect(report.passed).toEqual([]);
      }
    }
  });

  it("enforces active and catalog V9 capacity caps without override", () => {
    const valid = receiptJson({ questions: openQuestions(1) });
    expect(failKinds(evaluate(valid))).toEqual([]);
    const catalogOnly = (catalogAssetCount: number, override = false) => evaluateNewAssetEvidencePacket({
      candidates: [], registryFingerprint: REGISTRY_FINGERPRINT, catalogAssetCount, override, readReceipt: () => null,
    });
    expect(failKinds(catalogOnly(SAFETY_SCORE_V9_CATALOG_MAX_ASSETS))).toEqual([]);
    for (const override of [false, true]) {
      for (const [opts, kind] of [
        [{ activeAssetCount: SAFETY_SCORE_V9_ACTIVE_MAX_ASSETS + 1 }, "active-capacity-exceeded"],
        [{ catalogAssetCount: SAFETY_SCORE_V9_CATALOG_MAX_ASSETS + 1 }, "catalog-capacity-exceeded"],
      ] as const) {
        const report = evaluate(valid, { ...opts, override });
        expect(failKinds(report)).toEqual([kind]);
        expect(report.passed).toEqual([]);
      }
      const over = catalogOnly(SAFETY_SCORE_V9_CATALOG_MAX_ASSETS + 1, override);
      expect(failKinds(over)).toEqual(["catalog-capacity-exceeded"]);
      expect(over.failures[0]).toMatchObject({ assetId: "catalog", origin: "catalog" });
    }
    expect(failKinds(evaluate(valid, {
      activeAssetCount: SAFETY_SCORE_V9_ACTIVE_MAX_ASSETS + 1,
      catalogAssetCount: SAFETY_SCORE_V9_CATALOG_MAX_ASSETS + 1,
    }))).toEqual(["active-capacity-exceeded", "catalog-capacity-exceeded"]);
  });

  it("verifies prospective-offline receipts fail-closed and enforces the dedicated 7d admission clock bound", () => {
    expect(NEW_ASSET_ADMISSION_CLOCK_MAX_AGE_SEC).toBe(7 * 86_400);
    const valid = prospectiveReceiptJson();

    const admitted = evaluate(valid, { verifyProspectiveReceipt: () => ({ ok: true }) });
    expect(admitted.failures).toEqual([]);
    expect(admitted.passed[0]).toMatchObject({
      assetId: "newcoin-test",
      receiptMode: "prospective-offline",
      captureId: null,
      prospectiveInputId: PROSPECTIVE_INPUT_ID,
      openQuestions: 2,
    });

    // Fail-closed when verifier is omitted or returns a typed refusal (never overridable).
    for (const override of [false, true]) {
      expect(failKinds(evaluate(valid, { override }))).toEqual(["recomputed-receipt-mismatch"]);
      for (const kind of [
        "recomputed-receipt-mismatch",
        "prospective-asset-quarantined",
        "prospective-parent-pipeline-gap",
      ] as const) {
        const refused = evaluate(valid, {
          override,
          verifyProspectiveReceipt: () => ({ ok: false, kind, message: `refused:${kind}` }),
        });
        expect(failKinds(refused)).toEqual([kind]);
        expect(refused.passed).toEqual([]);
      }
    }

    // Clock bounds: future, >7d stale, and supply observation after min(admissionClockSec, retrievedAtSec).
    const staleCases = [
      prospectiveReceiptJson({ admissionClockSec: NOW_SEC + 1 }),
      prospectiveReceiptJson({ admissionClockSec: NOW_SEC - NEW_ASSET_ADMISSION_CLOCK_MAX_AGE_SEC - 1 }),
      prospectiveReceiptJson({ admissionClockSec: NOW_SEC - 3_600, retrievedAtSec: NOW_SEC - 1_800, observedAtSec: NOW_SEC - 3_599 }),
      prospectiveReceiptJson({ admissionClockSec: NOW_SEC - 1_800, retrievedAtSec: NOW_SEC - 3_600, observedAtSec: NOW_SEC - 3_599 }),
    ];
    for (const receipt of staleCases) {
      const report = evaluate(receipt, { override: true, verifyProspectiveReceipt: () => ({ ok: true }) });
      expect(failKinds(report)).toEqual(["stale-admission-clock"]);
    }

    // Exact 7d boundary and clockless supply observation (observedAtSec: null) are admitted.
    const boundary = prospectiveReceiptJson({
      admissionClockSec: NOW_SEC - NEW_ASSET_ADMISSION_CLOCK_MAX_AGE_SEC,
      observedAtSec: null,
    });
    expect(failKinds(evaluate(boundary, { verifyProspectiveReceipt: () => ({ ok: true }) }))).toEqual([]);
  });

  it("allows mixed documentation/counted datums for the same reason code on one question", () => {
    const mixed = receiptJson({
      questions: [{
        questionKey: "newcoin-test|component|economic-control:mint",
        bucket: "open",
        obligations: 2,
        codes: [
          { code: "missing-mint-authority", obligations: 1, documentation: false },
          { code: "missing-mint-authority", obligations: 1, documentation: true },
        ],
      }],
    });
    expect(NewAssetAdmissionReceiptSchema.safeParse(JSON.parse(mixed)).success).toBe(true);
    expect(failKinds(evaluate(mixed))).toEqual(["missing-mint-authority"]);
  });

  it("keeps every committed historical receipt parseable under NewAssetAdmissionReceiptSchema", () => {
    const receiptDir = resolve(import.meta.dirname, "../..", NEW_ASSET_RECEIPT_DIR);
    const files = readdirSync(receiptDir).filter((name) => name.endsWith(".json")).sort();
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const file of files) {
      const parsed = JSON.parse(readFileSync(resolve(receiptDir, file), "utf8")) as unknown;
      expect(NewAssetAdmissionReceiptSchema.safeParse(parsed).success, file).toBe(true);
    }
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
