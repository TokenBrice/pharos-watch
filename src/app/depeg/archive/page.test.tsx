// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import DepegArchivePage from "./page";

describe("DepegArchivePage", () => {
  it("does not claim a complete permanent record", () => {
    const html = renderToStaticMarkup(<DepegArchivePage />);
    expect(html).not.toContain("complete permanent record");
  });
});
