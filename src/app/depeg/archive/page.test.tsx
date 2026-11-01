// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import DepegArchivePage from "./page";

describe("DepegArchivePage", () => {
  it("names the archive epoch instead of claiming a complete record", () => {
    const html = renderToStaticMarkup(<DepegArchivePage />);
    expect(html).toContain("since 2026-01-01, plus pinned earlier incidents");
    expect(html).not.toContain("complete permanent record");
  });
});
