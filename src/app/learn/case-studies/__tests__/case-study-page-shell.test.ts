import { describe, expect, it } from "vitest";
import { buildCaseStudyVisibleBreadcrumbs } from "../case-study-page-shell";

describe("buildCaseStudyVisibleBreadcrumbs", () => {
  it("keeps the case-study hub breadcrumb labels unique", () => {
    expect(buildCaseStudyVisibleBreadcrumbs().map((item) => item.label)).toEqual([
      "Dashboard",
      "Learn",
      "Case Studies",
    ]);
  });

  it("keeps detail pages under the linked case-study hub", () => {
    expect(buildCaseStudyVisibleBreadcrumbs("Study")).toEqual([
      { label: "Dashboard", href: "/" },
      { label: "Learn", href: "/learn/" },
      { label: "Case Studies", href: "/learn/case-studies/" },
      { label: "Study" },
    ]);
  });
});
