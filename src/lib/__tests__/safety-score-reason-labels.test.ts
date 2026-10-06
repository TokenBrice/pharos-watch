import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  describeEvaluatorKey,
  describeExcludedScoreComponent,
  describeExitRouteVenue,
  groupSafetyScoreReasons,
  humanizeSafetyScoreReason,
} from "@/lib/safety-score-reason-labels";

describe("safety score reason labels", () => {
  it("drops integer and decimal version pins while preserving malformed tokens", () => {
    for (const version of ["v9", "v10.09", "v12.345"]) {
      expect(humanizeSafetyScoreReason(`${version}\tExit routes remain unresolved.`))
        .toBe("Exit routes remain unresolved.");
    }
    for (const token of ["v10X", "v10.09X", "v10.", "av10.09", "v10.09"]) {
      expect(humanizeSafetyScoreReason(`${token}X`)).toBe(`${token}X`);
    }
    expect(humanizeSafetyScoreReason("v10.09")).toBe("v10.09");
  });

  it("rounds embedded and adjacent long decimals without losing their prefixes", () => {
    expect(humanizeSafetyScoreReason("1.23456, -2.34567, a3.45678; 4.56789.5.67891"))
      .toBe("1.235, -2.346, a3.457; 4.568.5.679");
    expect(humanizeSafetyScoreReason("1.234 stays; 12.345X stays; .12345 stays"))
      .toBe("1.234 stays; 12.345X stays; .12345 stays");
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

  it("resolves evaluator keys to display names", () => {
    expect(describeEvaluatorKey("chain:solana")).toBe("Solana");
    expect(describeEvaluatorKey("bridge-route:protocol:chainlink-ccip")).toBe("Chainlink CCIP");
    expect(describeEvaluatorKey("bridge-meta:susde-ethena:02f0be89d79d3a6b4f02")).toBe("a bridge route");
    expect(describeEvaluatorKey("mechanism:loss-absorption")).toBe("the loss absorption review");
  });

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

  it("rewrites condition reasons without leaking keys", () => {
    expect(humanizeSafetyScoreReason("unsafe-backing condition at mechanism:loss-absorption."))
      .toBe("Unsafe backing condition flagged in the loss absorption review");
  });

  it("folds repeated datum reasons per key class and counts each raw message once", () => {
    const messages = ["a1", "b2", "c3"].map(
      (hash) => `The materialSupplyShare datum for independently identified control bridge-meta:coin:${hash} remains unresolved.`,
    );
    const groups = groupSafetyScoreReasons([...messages, ...messages, "Exit routes share a failure domain"]);
    expect(groups.map((group) => [group.text, group.count])).toEqual([
      ["Bridged supply share unresolved on 3 bridge routes", 3],
      ["Exit routes share a failure domain", 1],
    ]);
  });

  it("keeps a single datum reason singular", () => {
    expect(groupSafetyScoreReasons([
      "The materialSupplyShare datum for independently identified control bridge-meta:coin:a1 remains unresolved.",
    ])[0]?.text).toBe("Bridged supply share unresolved for a bridge route");
  });

  it("names DEX exit venues instead of AMM ordinals", () => {
    expect(describeExitRouteVenue({ label: "Ethereum AMM 10", routeFamily: "dex-amm", capacity: { chain: "ethereum", protocol: "curve" } }))
      .toBe("Curve on Ethereum");
    expect(describeExitRouteVenue({ label: "Base AMM 3", routeFamily: "dex-amm", capacity: null })).toBe("DEX pool on Base");
    expect(describeExitRouteVenue({ label: "PSM swap", routeFamily: "protocol-redemption" })).toBe("PSM swap");
  });

  it("describes excluded score components in plain words", () => {
    expect(describeExcludedScoreComponent(
      "redemption:redemption:30a5bff0-25a2-4615-9279-cd046fa1a618:redemption:usdc-circle:offchain-issuer:cost",
    )).toBe("issuer redemption cost");
    expect(describeExcludedScoreComponent("dependency:parent")).toBe("the parent asset's score");
  });
});
