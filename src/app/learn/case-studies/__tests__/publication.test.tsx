import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CASE_STUDY_LIST } from "@/lib/case-studies";
import { formatUtcDayLabel } from "@shared/lib/format";
import { CaseStudyBody } from "../case-study-body";

describe("case-study publication metadata", () => {
  it("shows the organization and authored publication date without claiming a reviewer", () => {
    const study = CASE_STUDY_LIST.find((entry) => !entry.dataWidgets?.length)!;
    const html = renderToStaticMarkup(<CaseStudyBody study={study} />);
    expect(html).toMatch(/By <a[^>]+href="\/about\/?#editorial-ai-policy"[^>]*>Pharos<\/a> · Published/);
    expect(html).toContain(`<time dateTime="${study.datePublished}">${formatUtcDayLabel(new Date(study.datePublished))}</time>`);
    expect(html).toContain("min read");
    expect(html).not.toContain("Reviewed by");
  });
});
