import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { StartHerePage } from "@/components/start-here-page";
import { START_HERE_SCORES } from "@/lib/start-here-content";
import { SAFETY_SCORE_V9_PUBLICATION_REFRESH_INTERVAL_SEC } from "@shared/lib/cron-jobs";

vi.mock("next/link", async () => {
  // This factory is hoisted; load the shared mock only after Vitest initializes it.
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

describe("StartHerePage", () => {
  it("renders Safety Score publication cadence from the producer interval with grade bands", () => {
    const score = START_HERE_SCORES.find(({ name }) => name === "Safety Score")!;
    const intervalMinutes = SAFETY_SCORE_V9_PUBLICATION_REFRESH_INTERVAL_SEC / 60;
    expect(score.cadence).toContain(`${intervalMinutes} minutes`);
    expect(score.cadence).not.toMatch(/continuous/i);
    expect(score.cadence).toContain("A+ (87+)");
    expect(score.cadence).toContain("F (0–39)");

    const html = renderToStaticMarkup(<StartHerePage />);
    expect(html).toContain(score.cadence);
  });
});
