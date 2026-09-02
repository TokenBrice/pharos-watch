import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createPageLoadingRoute, PageLoadingRoute } from "@/app/page-loading-route";

function Content() {
  return <div>loading content</div>;
}

describe("createPageLoadingRoute", () => {
  it("preserves the manual wrapper markup and content order", () => {
    const props = { sectionWidth: "w-20", titleWidth: "w-80", eyebrowWidth: "w-10", includeEyebrow: false };
    const Loading = createPageLoadingRoute(Content, props);

    expect(renderToStaticMarkup(<Loading />)).toBe(
      renderToStaticMarkup(<PageLoadingRoute {...props}><Content /></PageLoadingRoute>),
    );
  });
});
