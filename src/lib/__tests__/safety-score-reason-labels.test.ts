import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { SAFETY_SCORE_GAP_CAUSE_LABELS } from "@shared/lib/classification";
import {
  humanizeSafetyScoreReason,
  describePartialEvidence,
  formatPartialEvidenceGap,
} from "@/lib/safety-score-reason-labels";

describe("safety score reason labels", () => {
  it.each([
    { pillar: "backing" as const, cause: "C" as const, score: 35, label: "Backing undisclosed by issuer" },
    { pillar: "exit" as const, cause: "U" as const, score: 50, label: "Exit unresolved" },
    { pillar: "control" as const, cause: "U" as const, score: 60, label: "Control unresolved" },
  ])("describes the priced $pillar cause without inventing a pipeline failure", ({ pillar, cause, score, label }) => {
    const pillars = { backing: { score: 80 }, exit: { score: 70 }, control: { score: 60 }, [pillar]: { score: null, aggregationDisposition: "unavailable", pricedUnknown: { cause, score } } };
    const result = describePartialEvidence({ ratingStatus: "rated", pillars,
      partialEvidence: { reasonCode: "partial-evidence-pipeline-gap", excludedPillars: [pillar], causes: [] } })!;
    expect(result.gaps.map(formatPartialEvidenceGap)).toEqual([`${label} (assumed ${score})`]);
    expect(result.summary).toContain(`${score}/100`);
    expect(result.summary).not.toContain("pipeline");
  });

  it("describes phase-1 table and neighborhood gaps without inventing a cause or score", () => {
    const partialEvidence = { excludedPillars: ["exit"], causes: [] };
    const table = describePartialEvidence({ ratingStatus: "rated", partialEvidence,
      pillars: { backing: { score: 80 }, exit: { score: null, aggregationDisposition: "unavailable" }, control: { score: 70 } } })!;
    expect(table.gaps.map(formatPartialEvidenceGap)).toEqual(["Exit unknown"]);
    expect(table.summary).toBe("Exit has no usable evidence; the score uses an assumed value in its place.");
    const neighborhood = describePartialEvidence({ partialEvidence })!;
    expect(neighborhood.gaps.map(formatPartialEvidenceGap)).toEqual(["Exit unavailable"]);
    expect(neighborhood.summary).toBe("Exit has no usable evidence.");
    expect(`${table.summary} ${neighborhood.summary}`).not.toMatch(/\d|pipeline|unresolved|undisclosed/);
  });

  it("keeps reduced cause-B projections distinct from pipeline gaps", () => {
    const result = describePartialEvidence({ ratingStatus: "rated",
      partialEvidence: { excludedPillars: ["exit"], causes: ["B"] } })!;
    expect(result.gaps.map(formatPartialEvidenceGap)).toEqual(["Exit excluded · awaiting curation"]);
    expect(result.summary).not.toContain("pipeline");
  });

  it("names cause A as a data-pipeline unavailability, not the technical pipeline-gap status", () => {
    expect(SAFETY_SCORE_GAP_CAUSE_LABELS.A).toBe("data pipeline unavailable");
    const result = describePartialEvidence({ ratingStatus: "rated",
      partialEvidence: { excludedPillars: ["exit"], causes: ["A"] } })!;
    expect(result.gaps.map(formatPartialEvidenceGap)).toEqual(["Exit excluded · data pipeline unavailable"]);
    expect(result.summary).toContain("data pipeline unavailable");
  });
  it("handles long malformed digit runs through the public humanizer in a bounded child", () => {
    // A process timeout contains a regression in either synchronous regex;
    // this is a generous safety bound, not a machine-speed microbenchmark.
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
      import assert from "node:assert/strict";
      import { humanizeSafetyScoreReason, groupSafetyScoreReasons } from "./src/lib/safety-score-reason-labels.ts";
      const digits = "1".repeat(200_000);
      for (const token of ["v" + digits + "X", "v" + digits + ".12X", "a" + digits + "X"]) {
        const message = "The reserve factor for " + token + " is unresolved.";
        assert.equal(humanizeSafetyScoreReason(message), message);
        assert.deepEqual(groupSafetyScoreReasons([message, message]).map(({ text, count }) => ({ text, count })),
          [{ text: message, count: 1 }]);
      }
    `], { cwd: process.cwd(), timeout: 15_000, encoding: "utf8" });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  }, 20_000);

  it("keeps a conservative upper bound and its band instead of stating it as a measurement", () => {
    const share = humanizeSafetyScoreReason(
      "This asset's own reviewed share is 10% at chain:solana, conservative non-mature exposure upper bound from 10% to below 25% (also 73 reviewed paths across 57 assets share chain:solana).",
    );
    expect(share).toBe(
      "Up to 10% of reviewed supply is deployed on Solana (conservative upper bound; deployment exposure; 10%–25% band), shared by 73 paths across 57 assets",
    );
    expect(share).not.toMatch(/depends on|chain:/);
  });

  it("states a measured share as measured and keeps its deployment scope", () => {
    const proven = humanizeSafetyScoreReason(
      "This asset's own reviewed share is 12.5% at mint-control:usdc-minter-admin, proven deployment exposure from 10% to below 25% (also 4 reviewed paths across 3 independent root liabilities share mint-control:usdc-minter-admin).",
    );
    expect(proven).toMatch(/^12\.5% of reviewed supply sits on deployments controlled by /);
    expect(proven).toContain("(deployment exposure; 10%–25% band)");
    expect(proven).not.toMatch(/Up to|upper bound/);
    expect(proven).toMatch(/across 3 issuers$/);

    const floor = humanizeSafetyScoreReason(
      "This asset's own reviewed share is 31% at chain:tron, conservative exposure upper bound at or above 25% (also 10 reviewed paths across 10 assets share chain:tron).",
    );
    expect(floor).toBe(
      "Up to 31% of reviewed supply is deployed on Tron (conservative upper bound; deployment exposure; at or above the 25% threshold), shared by 10 paths across 10 assets",
    );
  });

  it("describes a DEX venue share as reference exit-request coverage, not supply", () => {
    // Producer shape: domainKey(`dex-protocol`) + commonModeReasonQualifier("dex-protocol", "moderate", …).
    const dex = humanizeSafetyScoreReason(
      "This asset's own reviewed share is 18.4% at dex-protocol:uniswap-v3, reviewed non-mature exposure from 10% to below 25% (also 12 reviewed paths across 9 assets share dex-protocol:uniswap-v3).",
    );
    expect(dex).toBe(
      "The Uniswap V3 venue can fill up to 18.4% of the reference exit request (upper bound; exit-access exposure; 10%–25% band), shared by 12 paths across 9 assets",
    );
    expect(dex).not.toMatch(/reviewed supply|dex-protocol:/);
    expect(humanizeSafetyScoreReason("12 reviewed paths across 9 assets share dex-protocol:curve, unknown venue concentration."))
      .not.toContain("dex-protocol:");
  });

});
