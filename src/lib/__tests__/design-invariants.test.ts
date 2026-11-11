import { describe, expect, it } from "vitest";
import { CONFIDENCE_LEVEL_COLORS } from "@shared/lib/classification/risk";
import { readFileSync, readdirSync } from "node:fs";
import { sep } from "node:path";
import { contrast, tokenColors, inspectComponentStyles as inspect, inspectComponentTree, isComponentSourceFile as isSource } from "./design-invariants.test-support";

// Georgia avoids error font preloads.
const SERIF_ALLOWED = new Set([
  "ai-summary/ai-summary", "ai-summary/ai-summary-prose", "cemetery/cemetery-register-autopsy", "cemetery/cemetery-hero",
  "cemetery/plot-map-record-card", "page-error-editorial", "digest/daily-digest", "home-alt-mini-cards/daily-digest-card",
].map((name) => `src/components/${name}.tsx`));
const read = (path: string) => readFileSync(path, "utf8");
const CSS = read("src/app/globals.css");
const TOKENS = [read("src/styles/tokens/primitives.css"), read("src/styles/tokens/semantic.css"), CSS];

const paths = readdirSync("src", { recursive: true }).map((p) => `src/${p}`.split(sep).join("/")).filter(isSource);
const sources = inspectComponentTree(paths.map((path) => ({ path, source: read(path) })));
const offenders = (kind: string) => [...sources].filter(([p, v]) => v.some((item) => item === kind) &&
  (kind === "interactive-row" || /^src\/(components\/|app\/chains\/(client|\[chain\]\/stablecoin-table)\.tsx$)/.test(p))).map(([p]) => p);

describe("design invariants", () => {
  it.each(["max-breakpoint", "interactive-row"])("guards %s", (kind) => {
    expect(offenders(kind)).toEqual([]);
  });

  it("serif stays editorial", () => {
    expect(offenders("serif").filter((p) => !SERIF_ALLOWED.has(p) &&
      !p.includes("/digest-") && !p.includes("/digest/"))).toEqual([]);
  });

  it("keeps scoped focus rings opaque", () => {
    const rings = [/\.pharos-focus-ring \{([^}]+)\}/, /\.pharos-source-list a \{([^}]+)\}/,
      /\.pharos-prose-link \{([^}]+)\}/].map((selector) => {
      const rule = CSS.match(selector);
      expect(rule, selector.source).not.toBeNull();
      return rule!;
    });
    const controls = [...read("src/components/digest/digest-archive-client.tsx").matchAll(/className="([^"]*focus-visible:ring-2[^"]*)"/g)];
    expect(controls.length).toBeGreaterThan(0);
    rings.push(...controls);
    for (const [, classes] of rings) {
      expect(classes.match(/focus-visible:ring-ring\S*/g)?.every((ring) => /^focus-visible:ring-ring(?:\/100)?$/.test(ring))).toBe(true);
    }
  });

  it.each([false, true])("token contrast (dark=%s)", (dark) => {
    const color = tokenColors(TOKENS, dark), ring = color("--ring"), surfaces = ["--background", "--card"];
    for (const surface of [...surfaces, "--surface-raised"]) {
      const bg = color(surface);
      expect(contrast(ring, bg)).toBeGreaterThanOrEqual(3);
      expect(contrast(ring, bg, .6)).toBeLessThan(3);
    }
    for (const band of ["high", "single-source"] as const) {
      const classes = /^text-([\w-]+) dark:text-([\w-]+)$/.exec(CONFIDENCE_LEVEL_COLORS[band]);
      const fg = color(`--color-${classes?.[dark ? 2 : 1]}`);
      for (const surface of surfaces) expect(contrast(fg, color(surface))).toBeGreaterThanOrEqual(4.5);
      if (!dark) expect(contrast(color(`--color-${band === "high" ? "emerald" : "amber"}-600`), color("--card"))).toBeLessThan(4.5);
    }
  });

  it("color parser", () => {
    const color = tokenColors([":root { --cycle: var(--cycle); }"], false);
    for (const [lch, ratio] of [["0 0 0", 21], ["0.627955 0.257683 29.233885", 4], ["1 0 0", 1]] as const) {
      expect(contrast(color(`oklch(${lch})`), [1, 1, 1])).toBeCloseTo(ratio, 2);
    }
    for (const value of ["--missing", "rgb(0 0 0)", "--cycle"]) {
      expect(() => color(value)).toThrow();
    }
  });

  it.each(["tr", "TableRow", "InteractiveTableRow"])("native %s roles", (tag) => {
    for (const attr of ['role="link"', 'role={"button"}', "role={role}", "tabIndex={0}", "onKeyDown={open}"]) {
      for (const path of ["src/components/liquidity/liquidity-table.tsx", "src/app/other/page.tsx", "src/components/stablecoin-directory/stablecoin-table-row.tsx"]) {
        expect(inspect(path, `<${tag} ${attr} />`)).toEqual(["interactive-row"]);
      }
    }
    expect(inspect("src/components/liquidity/liquidity-table.tsx", `<${tag} role={"row"} /><a role="link" />`)).toEqual([]);
    expect(inspect("src/components/stablecoin-directory/stablecoin-table-row.tsx", `<${tag} tabIndex={isCursor ? 0 : undefined} />`))
      .toEqual(tag === "TableRow" ? [] : ["interactive-row"]);
  });

  it("inspects spread row props and structurally bounds the roving exception", () => {
    for (const props of ['role: "link"', "tabIndex: 0", "onKeyDown: open"]) {
      for (const spread of [`{${props}}`, "props"]) {
        expect(inspect("src/app/x.tsx", `const props={${props}}; <TableRow {...${spread}} />`)).toEqual(["interactive-row"]);
      }
    }
    const path = "src/components/stablecoin-directory/stablecoin-table-row.tsx";
    expect(inspect(path, '<TableRow tabIndex={ (isCursor) ? (0) : (undefined) } />')).toEqual([]);
    expect(inspect(path, '<TableRow tabIndex={isCursor ? undefined : 0} />')).toEqual(["interactive-row"]);
    expect(inspect(path, 'const p={onKeyDown: open}; const props={...p}; <TableRow {...props} />')).toEqual(["interactive-row"]);
    expect(inspect(path, 'const props={role: "row", title: "Safe"}; <TableRow {...props} />')).toEqual([]);
  });

  it.each([
    ["JSX breakpoint class", '<div className="max-lg:hidden" />', "max-breakpoint"],
    ["JSX serif class", '<div className="font-serif" />', "serif"],
    ["conditional class", '<div className={ready ? "font-serif" : "font-sans"} />', "serif"],
    ["template class", '<div className={`max-md:hidden ${extra}`} />', "max-breakpoint"],
    ["referenced class", 'const a="font-serif"; const b=a; <div className={b}/>', "serif"],
    ["class construction", 'cn("max-sm:hidden");', "max-breakpoint"],
    ["aliased class construction", 'import { clsx as classes } from "clsx"; classes("font-serif");', "serif"],
    ["variant construction", 'cva("base", {variants:{tone:{editorial:"font-serif"}}});', "serif"],
    ["class prop", 'const p={tableClassName:"max-xl:hidden"};', "max-breakpoint"],
    ["font import", 'import { Newsreader as Serif } from "next/font/google";', "serif"],
    ["editorial font import", 'import { digestDisplay as serif } from "@/lib/fonts/digest";', "serif"],
    ["local font", 'import font from "next/font/local"; font({ src: "./Newsreader.woff2" });', "serif"],
    ["comments", '// font-serif Newsreader max-lg:\n<div className="font-sans">{/* font-serif max-sm: */}Safe</div>', ""],
    ["display text", 'const t="font-serif Newsreader max-lg:"; <p>{t}</p>', ""],
    ["type-only import", 'import type { Newsreader } from "next/font/google";', ""],
    ["type-only specifier", 'import { type Newsreader } from "next/font/google";', ""],
  ])("styling: %s", (_name, source, expected) => {
    expect(inspect("src/components/x.tsx", source)).toEqual(expected ? [expected] : []);
  });

  it.each([
    "__tests__/x.tsx", "x.test.tsx", "x.spec.tsx", "x.test-support.ts", "__fixtures__/x.tsx",
  ].map((p) => `src/components/${p}`))("excludes %s", (path) => {
    expect(isSource(path)).toBe(false);
    expect(inspect(path, '<div className="font-serif max-lg:hidden" />')).toEqual([]);
  });
});
