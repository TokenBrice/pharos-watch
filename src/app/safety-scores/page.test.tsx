import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import SafetyScoresPage from "./page";

vi.mock("./v9-client", () => ({
  ReportCardsV9Client: () => <div data-testid="safety-scores-client">safety scores client</div>,
}));

describe("SafetyScoresPage", () => {
  it("does not promise a publication time or an update notice the page never renders", () => {
    const html = renderToStaticMarkup(<SafetyScoresPage />);

    expect(html).toContain("Pharos evaluates safety grades every hour.");
    expect(html).toContain("the last verified ratings stay on this page until it is");
    expect(html).not.toContain("publication time");
    expect(html).not.toContain("an update notice");
    // The same answer ships in the FAQPage JSON-LD, so the copy and schema agree.
    expect(html).toContain('"@type":"FAQPage"');
  });
});
