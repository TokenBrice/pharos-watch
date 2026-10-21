import { describe, expect, it } from "vitest";
import { applySafetyScoreV9GradeHysteresis } from "@shared/lib/safety-score-v9/grade-hysteresis";
import { SafetyScoreV9ResolvedCurrentCardSchema } from "@shared/types/safety-score-v9-public";
import { makeReportCardsV9Card, makeReportCardsV9PipelineGapCard } from "@shared/test-utils/report-cards-v9";

const ACCEPTED = "report-cards:v9:v1:accepted";

function baseline(cards: { id: string; grade: "A" | "B" | "C" | "C-" | "D" | "NR" | null; score: number | null }[]) {
  return { publicationGenerationId: ACCEPTED, cards };
}

function publish(card: ReturnType<typeof makeReportCardsV9Card>, accepted: ReturnType<typeof baseline>) {
  return applySafetyScoreV9GradeHysteresis({ cards: [card] }, accepted).cards[0]!;
}

describe("Safety Score grade hysteresis (10.26)", () => {
  it("retains the published grade for the first publication of a new band, keeping the raw score", () => {
    // 50 is C-; the previous publication computed 55 (C) and published C.
    const card = publish(makeReportCardsV9Card({ id: "xaut-tether", score: 50 }), baseline([{ id: "xaut-tether", grade: "C", score: 55 }]));
    expect(card).toMatchObject({ score: 50, grade: "C", gradeHold: { rawGrade: "C-", heldFromGenerationId: ACCEPTED } });
    expect(SafetyScoreV9ResolvedCurrentCardSchema.safeParse(card).success).toBe(true);
  });

  it("a retained D/F needs no causal D proof while the raw band is higher", () => {
    const card = publish(makeReportCardsV9Card({ id: "wm-m0", score: 55 }), baseline([{ id: "wm-m0", grade: "D", score: 46 }]));
    expect(card).toMatchObject({ score: 55, grade: "D", gradeHold: { rawGrade: "C" } });
    expect(SafetyScoreV9ResolvedCurrentCardSchema.safeParse(card).success).toBe(true);
  });

  it("publishes the change once two consecutive publications compute the same band", () => {
    // The previous publication held C- while its raw score (46) already read D.
    const card = publish(makeReportCardsV9Card({ id: "wm-m0", score: 45 }), baseline([{ id: "wm-m0", grade: "C-", score: 46 }]));
    expect(card.grade).toBe("D");
    expect(card.gradeHold).toBeUndefined();
  });

  it("a one-publication excursion never publishes, in either direction", () => {
    const accepted = baseline([{ id: "iusd-infinifi", grade: "C", score: 55 }]);
    const down = publish(makeReportCardsV9Card({ id: "iusd-infinifi", score: 49 }), accepted);
    expect(down.grade).toBe("C");
    const back = publish(makeReportCardsV9Card({ id: "iusd-infinifi", score: 55 }),
      baseline([{ id: "iusd-infinifi", grade: down.grade, score: down.score }]));
    expect(back.grade).toBe("C");
    expect(back.gradeHold).toBeUndefined();
  });

  it("never holds rating-status transitions or cards without an accepted rated baseline", () => {
    const gap = makeReportCardsV9PipelineGapCard();
    expect(publish(gap, baseline([{ id: gap.id, grade: "C", score: 55 }]))).toBe(gap);
    const fresh = makeReportCardsV9Card({ id: "new-asset", score: 46 });
    expect(publish(fresh, baseline([]))).toBe(fresh);
    const fromNr = makeReportCardsV9Card({ id: "x", score: 46 });
    expect(publish(fromNr, baseline([{ id: "x", grade: "NR", score: null }]))).toBe(fromNr);
    expect(applySafetyScoreV9GradeHysteresis({ cards: [fresh] }, null).cards[0]).toBe(fresh);
  });

  it("rejects holds that do not name the raw band or that retain the raw grade", () => {
    const card = makeReportCardsV9Card({ id: "xaut-tether", score: 50 });
    expect(SafetyScoreV9ResolvedCurrentCardSchema.safeParse(card).success).toBe(true);
    expect(SafetyScoreV9ResolvedCurrentCardSchema.safeParse({ ...card, grade: "C" }).success).toBe(false);
    expect(SafetyScoreV9ResolvedCurrentCardSchema.safeParse({
      ...card, grade: "C", gradeHold: { rawGrade: "C", heldFromGenerationId: ACCEPTED },
    }).success).toBe(false);
    expect(SafetyScoreV9ResolvedCurrentCardSchema.safeParse({
      ...card, gradeHold: { rawGrade: "C-", heldFromGenerationId: ACCEPTED },
    }).success).toBe(false);
  });
});
