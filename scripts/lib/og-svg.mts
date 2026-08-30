import { pathToFileURL } from "node:url";

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildSvgBrowserDocument({
  svg,
  background,
  fonts = [],
  extraCss = "",
}: {
  svg: string;
  background: string;
  fonts?: readonly { family: string; file: string; weight: string | number; style?: string }[];
  extraCss?: string;
}): string {
  const fontFaces = fonts.map(({ family, file, weight, style = "normal" }) => `
  @font-face {
    font-family: '${family}';
    font-style: ${style};
    font-weight: ${weight};
    src: url('${pathToFileURL(file).href}') format('woff2');
    font-display: block;
  }`).join("");
  return `<!doctype html>
<html><head><meta charset="utf-8"/>
<style>${fontFaces}
  html, body { margin: 0; padding: 0; background: ${background}; }
  svg { display: block; }${extraCss}
</style>
</head>
<body>${svg}</body></html>`;
}
