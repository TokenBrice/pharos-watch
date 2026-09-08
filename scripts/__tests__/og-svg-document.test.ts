import { JSDOM } from "jsdom";
import { parse } from "postcss";
import { describe, expect, it } from "vitest";
import { buildSvgBrowserDocument } from "../lib/og-svg.mts";

describe("buildSvgBrowserDocument", () => {
  it("emits ordered local font faces with the supplied CSS and background", () => {
    const dom = new JSDOM(buildSvgBrowserDocument({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Pharos</text></svg>',
      background: "#f8f8fa",
      fonts: [
        { family: "Newsreader", file: "/tmp/Newsreader Variable.woff2", weight: "200 800" },
        { family: "Newsreader", file: "/tmp/Newsreader Italic Variable.woff2", weight: "200 800", style: "italic" },
        { family: "GeistMono", file: "/tmp/GeistMono-Regular.woff2", weight: "400 700" },
      ],
      extraCss: "\n body { color: red; }",
    }));
    try {
      const { document } = dom.window;
      const faces: string[][] = [];
      parse(document.querySelector("style")!.textContent!).walkAtRules("font-face", (rule) => {
        const declarations = new Map<string, string>();
        rule.walkDecls((declaration) => {
          declarations.set(declaration.prop, declaration.value.replaceAll('"', "'"));
        });
        faces.push(["font-family", "font-style", "font-weight", "src", "font-display"]
          .map((property) => declarations.get(property) ?? ""));
      });
      expect(faces).toEqual([
        ["'Newsreader'", "normal", "200 800", "url('file:///tmp/Newsreader%20Variable.woff2') format('woff2')", "block"],
        ["'Newsreader'", "italic", "200 800", "url('file:///tmp/Newsreader%20Italic%20Variable.woff2') format('woff2')", "block"],
        ["'GeistMono'", "normal", "400 700", "url('file:///tmp/GeistMono-Regular.woff2') format('woff2')", "block"],
      ]);
      expect(dom.window.getComputedStyle(document.body).backgroundColor).toBe("rgb(248, 248, 250)");
      expect(dom.window.getComputedStyle(document.body).color).toBe("rgb(255, 0, 0)");
      expect(document.body.querySelector("svg > text")?.textContent).toBe("Pharos");
    } finally {
      dom.window.close();
    }
  });
});
