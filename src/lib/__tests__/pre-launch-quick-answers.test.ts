import { describe, expect, it } from "vitest";
import { buildPreLaunchQuickAnswers, firstOneLinerClause } from "@/lib/pre-launch-quick-answers";

const base = {
  symbol: "QEUR",
  launchPhase: "announced" as const,
  expectedLaunchDate: "2026-Q4",
  announcedDate: "2025-09",
  oneLiner: "QEUR is a pre-launch euro stablecoin from Qivalis, a 37-bank consortium.",
};

describe("buildPreLaunchQuickAnswers", () => {
  it("answers launch timing, issuer and live status from registry fields", () => {
    const items = buildPreLaunchQuickAnswers(base);
    expect(items.map((item) => item.question)).toEqual([
      "When will QEUR launch?",
      "Who issues QEUR?",
      "Is QEUR live yet?",
    ]);
    expect(items[0].answer).toBe(
      "Pharos records QEUR in the announced phase. It was announced in Sep 2025. The current launch target is Q4 2026. Targets come from issuer statements; Pharos does not estimate launch dates.",
    );
    expect(items[1].answer).toBe("QEUR is a pre-launch euro stablecoin from Qivalis.");
    expect(items[2].answer).toContain("Pharos lists QEUR as pre-launch (the announced phase)");
    expect(items[2].answer).not.toMatch(/\bbuy\b|exchange/i);
  });

  it("never infers a date: a missing or retired target is the answer", () => {
    expect(buildPreLaunchQuickAnswers({ ...base, expectedLaunchDate: undefined })[0].answer).toContain(
      "No target date is set.",
    );
    const retired = buildPreLaunchQuickAnswers({
      ...base,
      expectedLaunchDate: undefined,
      dateHistory: [{ date: "2026-Q2", setOn: "2026-03-22" }],
    });
    expect(retired[0].answer).toContain("An earlier target was retired and no target date is set.");
    expect(retired[0].answer).not.toContain("Q2 2026");
    expect(
      buildPreLaunchQuickAnswers({ ...base, launchPhase: undefined, announcedDate: undefined })[0].answer,
    ).toMatch(/^Pharos has not recorded a launch phase for QEUR\. The current launch target/);
  });

  it("asks the chain question only when deployments are recorded, and the issuer one only with a oneLiner", () => {
    expect(buildPreLaunchQuickAnswers({ ...base, oneLiner: undefined }).map((item) => item.question)).not.toContain(
      "Who issues QEUR?",
    );
    const withChains = buildPreLaunchQuickAnswers({
      ...base,
      contracts: [
        { chain: "ethereum", address: "0x0000000000000000000000000000000000000001", decimals: 18 },
        { chain: "ethereum", address: "0x0000000000000000000000000000000000000002", decimals: 18 },
      ],
    });
    expect(withChains.at(-1)).toEqual({
      question: "Which chains will QEUR use?",
      answer: "The registry records QEUR deployments on Ethereum.",
    });
  });
});

describe("firstOneLinerClause", () => {
  it("keeps the opening clause as one sentence", () => {
    expect(firstOneLinerClause("HKDAP is Anchorpoint's HKMA-licensed HKD stablecoin, backed 1:1.")).toBe(
      "HKDAP is Anchorpoint's HKMA-licensed HKD stablecoin.",
    );
    expect(firstOneLinerClause("A short line.")).toBe("A short line.");
    expect(firstOneLinerClause(undefined)).toBeNull();
  });
});
