import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { buildSvgBrowserDocument } from "../lib/og-svg.mts";

describe("buildSvgBrowserDocument", () => {
  it("emits ordered local font faces with the supplied CSS and background", () => {
    const newsreader = "/tmp/Newsreader Variable.woff2";
    const newsreaderItalic = "/tmp/Newsreader Italic Variable.woff2";
    const geistMono = "/tmp/GeistMono-Regular.woff2";

    expect(buildSvgBrowserDocument({
      svg: "<svg/>",
      background: "#f8f8fa",
      fonts: [
        { family: "Newsreader", file: newsreader, weight: "200 800" },
        { family: "Newsreader", file: newsreaderItalic, weight: "200 800", style: "italic" },
        { family: "GeistMono", file: geistMono, weight: "400 700" },
      ],
      extraCss: "\n  body { color: red; }",
    })).toBe(`<!doctype html>
<html><head><meta charset="utf-8"/>
<style>
  @font-face {
    font-family: 'Newsreader';
    font-style: normal;
    font-weight: 200 800;
    src: url('${pathToFileURL(newsreader).href}') format('woff2');
    font-display: block;
  }
  @font-face {
    font-family: 'Newsreader';
    font-style: italic;
    font-weight: 200 800;
    src: url('${pathToFileURL(newsreaderItalic).href}') format('woff2');
    font-display: block;
  }
  @font-face {
    font-family: 'GeistMono';
    font-style: normal;
    font-weight: 400 700;
    src: url('${pathToFileURL(geistMono).href}') format('woff2');
    font-display: block;
  }
  html, body { margin: 0; padding: 0; background: #f8f8fa; }
  svg { display: block; }
  body { color: red; }
</style>
</head>
<body><svg/></body></html>`);
  });
});
