import { describe, expect, it } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
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

  it("states no calendar target for EJPY's fiscal-year plan", () => {
    const ejpy = TRACKED_META_BY_ID.get("ejpy-jbfd")!;
    const answer = buildPreLaunchQuickAnswers(ejpy)[0].answer;
    expect(answer).toContain("No target date is set.");
    expect(answer).not.toContain("The current launch target is 2026");
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

describe("buildPreLaunchQuickAnswers for a launched row", () => {
  const launched = {
    ...base,
    launchPhase: "launched" as const,
    launchDate: "2026-10-15",
    listingStatusReview: { changedAt: "2026-10-20", reason: "No admitted price lane yet", reviewBy: "2026-12-19" },
    contracts: [{ chain: "ethereum", address: "0x0000000000000000000000000000000000000001", decimals: 18 }],
  };

  it("says live since the launch date, names the missing lane, and calls figures unavailable rather than zero", () => {
    const items = buildPreLaunchQuickAnswers(launched);
    expect(items.map((item) => item.question)).toEqual([
      "When did QEUR launch?",
      "Who issues QEUR?",
      "Is QEUR live yet?",
      "Which chains does QEUR use?",
    ]);
    expect(items[0].answer).toBe("QEUR launched publicly on-chain on Oct 15, 2026, per its sourced launch milestone.");
    expect(items[2].answer).toBe(
      "Yes, QEUR has been live since Oct 15, 2026. Pharos does not track it yet. No admitted price lane yet. Its price, supply, liquidity and Safety Score are unavailable on Pharos, not zero, until both a price and a supply source can be verified.",
    );
    const text = items.map((item) => item.answer).join(" ");
    expect(text).not.toMatch(/pre-launch \(|target|will use/i);
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
