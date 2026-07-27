import { renderToStaticMarkup } from "react-dom/server";
import type { ReportCardsV9TransitionResponse } from "@shared/types/report-cards-v9";
import { describe, expect, it } from "vitest";
import { SafetyScoreV9StatusNotice } from "../safety-score-v9-status-notice";

describe("SafetyScoreV9StatusNotice", () => {
  it("does not expose internal assessment details", () => {
    const response = {
      publicationHealth: {
        status: "held",
        heldSinceSec: 1_700_000_000,
        reasons: [
          {
            code: "assessment-failed",
            detail: '[{"code":"custom","path":["candidate","lifecycle"]}]',
          },
        ],
      },
    } as unknown as ReportCardsV9TransitionResponse;

    const markup = renderToStaticMarkup(
      <SafetyScoreV9StatusNotice response={response} />,
    );

    expect(markup).toContain(
      "The latest ratings update could not be verified.",
    );
    expect(markup).not.toContain("candidate");
    expect(markup).not.toContain("lifecycle");
  });
});
